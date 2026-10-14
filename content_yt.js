// Runs on all of youtube.com because YouTube is a single-page app: going from
// the home page to /watch does not reload the page, so a script limited to
// /watch would never start.
//
// - Counts real playback time and asks the background to process the video
//   once it has been watched for watch_threshold_min minutes (or, if the
//   video is shorter than that, once SHORT_VIDEO_SHARE of it was watched).
// - Places quiz breaks in useful videos every ~N minutes of the timeline
//   (moved to chapter starts when possible). When the playhead moves forward
//   past a break, by playback or by seeking, the video pauses and a card
//   offers a quiz on the stretch since the previous break.
// - Shows a "go to the Gemini chat" card near the end of videos too short
//   for a break.
(() => {
  const MAX_TICK_SEC = 1.5; // ignore jumps (laptop sleep, throttled tab, etc.)
  const REMINDER_BEFORE_END_SEC = 15;
  const STATE_REFRESH_MS = 5000;
  const CARD_ID = 'edu-filter-card';

  // Set in the popup. Keep in sync with DEFAULT_SETTINGS in defaults.js.
  const DEFAULT_SETTINGS = { watch_threshold_min: 10, quiz_interval_min: 40, quiz_snap_min: 10 };
  const MIN_INTERVAL_MIN = 5;
  const MIN_THRESHOLD_MIN = 1;
  // A video shorter than the threshold counts as watched at this share of it.
  const SHORT_VIDEO_SHARE = 0.9;
  // Without chapters, wait this long after navigation before settling on
  // equal parts: the chapter list may not have rendered yet.
  const CHAPTERS_GRACE_MS = 30_000;

  let videoId = null;
  let watchedSec = 0;
  let lastTick = null; // performance.now() of the last counted playback moment
  let videoState = null; // cached GET_VIDEO_STATUS answer for videoId
  let lastStateFetch = 0;
  let settings = { ...DEFAULT_SETTINGS };
  let parts; // undefined: not computed yet, null: no quiz breaks in this video
  let lastPos = null; // last known main-video playhead position (not during ads)
  let resetAt = 0; // performance.now() of the last navigation

  const triggered = new Set(); // videoIds already sent to the background
  const reminded = new Set(); // videoIds that got the end-of-video card
  const shownParts = new Set(); // partKey()s whose break already fired

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
    const threshold = Number(stored.watch_threshold_min);
    const interval = Number(stored.quiz_interval_min);
    const snap = Number(stored.quiz_snap_min);
    settings = {
      watch_threshold_min: threshold >= MIN_THRESHOLD_MIN ? threshold : DEFAULT_SETTINGS.watch_threshold_min,
      quiz_interval_min: interval >= MIN_INTERVAL_MIN ? interval : DEFAULT_SETTINGS.quiz_interval_min,
      quiz_snap_min: snap >= 0 ? snap : DEFAULT_SETTINGS.quiz_snap_min,
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

  // Watching for a while means the video is interesting enough to process.
  function watchThresholdSec(video) {
    const threshold = settings.watch_threshold_min * 60;
    const duration = video.duration;
    return Number.isFinite(duration) && duration > 0 && duration < threshold
      ? duration * SHORT_VIDEO_SHARE
      : threshold;
  }

  function maybeTrigger(video) {
    if (!videoId || triggered.has(videoId) || isAdPlaying() || watchedSec < watchThresholdSec(video)) return;
    triggered.add(videoId);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[EduFilter] watched ${Math.round(watchedSec)} s, sending`, url);
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
    if (!id || videoState?.verdict === 'FUN' || now - lastStateFetch < STATE_REFRESH_MS) return;
    lastStateFetch = now;
    const state = await send({ type: 'GET_VIDEO_STATUS', videoId: id }).catch(() => null);
    if (id === videoId) videoState = state;
  }

  const isUseful = () => videoState?.verdict === 'USEFUL';

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

  // Computed once per useful video (and again when the settings change).
  // Not gated on watch time: a video resumed mid-way may reach a break before
  // the watch threshold of this session is reached. The page must already show this video (SPA navigation
  // swaps the DOM late), and no ad may be playing (an ad's duration is not
  // the video's).
  function getParts(video) {
    if (parts !== undefined) return parts;
    if (!isUseful() || isAdPlaying() || !Number.isFinite(video.duration)) return null;
    if (document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== videoId) return null;

    const chapters = readChapters(video.duration);
    const result = buildParts(
      video.duration,
      chapters,
      settings.quiz_interval_min * 60,
      settings.quiz_snap_min * 60
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
  // The position the page opens at (e.g. YouTube resuming) is not a move.
  function checkPartBoundary(video, prev, pos) {
    if (prev == null || pos <= prev || !isUseful()) return;

    const crossed = (getParts(video) ?? []).filter(
      (part) => !shownParts.has(partKey(part)) && prev < part.end && pos >= part.end
    );
    if (!crossed.length) return;
    crossed.forEach((part) => shownParts.add(partKey(part)));

    const last = crossed.at(-1);
    video.pause();
    showPartCard(video, {
      ...last,
      start: crossed[0].start,
      chapters: crossed.flatMap((part) => part.chapters),
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
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
      width: 340px; padding: 16px 18px; box-sizing: border-box;
      background: #fff; color: #1f1f1f; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.28);
      font: 14px/1.45 Roboto, Arial, sans-serif;
      animation: in .25s ease-out;
    }
    @keyframes in { from { opacity: 0; transform: translateY(12px); } }
    .title { font-weight: 600; font-size: 15px; margin: 0 24px 6px 0; }
    .text { margin: 0 0 12px; color: #444; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .action {
      border: 0; border-radius: 18px; padding: 8px 16px; cursor: pointer;
      background: #e8eaed; color: #1f1f1f; font: inherit; font-weight: 500;
    }
    .action.primary { background: #1a73e8; color: #fff; }
    .action.primary:hover { background: #1765cc; }
    .close {
      position: absolute; top: 8px; right: 10px; border: 0; background: none;
      font-size: 20px; line-height: 1; color: #777; cursor: pointer;
    }
    @media (prefers-color-scheme: dark) {
      .card { background: #282828; color: #f1f1f1; }
      .text { color: #bbb; }
      .action { background: #3c4043; color: #f1f1f1; }
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

    card.append(close, el('div', 'title', title), ...lines.map((line) => el('p', 'text', line)), buttons);
    root.appendChild(card);

    // In fullscreen only the fullscreen element is visible, so the card goes there.
    (document.fullscreenElement || document.body).appendChild(host);
  }

  document.addEventListener('fullscreenchange', () => {
    const host = document.getElementById(CARD_ID);
    if (host) (document.fullscreenElement || document.body).appendChild(host);
  });

  function showPartCard(video, part) {
    const id = videoId;
    const isLast = part.index === part.total - 1;
    const topics = part.chapters.slice(0, 3).join('; ');
    showCard({
      title: isLast ? 'Almost done: time for a quiz' : 'Time for a quiz',
      lines: [
        `Covers ${formatTime(part.start)} – ${formatTime(part.end)} of the video. Take a short quiz on it to lock in the material.`,
        ...(topics ? [`Topics: ${topics}${part.chapters.length > 3 ? '; ...' : ''}`] : []),
      ],
      actions: [
        {
          label: 'Take the quiz',
          primary: true,
          onClick: () => send({ type: 'REQUEST_PART_QUIZ', videoId: id, part }).catch(() => {}),
        },
        { label: 'Keep watching', onClick: () => video.play() },
      ],
    });
  }

  // Near the end of a useful video too short for a quiz break.
  function maybeShowReminder(video) {
    const id = videoId;
    if (!id || reminded.has(id) || !isUseful() || isAdPlaying()) return;
    // Until the split is known (parts === undefined), don't assume there is none.
    if (getParts(video) || parts === undefined) return;
    const left = video.duration - video.currentTime;
    if (!Number.isFinite(left) || left > REMINDER_BEFORE_END_SEC) return;

    reminded.add(id);
    const ready = videoState.status === 'SUMMARY_DONE';
    showCard({
      title: 'The video is almost over',
      lines: [
        ready
          ? 'Open the Gemini chat to review the material: the summary and quiz are ready.'
          : 'Open the Gemini chat to review the material: the summary and quiz are on their way.',
      ],
      actions: [
        {
          label: 'Open Gemini chat',
          primary: true,
          onClick: () => send({ type: 'OPEN_GEMINI_CHAT', videoId: id }).catch(() => {}),
        },
      ],
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
        lastPos = video.currentTime;
        maybeShowReminder(video);
        break;
    }
  }

  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'waiting', 'seeking', 'timeupdate'];
  const onNavigate = () => {
    if (currentVideoId() !== videoId) reset();
  };

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
  }

  reset();
})();
