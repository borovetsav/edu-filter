// Считает реальное время воспроизведения видео на youtube.com/watch.
// Скрипт подключён ко всему youtube.com, потому что YouTube — SPA: переход
// с главной на /watch не перезагружает страницу и скрипт иначе не запустится.
(() => {
  const THRESHOLD_SEC = 60;
  const MAX_TICK_SEC = 1.5; // защита от скачков (сон ноутбука, фоновая вкладка и т.п.)
  const REMINDER_BEFORE_END_SEC = 15;
  const REMINDER_CHECK_INTERVAL_MS = 3000;
  const REMINDER_ID = 'edu-filter-reminder';

  let videoId = null;
  let watchedSec = 0;
  let lastTick = null; // performance.now() последнего учтённого момента воспроизведения
  const triggered = new Set(); // videoId, для которых уже отправлен триггер
  const reminded = new Set(); // videoId, для которых уже показано напоминание
  let lastReminderCheck = 0;

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
  }

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
    console.log(`[EduFilter] ${Math.round(watchedSec)} с просмотра, отправляю`, url);
    chrome.runtime.sendMessage({ type: 'VIDEO_WATCHED', url, videoId, title: videoTitle() }).catch((err) => {
      console.warn('[EduFilter] не удалось отправить сообщение:', err);
      triggered.delete(videoId); // попробуем снова на следующем timeupdate
    });
  }

  // ---------- Напоминание в конце ролика ----------

  // Когда до конца осталось меньше REMINDER_BEFORE_END_SEC, спрашиваем у
  // background вердикт Gemini. Если видео полезное — показываем карточку.
  // Пока вердикта нет, переспрашиваем не чаще раза в несколько секунд.
  async function maybeShowReminder(video) {
    const id = videoId;
    if (!id || reminded.has(id) || isAdPlaying()) return;
    const left = video.duration - video.currentTime;
    if (!Number.isFinite(left) || left > REMINDER_BEFORE_END_SEC) return;

    const now = performance.now();
    if (now - lastReminderCheck < REMINDER_CHECK_INTERVAL_MS) return;
    lastReminderCheck = now;

    const state = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_STATUS', videoId: id }).catch(() => null);
    if (state?.verdict !== 'USEFUL' || reminded.has(id)) return;
    reminded.add(id);
    showReminder(id, state.status === 'SUMMARY_DONE');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Карточка в Shadow DOM, чтобы стили YouTube её не ломали. Собирается через
  // createElement: YouTube запрещает innerHTML (Trusted Types).
  function showReminder(id, summaryReady) {
    document.getElementById(REMINDER_ID)?.remove();

    const host = el('div');
    host.id = REMINDER_ID;
    const root = host.attachShadow({ mode: 'open' });

    root.appendChild(el('style', null, `
      .card {
        position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
        width: 320px; padding: 16px 18px; box-sizing: border-box;
        background: #fff; color: #1f1f1f; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.28);
        font: 14px/1.45 Roboto, Arial, sans-serif;
        animation: in .25s ease-out;
      }
      @keyframes in { from { opacity: 0; transform: translateY(12px); } }
      .title { font-weight: 600; font-size: 15px; margin: 0 24px 6px 0; }
      .text { margin: 0 0 12px; color: #444; }
      .open {
        border: 0; border-radius: 18px; padding: 8px 16px; cursor: pointer;
        background: #1a73e8; color: #fff; font: inherit; font-weight: 500;
      }
      .open:hover { background: #1765cc; }
      .close {
        position: absolute; top: 8px; right: 10px; border: 0; background: none;
        font-size: 20px; line-height: 1; color: #777; cursor: pointer;
      }
      @media (prefers-color-scheme: dark) {
        .card { background: #282828; color: #f1f1f1; }
        .text { color: #bbb; }
      }
    `));

    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Закрыть');
    const open = el('button', 'open', 'Перейти в чат Gemini');
    card.append(
      close,
      el('div', 'title', 'Видео почти закончилось 🎓'),
      el('p', 'text', summaryReady
        ? 'Перейдите в чат Gemini для закрепления материала: там уже готовы конспект и тест.'
        : 'Перейдите в чат Gemini для закрепления материала: конспект и тест сейчас готовятся.'),
      open
    );
    root.appendChild(card);

    close.addEventListener('click', () => host.remove());
    open.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_GEMINI_CHAT', videoId: id }).catch(() => {});
      host.remove();
    });

    // В полноэкранном режиме виден только fullscreen-элемент — кладём карточку в него.
    (document.fullscreenElement || document.body).appendChild(host);
  }

  document.addEventListener('fullscreenchange', () => {
    const host = document.getElementById(REMINDER_ID);
    if (host) (document.fullscreenElement || document.body).appendChild(host);
  });

  // ---------- События плеера ----------

  function onMediaEvent(e) {
    if (!isMainVideo(e.target)) return;

    // Страховка: если yt-navigate-finish не дошёл, а видео уже другое.
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
        // Досчитываем отрезок до остановки (если отсчёт шёл) и останавливаем его.
        if (lastTick !== null && !isAdPlaying()) accumulate();
        lastTick = null;
        maybeTrigger();
        if (e.type === 'ended') maybeShowReminder(video);
        break;
      case 'timeupdate':
        if (video.paused || video.ended || isAdPlaying()) {
          lastTick = null;
          return;
        }
        accumulate();
        maybeTrigger();
        maybeShowReminder(video);
        break;
    }
  }

  // Медиа-события не всплывают, поэтому ловим их на фазе захвата —
  // так не важно, пересоздаст ли YouTube элемент <video>.
  for (const type of ['play', 'playing', 'pause', 'ended', 'waiting', 'seeking', 'timeupdate']) {
    document.addEventListener(type, onMediaEvent, true);
  }

  // SPA-навигация YouTube.
  document.addEventListener('yt-navigate-finish', () => {
    if (currentVideoId() !== videoId) reset();
  });
  window.addEventListener('popstate', () => {
    if (currentVideoId() !== videoId) reset();
  });

  reset();
})();
