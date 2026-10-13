// Runs on all of youtube.com because YouTube is a single-page app: going from
// the home page to /watch does not reload the page, so a script limited to
// /watch would never start.
//
// - Counts real playback time and asks the background to process the video
//   after THRESHOLD_SEC.
// - Splits long useful videos into parts (by chapters when possible), pauses
//   at the end of each part and offers a quiz on that part.
// - Shows a "go to the Gemini chat" card near the end of other useful videos.
(() => {
  const THRESHOLD_SEC = 60;
  const MAX_TICK_SEC = 1.5; // ignore jumps (laptop sleep, throttled tab, etc.)
  const REMINDER_BEFORE_END_SEC = 15;
  const STATE_REFRESH_MS = 5000;
  const CARD_ID = 'edu-filter-card';

  // Long videos are split into parts of about TARGET_PART_SEC (40-60 min).
  // A video gets at least two parts only from ~75 min on. Part boundaries
  // snap to the nearest chapter start within CHAPTER_SNAP_SEC.
  const TARGET_PART_SEC = 50 * 60;
  const CHAPTER_SNAP_SEC = 10 * 60;
  // A jump of the playhead larger than this is a seek, not playback.
  const MAX_PLAYBACK_STEP_SEC = 2;
  // Without chapters, wait this long after navigation before settling on
  // equal parts: the chapter list may not have rendered yet.
  const CHAPTERS_GRACE_MS = 30_000;

  let videoId = null;
  let watchedSec = 0;
  let lastTick = null; // performance.now() of the last counted playback moment
  let videoState = null; // cached GET_VIDEO_STATUS answer for videoId
  let lastStateFetch = 0;
  let parts; // undefined: not computed yet, null: video is not split
  let lastPos = null; // video.currentTime at the previous main-video playback tick
  let resetAt = 0; // performance.now() of the last navigation

  const triggered = new Set(); // videoIds already sent to the background
  const reminded = new Set(); // videoIds that got the end-of-video card
  const shownParts = new Set(); // `${videoId}:${partIndex}` cards already shown

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

  function maybeTrigger() {
    if (!videoId || triggered.has(videoId) || watchedSec < THRESHOLD_SEC) return;
    triggered.add(videoId);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[EduFilter] watched ${Math.round(watchedSec)} s, sending`, url);
    chrome.runtime.sendMessage({ type: 'VIDEO_WATCHED', url, videoId, title: videoTitle() }).catch((err) => {
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
    const state = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_STATUS', videoId: id }).catch(() => null);
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

  // Splits [0, duration] into about duration / TARGET_PART_SEC equal parts,
  // moving each boundary to the nearest chapter start if one is close enough.
  function buildParts(duration, chapters) {
    const total = Math.round(duration / TARGET_PART_SEC);
    if (total < 2) return null;

    const boundaries = [0];
    for (let i = 1; i < total; i++) {
      const ideal = (duration * i) / total;
      let best = ideal;
      let bestDistance = CHAPTER_SNAP_SEC;
      for (const c of chapters) {
        const distance = Math.abs(c.start - ideal);
        if (c.start > boundaries.at(-1) && distance <= bestDistance) {
          best = c.start;
          bestDistance = distance;
        }
      }
      boundaries.push(best);
    }
    // The last part ends where the end-of-video card would appear.
    boundaries.push(duration - REMINDER_BEFORE_END_SEC);

    return boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      return {
        index,
        total,
        start,
        end,
        chapters: chapters.filter((c) => c.start >= start && c.start < end).map((c) => c.title),
      };
    });
  }

  // Computed once per useful video. Not gated on watch time: a video resumed
  // mid-way may cross a part end within its first minute. The page must
  // already show this video (SPA navigation swaps the DOM late), and no ad
  // may be playing (an ad's duration is not the video's).
  function getParts(video) {
    if (parts !== undefined) return parts;
    if (!isUseful() || isAdPlaying() || !Number.isFinite(video.duration)) return null;
    if (document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== videoId) return null;

    const chapters = readChapters(video.duration);
    const result = buildParts(video.duration, chapters);
    if (result && !chapters.length && performance.now() - resetAt < CHAPTERS_GRACE_MS) return result;

    parts = result;
    if (parts) {
      console.log(
        `[EduFilter] long video, ${parts.length} parts (${chapters.length} chapters):`,
        parts.map((p) => `${formatTime(p.start)}-${formatTime(p.end)}`).join(', ')
      );
    }
    return parts;
  }

  // Pauses when playback naturally crosses the end of a part. Seeking past a
  // boundary does not count: the user chose to skip.
  function checkPartBoundary(video) {
    const pos = video.currentTime;
    const prev = lastPos;
    lastPos = pos;
    if (prev == null || pos < prev || pos - prev > MAX_PLAYBACK_STEP_SEC) return;
    if (!isUseful()) return;

    for (const part of getParts(video) ?? []) {
      const key = `${videoId}:${part.index}`;
      if (shownParts.has(key) || !(prev < part.end && pos >= part.end)) continue;
      shownParts.add(key);
      video.pause();
      showPartCard(video, part);
      return;
    }
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
      title: isLast
        ? `Almost done: part ${part.total} of ${part.total} finished`
        : `Part ${part.index + 1} of ${part.total} finished`,
      lines: [
        `${formatTime(part.start)} – ${formatTime(part.end)}. Take a short quiz on this part to lock in the material.`,
        ...(topics ? [`Topics: ${topics}${part.chapters.length > 3 ? '; ...' : ''}`] : []),
      ],
      actions: [
        {
          label: 'Take the quiz',
          primary: true,
          onClick: () => chrome.runtime.sendMessage({ type: 'REQUEST_PART_QUIZ', videoId: id, part }).catch(() => {}),
        },
        { label: 'Keep watching', onClick: () => video.play() },
      ],
    });
  }

  // Near the end of a useful video that is not split into parts.
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
          onClick: () => chrome.runtime.sendMessage({ type: 'OPEN_GEMINI_CHAT', videoId: id }).catch(() => {}),
        },
      ],
    });
  }

  // ---------- Player events ----------

  function onMediaEvent(e) {
    if (!isMainVideo(e.target)) return;

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
        if (e.type === 'seeking') lastPos = null;
        maybeTrigger();
        if (e.type === 'ended' && !isAdPlaying()) maybeShowReminder(video);
        break;
      case 'timeupdate':
        // lastPos is kept across pauses and ads, so a part end crossed right
        // after resuming (or after a mid-roll) is still detected; only a
        // seek clears it.
        if (video.paused || video.ended || isAdPlaying()) {
          lastTick = null;
          return;
        }
        accumulate();
        maybeTrigger();
        refreshState();
        checkPartBoundary(video);
        maybeShowReminder(video);
        break;
    }
  }

  // Media events do not bubble, so they are caught in the capture phase;
  // this also survives YouTube replacing the <video> element.
  for (const type of ['play', 'playing', 'pause', 'ended', 'waiting', 'seeking', 'timeupdate']) {
    document.addEventListener(type, onMediaEvent, true);
  }

  // YouTube SPA navigation.
  document.addEventListener('yt-navigate-finish', () => {
    if (currentVideoId() !== videoId) reset();
  });
  window.addEventListener('popstate', () => {
    if (currentVideoId() !== videoId) reset();
  });

  reset();
})();
