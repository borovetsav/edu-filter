import { getPrompts, VIDEO_KEY_PREFIX } from './defaults.js';

const GEMINI_URL = 'https://gemini.google.com/app';
const TAB_LOAD_TIMEOUT_MS = 60_000;
const MAX_CHAPTERS_IN_PROMPT = 12;

// Per-video state: { status, verdict, title, videoUrl, createdAt, tabId,
// chatUrl, quizzes }. Kept in storage.local because the service worker can be
// unloaded at any time; it also drives the popup history and makes sure each
// video is processed only once.
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

function formatTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

// ---------- Tabs ----------

// After chrome.tabs.reload the cached status can still read 'complete', so
// callers that just reloaded pass { fresh: true } to wait for the real event.
function waitForTabComplete(tabId, { fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out loading the Gemini tab'));
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
        reject(new Error('The Gemini tab was closed before it loaded'));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // The tab may have finished loading before we subscribed.
    if (fresh) return;
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    }, () => {});
  });
}

// The stored tabId is only trusted while that tab still shows this video's
// chat: after a browser restart the same id may belong to another tab.
async function findChatTab(state) {
  if (state?.tabId == null) return null;
  try {
    const tab = await chrome.tabs.get(state.tabId);
    return tab.url?.startsWith(state.chatUrl || GEMINI_URL) ? tab : null;
  } catch {
    return null;
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Injects content_gemini.js unless a live copy already answers. A copy left
// over from before an extension reload cannot answer, so it is replaced.
async function ensureGeminiScript(tabId) {
  try {
    if (await chrome.tabs.sendMessage(tabId, { type: 'EDU_PING' })) return;
  } catch {
    // no live script in the tab
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content_gemini.js'] });
}

// ---------- Main flow ----------

// USEFUL is final: the summaries and quizzes are requested later, per stretch.
const IN_PROGRESS = ['PENDING'];
const INTERRUPTED =
  'The extension was reloaded while this video was being processed. Open the chat to see how far Gemini got, or click Send again.';

// An update or reload orphans the Gemini scripts, so the results of videos
// and quizzes in flight never arrive. Mark them as failed instead of leaving
// them "in progress" forever; Send again in the popup restarts a video.
async function failInterruptedVideos() {
  const all = await chrome.storage.local.get(null);
  const patch = {};
  for (const [key, state] of Object.entries(all)) {
    if (!key.startsWith(VIDEO_KEY_PREFIX)) continue;
    const quizzes = Object.fromEntries(
      Object.entries(state.quizzes ?? {}).map(([i, s]) => [i, s === 'REQUESTED' ? 'ERROR' : s])
    );
    const interrupted = IN_PROGRESS.includes(state.status);
    if (interrupted || JSON.stringify(quizzes) !== JSON.stringify(state.quizzes ?? {})) {
      patch[key] = { ...state, quizzes, ...(interrupted && { status: 'ERROR', detail: INTERRUPTED }) };
    }
  }
  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
    console.log('[EduFilter] marked as interrupted:', Object.keys(patch));
  }
}

async function processVideo(videoUrl, videoId, title) {
  if (await getVideoState(videoId)) {
    console.log('[EduFilter] already processed:', videoId);
    return;
  }
  await patchVideoState(videoId, { status: 'PENDING', title, videoUrl, createdAt: Date.now() });

  const tab = await chrome.tabs.create({ url: GEMINI_URL, active: false });
  await patchVideoState(videoId, { tabId: tab.id });
  await waitForTabComplete(tab.id);
  await ensureGeminiScript(tab.id);

  const { prompt_1 } = await getPrompts();
  await chrome.tabs.sendMessage(tab.id, { type: 'RUN_GEMINI', videoUrl, prompt_1 });
}

// Forgets the previous result (e.g. an ENTERTAINMENT verdict the user
// disagrees with) and runs the video through Gemini again.
async function recheckVideo(videoId) {
  const state = await getVideoState(videoId);
  if (!state) return;
  await chrome.storage.local.remove(videoKey(videoId));
  await processVideo(state.videoUrl || `https://www.youtube.com/watch?v=${videoId}`, videoId, state.title);
}

async function onGeminiResult(msg, tabId) {
  console.log('[EduFilter] Gemini result:', msg.status, msg.detail ?? '', tabId);
  const videoId = videoIdFromUrl(msg.videoUrl);
  if (!videoId) return;

  const patch = { status: msg.status, detail: msg.detail ?? null, tabId, chatUrl: msg.chatUrl };
  if (msg.status === 'USEFUL' || msg.status === 'SUMMARY_DONE') patch.verdict = 'USEFUL';
  else if (msg.status === 'FUN') patch.verdict = 'FUN';
  await patchVideoState(videoId, patch);
}

// Brings the user back to this video's Gemini chat, reopening it from the
// saved URL if the tab is gone.
async function openGeminiChat(videoId) {
  const state = await getVideoState(videoId);
  const tab = await findChatTab(state);
  if (tab) await focusTab(tab);
  else await chrome.tabs.create({ url: state?.chatUrl || GEMINI_URL, active: true });
}

// ---------- Quizzes for parts of long videos ----------

// Sends prompt_3 for one part of the video to the video's existing chat, so
// Gemini keeps the context, and shows that chat to the user.
async function requestPartQuiz(videoId, part) {
  const state = await getVideoState(videoId);
  if (!state) throw new Error(`No state for video ${videoId}`);

  let tab = await findChatTab(state);
  if (!tab) {
    tab = await chrome.tabs.create({ url: state.chatUrl || GEMINI_URL, active: true });
    await patchVideoState(videoId, { tabId: tab.id });
    await waitForTabComplete(tab.id);
  } else if (tab.discarded) {
    // Memory Saver unloaded the tab: its page (and script) are gone.
    await focusTab(tab);
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id, { fresh: true });
  } else if (tab.status !== 'complete') {
    await waitForTabComplete(tab.id);
  }
  await focusTab(tab);
  await ensureGeminiScript(tab.id);

  const titles = part.chapters.slice(0, MAX_CHAPTERS_IN_PROMPT);
  const { prompt_3 } = await getPrompts();
  const prompt = fillTemplate(prompt_3, {
    part: part.index + 1,
    total: part.total,
    start: formatTime(part.start),
    end: formatTime(part.end),
    chapters: titles.length ? `. Topics of this part: ${titles.join('; ')}` : '',
    url: state.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
  });

  await patchVideoState(videoId, { quizzes: { ...state.quizzes, [part.index]: 'REQUESTED' } });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'SEND_PROMPT',
    prompt,
    label: `summary and quiz for part ${part.index + 1}/${part.total}`,
    meta: { videoId, partIndex: part.index },
  });
}

