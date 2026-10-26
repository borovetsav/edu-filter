// Runs on all of youtube.com because YouTube is a single-page app: going from
// the home page to /watch does not reload the page, so a script limited to
// /watch would never start.
//
// - Places quiz breaks every ~N minutes of the timeline (moved to chapter
//   starts when possible).
// - In 'auto' check mode, asks the background to classify the video (useful
//   or not) once the playhead gets within VERDICT_LEAD_SEC of the first break
//   (or of the end-of-video card, if there is no break), so the verdict is
//   ready when the first card is due. Videos dropped earlier are never sent
//   to Gemini. In 'request' mode nothing is sent until a quiz is asked for.
// - When the playhead moves forward past a break, by playback or by seeking,
//   a card in the top right corner offers a quiz on the stretch since the
//   previous break; the video keeps playing. The verdict only changes the
//   card's wording; "Not for this video" on the card (or the popup) turns
//   the cards off for that video.
// - Near the end of a video too short for a break, offers a summary and quiz
//   for the whole video.
(() => {
  const MAX_TICK_SEC = 1.5; // ignore jumps (laptop sleep, throttled tab, etc.)
  const REMINDER_BEFORE_END_SEC = 15;
  const STATE_REFRESH_MS = 5000;
  const CARD_ID = 'edu-filter-card';

  // Set in the popup. Keep in sync with DEFAULT_SETTINGS in defaults.js.
  const DEFAULT_SETTINGS = { quiz_interval_min: 40, check_mode: 'request' };
  const MIN_INTERVAL_MIN = 5;
  // A break moves to a chapter start at most this share of the interval away,
  // so a quiz does not cut a topic in half (40 min interval: within 10 min).
  const SNAP_SHARE = 0.25;
  // The verdict takes Gemini about a minute; asking this far ahead of the
  // first card has it ready in time.
  const VERDICT_LEAD_SEC = 120;
  // Real playback needed before a video is sent at all, so that opening a
  // video and jumping past its first break does not send it right away.
  const MIN_WATCH_SEC = 60;
  // Shortest video that gets the end-of-video card without a verdict.
  const MIN_REMINDER_SEC = 10 * 60;
  // Without chapters, wait this long after navigation before settling on
  // equal parts: the chapter list may not have rendered yet.
  const CHAPTERS_GRACE_MS = 30_000;

  let videoId = null;
  let watchedSec = 0;
  let lastTick = null; // performance.now() of the last counted playback moment
  let videoState = null; // cached GET_VIDEO_STATUS answer for videoId
  let stateLoaded = false; // videoState has been fetched at least once for videoId
  let lastStateFetch = 0;
  let settings = { ...DEFAULT_SETTINGS };
  let parts; // undefined: not computed yet, null: no quiz breaks in this video
  let lastPos = null; // last known main-video playhead position (not during ads)
  let resetAt = 0; // performance.now() of the last navigation

  const triggered = new Set(); // videoIds already sent to the background
  const reminded = new Set(); // videoIds that got the end-of-video card
  const shownParts = new Set(); // partKey()s whose break already fired
  const caughtUp = new Set(); // videoIds checked for breaks passed before the verdict

  // After the extension is reloaded or updated, this copy of the script keeps
  // running in tabs that were already open, but chrome.runtime is gone and
  // every call to it throws. The orphaned copy unhooks itself instead; the
  // tab gets a fresh copy when it is reloaded.
  const isConnected = () => !!chrome.runtime?.id;

  function send(message) {
    if (isConnected()) {
      try {
        return chrome.runtime.sendMessage(message);
      } catch {
        // context invalidated between the check and the call
      }
    }
    disconnect();
    return Promise.resolve(null);
  }

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function isMainVideo(el) {
    return el instanceof HTMLVideoElement && !!el.closest('#movie_player');
  }

  function isAdPlaying() {
    return !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
  }

  function reset() {
    videoId = currentVideoId();
    watchedSec = 0;
    lastTick = null;
    videoState = null;
    stateLoaded = false;
    lastStateFetch = 0;
    parts = undefined;
    lastPos = null;
    resetAt = performance.now();
  }

  function formatTime(sec) {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // ---------- Settings ----------

  function applySettings(stored) {
    const interval = Number(stored.quiz_interval_min);
    settings = {
      quiz_interval_min: interval >= MIN_INTERVAL_MIN ? interval : DEFAULT_SETTINGS.quiz_interval_min,
      check_mode: stored.check_mode === 'auto' ? 'auto' : 'request',
    };
    parts = undefined; // recompute the breaks with the new settings
  }

  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)).then(applySettings, () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(DEFAULT_SETTINGS).some((k) => k in changes)) return;
    chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)).then(applySettings, () => {});
  });

  // ---------- Watch time ----------

  function accumulate() {
    const now = performance.now();
    if (lastTick !== null) {
      const delta = (now - lastTick) / 1000;
      if (delta > 0 && delta <= MAX_TICK_SEC) watchedSec += delta;
    }
    lastTick = now;
  }

  function videoTitle() {
    const h1 = document.querySelector('ytd-watch-metadata h1, #above-the-fold #title h1, h1.title');
    return (h1?.textContent || document.title).replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  // Timeline position at which the video is sent for a verdict: shortly
  // before the first card is due. Null while the breaks are not known yet.
  function verdictPosition(video) {
    const firstParts = getParts(video);
    if (firstParts) return firstParts[0].end - VERDICT_LEAD_SEC;
    if (parts === null) return video.duration - REMINDER_BEFORE_END_SEC - VERDICT_LEAD_SEC;
    return null;
  }

  function maybeTrigger(video) {
    if (settings.check_mode !== 'auto' || !stateLoaded || videoState?.quiz === 'off') return;
    if (!videoId || triggered.has(videoId) || isAdPlaying() || watchedSec < MIN_WATCH_SEC) return;
    const at = verdictPosition(video);
    if (at == null || video.currentTime < at) return;
    triggered.add(videoId);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[EduFilter] at ${formatTime(video.currentTime)}, sending for a verdict`, url);
    send({ type: 'VIDEO_WATCHED', url, videoId, title: videoTitle() }).catch((err) => {
      console.warn('[EduFilter] failed to send the message:', err);
      triggered.delete(videoId); // retry on the next timeupdate
    });
  }

  // Keeps videoState (verdict, chat status) fresh without messaging the
  // background on every timeupdate.
  async function refreshState() {
    const id = videoId;
    const now = performance.now();
    // FUN is polled too: the video may be sent to Gemini again from the popup.
    if (!id || now - lastStateFetch < STATE_REFRESH_MS) return;
    lastStateFetch = now;
    const state = await send({ type: 'GET_VIDEO_STATUS', videoId: id }).catch(() => null);
    if (id === videoId) {
      videoState = state;
      stateLoaded = true;
    }
  }

  // Whether break cards are shown. The user's choice for this video (card or
  // popup) wins; otherwise 'request' mode offers them in every video, and
  // 'auto' mode once Gemini has answered, whatever the verdict.
  function quizzesOn() {
    if (!stateLoaded || videoState?.quiz === 'off') return false;
    if (videoState?.quiz === 'on' || settings.check_mode !== 'auto') return true;
    return !!videoState && videoState.status !== 'PENDING';
  }

  // ---------- Splitting long videos ----------

  function parseTime(text) {
    const nums = text.trim().split(':').map(Number);
    if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) return null;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
  }

  // Chapters as [{ start, title }], sorted. Prefers the chapter list YouTube
  // renders into its engagement panels (present in the DOM even when the
  // panel is closed); falls back to "1:23:45 Title" lines in the description.
  function readChapters(duration) {
    const byStart = new Map();
    for (const item of document.querySelectorAll('ytd-macro-markers-list-item-renderer')) {
      const start = parseTime(item.querySelector('#time')?.textContent || '');
      // The title tag has been seen as both h3 and h4.
      const title = item.querySelector('.macro-markers, h3, h4')?.textContent.trim();
      if (start != null && title && !byStart.has(start)) byStart.set(start, title);
    }

    if (byStart.size < 2) {
      // The rendered description may put the timestamp and the title on
      // separate lines; then the title is the next non-empty line.
      const description = document.querySelector('ytd-watch-metadata ytd-text-inline-expander')?.textContent || '';
      const lines = description.split('\n').map((line) => line.trim()).filter(Boolean);
      lines.forEach((line, i) => {
        const match = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—|]?\s*(.*)$/);
        const start = match && parseTime(match[1]);
        const title = match?.[2] || lines[i + 1];
        if (start != null && title && parseTime(title) == null && !byStart.has(start)) byStart.set(start, title);
      });
    }

    // Entries past the end belong to a stale page (SPA navigation).
    return [...byStart]
      .map(([start, title]) => ({ start, title }))
      .filter((c) => c.start < duration)
      .sort((a, b) => a.start - b.start);
  }

  // Places breaks along the timeline: each about intervalSec after the
  // previous one, moved to the nearest chapter start within snapSec of that
  // target. No break goes where less than half an interval would remain.
  // Returns the parts between breaks (the last one ends where the
  // end-of-video card would appear), or null if the video is too short.
  function buildParts(duration, chapters, intervalSec, snapSec) {
    const videoEnd = duration - REMINDER_BEFORE_END_SEC;
    const latest = videoEnd - intervalSec / 2;
    const breaks = [];
    for (let prev = 0; ; prev = breaks.at(-1)) {
      const target = prev + intervalSec;
      if (target > latest) break;
      let best = target;
      let bestDistance = snapSec;
      for (const c of chapters) {
        const distance = Math.abs(c.start - target);
        if (c.start > prev + intervalSec / 2 && c.start <= latest && distance <= bestDistance) {
          best = c.start;
          bestDistance = distance;
        }
      }
      breaks.push(best);
    }
    if (!breaks.length) return null;

    const bounds = [0, ...breaks, videoEnd];
    return bounds.slice(0, -1).map((start, index) => {
      const end = bounds[index + 1];
      return {
        index,
        total: bounds.length - 1,
        start,
        end,
        chapters: chapters.filter((c) => c.start >= start && c.start < end).map((c) => c.title),
      };
    });
  }

  // Computed once per video (and again when the settings change), before the
  // verdict: the first break decides when the video is sent to Gemini (in
  // 'auto' mode). Cards are shown while quizzesOn(). The page must already
  // show this video (SPA navigation swaps the DOM late), and no ad may be
  // playing (an ad's duration is not the video's).
  function getParts(video) {
    if (parts !== undefined) return parts;
    if (isAdPlaying() || !Number.isFinite(video.duration)) return null;
    if (document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== videoId) return null;

    const chapters = readChapters(video.duration);
    const result = buildParts(
      video.duration,
      chapters,
      settings.quiz_interval_min * 60,
      settings.quiz_interval_min * 60 * SNAP_SHARE
    );
    if (result && !chapters.length && performance.now() - resetAt < CHAPTERS_GRACE_MS) return result;

    parts = result;
    if (parts) {
      console.log(
        `[EduFilter] quiz breaks every ~${settings.quiz_interval_min} min (${chapters.length} chapters):`,
        parts.map((p) => `${formatTime(p.start)}-${formatTime(p.end)}`).join(', ')
      );
    }
    return parts;
  }

  // Keyed by position, not index, so a recompute after a settings change
  // does not re-fire breaks that already fired.
  const partKey = (part) => `${videoId}:${Math.round(part.end)}`;

  // Called whenever the playhead moves, by playback or by a seek. Moving
  // forward past a break fires it, even by skipping ahead; moving backward
  // never does, and each break fires once. A seek across several breaks
  // shows one card covering everything from the first skipped break's part.
  // The position the page opens at (e.g. YouTube resuming) is not a move;
  // checkMissedParts() covers it.
  function checkPartBoundary(video, prev, pos) {
    if (prev == null || pos <= prev || !quizzesOn()) return;

    offerParts((getParts(video) ?? []).filter((part) => prev < part.end && pos >= part.end));
  }

  // Breaks passed before the cards were on never fired: the verdict arrives
  // minutes after the video was sent to Gemini, the user may turn the cards
  // on later, and the page may open (or resume) past them. Once the breaks
  // are known, those passed and not yet requested (videoState.quizzes) are
  // offered in one card.
  function checkMissedParts(video, pos) {
    if (!videoId || caughtUp.has(videoId) || !quizzesOn()) return;
    getParts(video);
    if (parts === undefined) return; // not final yet (e.g. chapters still loading)
    caughtUp.add(videoId);
    const requested = videoState?.quizzes ?? {};
    offerParts((parts ?? []).filter((part) => pos >= part.end && requested[part.index] == null));
  }

  // One card for one or more parts; several are merged into one stretch.
  function offerParts(candidates) {
    const crossed = candidates.filter((part) => !shownParts.has(partKey(part)));
    if (!crossed.length) return;
    crossed.forEach((part) => shownParts.add(partKey(part)));

    const last = crossed.at(-1);
    // The video keeps playing: the card waits in the corner until the user
    // takes the quiz or closes it.
    showPartCard({
      ...last,
      start: crossed[0].start,
      chapters: crossed.flatMap((part) => part.chapters),
      covers: crossed.map((part) => part.index),
    });
  }

  // ---------- Cards ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  const CARD_STYLE = `
    .card {
      position: fixed; right: 16px; top: 68px; z-index: 2147483647;
      width: 344px; padding: 18px 18px 16px; box-sizing: border-box; overflow: hidden;
      background: #fff; color: #1f2330; border-radius: 16px;
      box-shadow: 0 12px 32px rgba(20,24,40,.28), 0 0 0 1px rgba(20,24,40,.06);
      font: 14px/1.45 Roboto, Arial, sans-serif;
      animation: in .25s ease-out;
    }
    .card::before {
      content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px;
      background: linear-gradient(90deg, #5b4ff5, #8a3ffc 60%, #c03fd8);
    }
    @keyframes in { from { opacity: 0; transform: translateY(-12px); } }
    .brand {
      display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
      font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #6b5cf6;
    }
    .logo {
      width: 16px; height: 16px; border-radius: 5px; position: relative;
      background: linear-gradient(135deg, #5b4ff5, #8a3ffc 60%, #c03fd8);
    }
    .logo::after {
      content: ''; position: absolute; left: 6px; top: 4px;
      border-left: 6px solid #fff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
    }
    .title { font-weight: 700; font-size: 16px; margin: 0 24px 6px 0; }
    .text { margin: 0 0 10px; color: #4a5060; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .action {
      border: 0; border-radius: 999px; padding: 8px 16px; cursor: pointer;
      background: #eef0f4; color: #1f2330; font: inherit; font-weight: 600;
    }
    .action:hover { background: #e2e5ec; }
    .action.primary {
      background: linear-gradient(135deg, #5b4ff5, #8a3ffc); color: #fff;
      box-shadow: 0 2px 8px rgba(91,79,245,.35);
    }
    .action.primary:hover { filter: brightness(1.08); }
    .close {
      position: absolute; top: 12px; right: 12px; width: 26px; height: 26px; border: 0; border-radius: 50%;
      background: none; font-size: 18px; line-height: 1; color: #8a8f9c; cursor: pointer;
    }
    .close:hover { background: #eef0f4; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2128; color: #eceef3; box-shadow: 0 12px 32px rgba(0,0,0,.5), 0 0 0 1px #2d3039; }
      .brand { color: #a39bff; }
      .text { color: #b3b8c4; }
      .action { background: #2a2d35; color: #eceef3; }
      .action:hover, .close:hover { background: #343844; }
    }
  `;

  // The card lives in a Shadow DOM so YouTube styles do not leak in, and is
  // built with createElement because YouTube enforces Trusted Types (no
  // innerHTML).
  function showCard({ title, lines, actions }) {
    document.getElementById(CARD_ID)?.remove();

    const host = el('div');
    host.id = CARD_ID;
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, CARD_STYLE));

    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => host.remove());

    const buttons = el('div', 'actions');
    for (const action of actions) {
      const button = el('button', `action${action.primary ? ' primary' : ''}`, action.label);
      button.addEventListener('click', () => {
        host.remove();
        action.onClick();
      });
      buttons.append(button);
    }

    const brand = el('div', 'brand');
    brand.append(el('span', 'logo'), 'Edu Filter');
    card.append(close, brand, el('div', 'title', title), ...lines.map((line) => el('p', 'text', line)), buttons);
    root.appendChild(card);

    // In fullscreen only the fullscreen element is visible, so the card goes there.
    (document.fullscreenElement || document.body).appendChild(host);
  }

  document.addEventListener('fullscreenchange', () => {
    const host = document.getElementById(CARD_ID);
    if (host) (document.fullscreenElement || document.body).appendChild(host);
  });

  // Tells the background (and this page's cached state) that the user chose
  // to turn the cards on or off for this video.
  function setQuiz(id, quiz) {
    if (id === videoId) videoState = { ...videoState, quiz };
    return send({ type: 'SET_VIDEO_QUIZ', videoId: id, quiz, title: videoTitle() });
  }

  function showPartCard(part) {
    const id = videoId;
    const title = videoTitle();
    const isLast = part.index === part.total - 1;
    const topics = part.chapters.slice(0, 3).join('; ');
    showCard({
      title:
        videoState?.verdict === 'FUN' && videoState.quiz !== 'on'
          ? 'Looks like entertainment. Quiz anyway?'
          : part.total === 1
            ? 'Almost done: review the video'
            : isLast
              ? 'Almost done: review this part'
              : 'Review what you just watched',
      lines: [
        `Get a summary and a quiz for ${formatTime(part.start)} – ${formatTime(part.end)} of the video to lock in the material. The video keeps playing.`,
        ...(topics ? [`Topics: ${topics}${part.chapters.length > 3 ? '; ...' : ''}`] : []),
      ],
      actions: [
        {
          label: 'Summary and quiz',
          primary: true,
          onClick: () => send({ type: 'REQUEST_PART_QUIZ', videoId: id, title, part }).catch(() => {}),
        },
        { label: 'Later', onClick: () => {} },
        { label: 'Not for this video', onClick: () => setQuiz(id, 'off').catch(() => {}) },
      ],
    });
  }

  // Near the end of a video too short for a quiz break: the whole video is
  // one stretch. Without a verdict or the user's say-so, only videos of at
  // least MIN_REMINDER_SEC get it, so music and clips are left alone.
  function maybeShowReminder(video) {
    const id = videoId;
    if (!id || reminded.has(id) || !quizzesOn() || isAdPlaying()) return;
    // Until the split is known (parts === undefined), don't assume there is none.
    if (getParts(video) || parts === undefined) return;
    if (!videoState?.verdict && videoState?.quiz !== 'on' && video.duration < MIN_REMINDER_SEC) return;
    const left = video.duration - video.currentTime;
    if (!Number.isFinite(left) || left > REMINDER_BEFORE_END_SEC) return;

    reminded.add(id);
    const end = video.duration;
    showPartCard({
      index: 0,
      total: 1,
      start: 0,
      end,
      chapters: readChapters(end).map((c) => c.title),
    });
  }

  // ---------- Player events ----------

  function onMediaEvent(e) {
    if (!isMainVideo(e.target)) return;
    if (!isConnected()) {
      disconnect();
      return;
    }

    // In case yt-navigate-finish was missed and the video already changed.
    if (currentVideoId() !== videoId) reset();
    if (!videoId) return;

    const video = e.target;
    switch (e.type) {
      case 'play':
      case 'playing':
        lastTick = performance.now();
        break;
      case 'pause':
      case 'ended':
      case 'waiting':
      case 'seeking':
        // Count the stretch up to the stop (if one was running) and stop counting.
        if (lastTick !== null && !isAdPlaying()) accumulate();
        lastTick = null;
        // currentTime already holds the seek target here.
        if (e.type === 'seeking' && !isAdPlaying()) {
          checkPartBoundary(video, lastPos, video.currentTime);
          lastPos = video.currentTime;
        }
        maybeTrigger(video);
        if (e.type === 'ended' && !isAdPlaying()) maybeShowReminder(video);
        break;
      case 'timeupdate':
        // lastPos is kept across pauses and ads, so a break crossed right
        // after resuming (or after a mid-roll) is still detected.
        if (video.paused || video.ended || isAdPlaying()) {
          lastTick = null;
          return;
        }
        accumulate();
        maybeTrigger(video);
        refreshState();
        checkPartBoundary(video, lastPos, video.currentTime);
        checkMissedParts(video, video.currentTime);
        lastPos = video.currentTime;
        maybeShowReminder(video);
        break;
    }
  }

  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'waiting', 'seeking', 'timeupdate'];
  const onNavigate = () => {
    if (currentVideoId() !== videoId) reset();
  };

  // The popup asks which video this tab shows, to offer the per-video switch.
  const onMessage = (msg, sender, sendResponse) => {
    if (msg?.type !== 'EDU_GET_VIDEO') return;
    const id = currentVideoId();
    sendResponse(id ? { videoId: id, title: videoTitle() } : null);
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // Media events do not bubble, so they are caught in the capture phase;
  // this also survives YouTube replacing the <video> element.
  for (const type of MEDIA_EVENTS) document.addEventListener(type, onMediaEvent, true);
  // YouTube SPA navigation.
  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);

  function disconnect() {
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMediaEvent, true);
    document.removeEventListener('yt-navigate-finish', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // context already invalidated
    }
  }

  reset();
})();
