import { getPrompts, VIDEO_KEY_PREFIX } from './defaults.js';

const GEMINI_URL = 'https://gemini.google.com/app';
const TAB_LOAD_TIMEOUT_MS = 60_000;

// Состояние по каждому видео: { status, verdict, title, videoUrl, createdAt,
// tabId, chatUrl }. Хранится в storage.local: service worker может выгружаться,
// popup показывает по нему историю, а заодно видео не обрабатывается повторно.
const videoKey = (videoId) => VIDEO_KEY_PREFIX + videoId;

async function getVideoState(videoId) {
  const key = videoKey(videoId);
  return (await chrome.storage.local.get(key))[key] ?? null;
}

async function patchVideoState(videoId, patch) {
  const state = { ...(await getVideoState(videoId)), ...patch };
  await chrome.storage.local.set({ [videoKey(videoId)]: state });
  return state;
}

function videoIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Таймаут загрузки вкладки Gemini'));
    }, TAB_LOAD_TIMEOUT_MS);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    }
    function onRemoved(id) {
      if (id === tabId) {
        cleanup();
        reject(new Error('Вкладка Gemini закрыта до загрузки'));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // Вкладка могла загрузиться до того, как мы подписались.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    }, () => {});
  });
}

async function processVideo(videoUrl, videoId, title) {
  if (await getVideoState(videoId)) {
    console.log('[EduFilter] уже обработано:', videoId);
    return;
  }
  await patchVideoState(videoId, { status: 'PENDING', title, videoUrl, createdAt: Date.now() });

  const tab = await chrome.tabs.create({ url: GEMINI_URL, active: false });
  await patchVideoState(videoId, { tabId: tab.id });
  await waitForTabComplete(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content_gemini.js'],
  });

  const { prompt_1, prompt_2 } = await getPrompts();
  await chrome.tabs.sendMessage(tab.id, {
    type: 'RUN_GEMINI',
    videoUrl,
    prompt_1,
    prompt_2,
  });
}

async function onGeminiResult(msg, tabId) {
  console.log('[EduFilter] результат Gemini:', msg.status, msg.detail ?? '', tabId);
  const videoId = videoIdFromUrl(msg.videoUrl);
  if (!videoId) return;

  const patch = { status: msg.status, detail: msg.detail ?? null, tabId, chatUrl: msg.chatUrl };
  if (msg.status === 'USEFUL' || msg.status === 'SUMMARY_DONE') patch.verdict = 'USEFUL';
  else if (msg.status === 'FUN') patch.verdict = 'FUN';
  await patchVideoState(videoId, patch);
}

// Возвращает пользователя в чат Gemini этого видео: активирует открытую
// вкладку, а если её закрыли — открывает чат заново по сохранённому адресу.
// Адрес вкладки сверяем с chatUrl: после перезапуска браузера сохранённый
// tabId может принадлежать уже другой вкладке.
async function openGeminiChat(videoId) {
  const state = await getVideoState(videoId);
  if (state?.tabId != null) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      const expected = state.chatUrl || GEMINI_URL;
      if (tab.url?.startsWith(expected)) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch {
      // вкладку закрыли — откроем заново
    }
  }
  await chrome.tabs.create({ url: state?.chatUrl || GEMINI_URL, active: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'VIDEO_WATCHED':
      if (msg.url && msg.videoId) {
        processVideo(msg.url, msg.videoId, msg.title).catch((err) =>
          console.error('[EduFilter] ошибка обработки', msg.url, err)
        );
      }
      break;
    case 'GEMINI_RESULT':
      onGeminiResult(msg, sender.tab?.id).catch((err) => console.error('[EduFilter]', err));
      break;
    case 'GET_VIDEO_STATUS':
      getVideoState(msg.videoId).then(sendResponse, () => sendResponse(null));
      return true; // ответ придёт асинхронно
    case 'OPEN_GEMINI_CHAT':
      openGeminiChat(msg.videoId).catch((err) => console.error('[EduFilter]', err));
      break;
  }
});