async function onPromptResult(msg) {
  console.log('[EduFilter] prompt result:', msg.label, msg.status, msg.detail ?? '');
  const { videoId, partIndex } = msg.meta ?? {};
  if (!videoId || partIndex == null) return;
  const state = await getVideoState(videoId);
  await patchVideoState(videoId, { quizzes: { ...state?.quizzes, [partIndex]: msg.status } });
}

// ---------- Wiring ----------

function isOlderThan(version, than) {
  const a = String(version).split('.').map(Number);
  const b = than.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  }
  return false;
}

// The 1.1 default prompt_3 spoke of "part {part} of {total}"; since 1.2 a
// quiz can cover several merged parts, so a saved copy of that exact default
// is replaced by the new one. Edited prompts are left alone.
const PROMPT_3_DEFAULT_1_1 =
  'Now write a 5-question quiz to reinforce the material covered ONLY in part {part} of {total} of this video, from {start} to {end}{chapters}. Use multiple-choice questions and put the correct answers with short explanations at the very end, after all questions. Write in Russian. Video: {url}';

// The 1.2-1.4 default prompt_3 asked for a quiz only; since 1.5 there is no
// whole-video summary (prompt_2 is gone), so each stretch gets its own
// summary and quiz.
const PROMPT_3_DEFAULT_1_2 =
  'Now write a 5-question quiz to reinforce the material covered ONLY in this video from {start} to {end}{chapters}. Use multiple-choice questions and put the correct answers with short explanations at the very end, after all questions. Write in Russian. Video: {url}';

// One-time migrations, run only when updating from an older version (not on
// later updates or unpacked reloads).
// - From 1.0, which shipped Russian prompts with Russian verdict words: the
//   classifier now looks for USEFUL / ENTERTAINMENT, so a saved prompt_1
//   without them can never be classified; prompt_2 was the Russian default.
// - From 1.1: see PROMPT_3_DEFAULT_1_1.
// - From 1.2-1.4: see PROMPT_3_DEFAULT_1_2; the saved prompt_2 is unused.
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason !== 'update') return;
  await failInterruptedVideos();
  const { prompt_1, prompt_2, prompt_3 } = await chrome.storage.local.get(['prompt_1', 'prompt_2', 'prompt_3']);
  const stale = [];
  if (isOlderThan(previousVersion, '1.1.0')) {
    if (prompt_1 != null && !(prompt_1.includes('USEFUL') && prompt_1.includes('ENTERTAINMENT'))) stale.push('prompt_1');
    if (prompt_2 != null && /[\u0400-\u04FF]/.test(prompt_2)) stale.push('prompt_2');
  }
  if (isOlderThan(previousVersion, '1.2.0') && prompt_3 === PROMPT_3_DEFAULT_1_1) stale.push('prompt_3');
  if (isOlderThan(previousVersion, '1.5.0')) {
    if (prompt_2 != null) stale.push('prompt_2');
    if (prompt_3 === PROMPT_3_DEFAULT_1_2) stale.push('prompt_3');
  }
  if (stale.length) {
    await chrome.storage.local.remove(stale);
    console.log('[EduFilter] reset outdated prompts:', stale);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const logError = (err) => console.error('[EduFilter]', msg.type, err);
  switch (msg?.type) {
    case 'VIDEO_WATCHED':
      if (msg.url && msg.videoId) processVideo(msg.url, msg.videoId, msg.title).catch(logError);
      break;
    case 'GEMINI_RESULT':
      onGeminiResult(msg, sender.tab?.id).catch(logError);
      break;
    case 'GEMINI_PROMPT_RESULT':
      onPromptResult(msg).catch(logError);
      break;
    case 'GET_VIDEO_STATUS':
      getVideoState(msg.videoId).then(sendResponse, () => sendResponse(null));
      return true; // async response
    case 'OPEN_GEMINI_CHAT':
      openGeminiChat(msg.videoId).catch(logError);
      break;
    case 'RECHECK_VIDEO':
      recheckVideo(msg.videoId).catch(logError);
      break;
    case 'REQUEST_PART_QUIZ':
      requestPartQuiz(msg.videoId, msg.part).catch(logError);
      break;
  }
});
