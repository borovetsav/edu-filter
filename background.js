import { DEFAULT_SETTINGS, getPrompts, VIDEO_KEY_PREFIX } from './defaults.js';

const GEMINI_URL = 'https://gemini.google.com/app';
const TAB_LOAD_TIMEOUT_MS = 60_000;
const MAX_CHAPTERS_IN_PROMPT = 12;
const MAX_QUIZ_QUESTIONS = 20;

// Per-video state: { status, verdict, quiz, title, videoUrl, createdAt, tabId,
// chatUrl, quizzes }. status and verdict exist only once the video was sent
// for a verdict ('auto' check mode or Send again); quiz is the user's choice
// for this video ('on' / 'off'). Kept in storage.local because the service worker can be
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
  // A video that already has a verdict or a chat (its quizzes were asked for
  // in 'request' mode) is not sent again.
  const state = await getVideoState(videoId);
  if (state?.status || state?.chatUrl || state?.quizzes) {
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
// disagrees with) and runs the video through Gemini again. The user's quiz
// choice for the video is kept.
async function recheckVideo(videoId) {
  const state = await getVideoState(videoId);
  if (!state) return;
  await chrome.storage.local.remove(videoKey(videoId));
  if (state.quiz) await patchVideoState(videoId, { quiz: state.quiz });
  await processVideo(state.videoUrl || `https://www.youtube.com/watch?v=${videoId}`, videoId, state.title);
}

// The user turned the break cards on or off for one video (card or popup).
async function setVideoQuiz(videoId, quiz, title) {
  const state = await getVideoState(videoId);
  await patchVideoState(videoId, {
    quiz,
    title: state?.title || title,
    videoUrl: state?.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
    createdAt: state?.createdAt ?? Date.now(),
  });
}

// The verdict chat only needs a tab while Gemini answers: once it has, the
// background tab is closed and reopened from chatUrl when a quiz is asked
// for. A tab the user has switched to is left alone, and so is one with an
// error or no verdict, for the user to look at.
async function closeVerdictTab(tabId, chatUrl) {
  if (tabId == null || !/^https:\/\/gemini\.google\.com\/app\/[^/?#]+/.test(chatUrl ?? '')) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return false;
    await chrome.tabs.remove(tabId);
    return true;
  } catch {
    return false;
  }
}

async function onGeminiResult(msg, tabId) {
  console.log('[EduFilter] Gemini result:', msg.status, msg.detail ?? '', tabId);
  const videoId = videoIdFromUrl(msg.videoUrl);
  if (!videoId) return;

  const patch = { status: msg.status, detail: msg.detail ?? null, tabId, chatUrl: msg.chatUrl };
  if (msg.status === 'USEFUL' || msg.status === 'SUMMARY_DONE') patch.verdict = 'USEFUL';
  else if (msg.status === 'FUN') patch.verdict = 'FUN';
  // A quiz may already have been asked for in this chat (it is queued
  // behind the verdict); then the tab stays.
  const quizAsked = Object.values((await getVideoState(videoId))?.quizzes ?? {}).includes('REQUESTED');
  if (patch.verdict && !quizAsked && (await closeVerdictTab(tabId, msg.chatUrl))) patch.tabId = null;
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
// Gemini keeps the context, and shows that chat to the user. A video that
// was never sent for a verdict ('request' check mode) gets a new chat here.
async function requestPartQuiz(videoId, part, title) {
  let state = await getVideoState(videoId);
  if (!state?.createdAt) {
    state = await patchVideoState(videoId, {
      title,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      createdAt: Date.now(),
    });
  }

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
  const { quiz_questions } = await chrome.storage.local.get('quiz_questions');
  const questions = Number.isInteger(quiz_questions) && quiz_questions >= 1 && quiz_questions <= MAX_QUIZ_QUESTIONS
    ? quiz_questions
    : DEFAULT_SETTINGS.quiz_questions;
  const { answer_language } = await chrome.storage.local.get('answer_language');
  const language = String(answer_language ?? '').trim() || DEFAULT_SETTINGS.answer_language;
  const prompt = fillTemplate(prompt_3, {
    part: part.index + 1,
    total: part.total,
    start: formatTime(part.start),
    end: formatTime(part.end),
    chapters: titles.length ? `. Topics of this part: ${titles.join('; ')}` : '',
    url: state.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
    questions,
    language,
  });

  // A merged card covers several parts; all of them count as requested.
  const partIndexes = part.covers ?? [part.index];
  await patchVideoState(videoId, { quizzes: { ...state.quizzes, ...statusFor(partIndexes, 'REQUESTED') } });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'SEND_PROMPT',
    prompt,
    label: `summary and quiz for part ${part.index + 1}/${part.total}`,
    meta: { videoId, partIndexes },
  });
}

const statusFor = (indexes, status) => Object.fromEntries(indexes.map((i) => [i, status]));

async function onPromptResult(msg) {
  console.log('[EduFilter] prompt result:', msg.label, msg.status, msg.detail ?? '');
  const { videoId, partIndexes, partIndex } = msg.meta ?? {};
  const indexes = partIndexes ?? (partIndex != null ? [partIndex] : []);
  if (!videoId || !indexes.length) return;
  const state = await getVideoState(videoId);
  // The first quiz of a 'request' mode video is what creates its chat.
  const chatUrl = state?.chatUrl || msg.chatUrl;
  await patchVideoState(videoId, { quizzes: { ...state?.quizzes, ...statusFor(indexes, msg.status) }, chatUrl });
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

// The 1.5-1.6 default prompt_3 asked for a plain-text quiz; Gemini then
// often wrote the questions as text instead of its interactive quiz, so since
// 1.7 the default insists on the interactive one.
const PROMPT_3_DEFAULT_1_5 =
  'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then write a 5-question multiple-choice quiz on that part, with the correct answers and short explanations at the very end, after all questions. Write in Russian. Video: {url}';

// The 1.7 default prompt_3 got the interactive quiz but its questions were
// mostly recall of details; since 1.8 the default asks for questions that
// check understanding.
const PROMPT_3_DEFAULT_1_7 =
    'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then make an INTERACTIVE quiz on that part: use your built-in interactive quiz feature, the one where I click an answer option and immediately see whether it is right, with an explanation. 5 multiple-choice questions. This is important: do NOT write the quiz as plain text, and do NOT list the questions or answers in the message; I want the clickable interactive quiz. Write everything in Russian. Video: {url}';

// The 1.8 default prompt_3 had 5 questions written into it; since 1.9 the
// number comes from the quiz_questions setting ({questions}).
const PROMPT_3_DEFAULT_1_8 =
  'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then make an INTERACTIVE quiz on that part: use your built-in interactive quiz feature, the one where I click an answer option and immediately see whether it is right, with an explanation. Do NOT write the quiz as plain text, and do NOT list the questions or answers in the message. The quiz must check real understanding, not memory of details: 5 multiple-choice questions. No questions about names, dates, exact numbers, wording or who said what. Instead, ask the learner to apply an idea from the video to a new situation or example that was not in the video, to explain why something works or what causes what, to predict what happens if a condition changes, to compare or tell apart two close concepts, or to find the mistake in a plausible but wrong statement. Make the wrong options believable: typical misconceptions or half-right answers that someone who only skimmed the video would pick, all options similar in length. Order the questions from easier to harder. In each explanation, say why the right answer is right, why the tempting wrong answer is wrong, and the timestamp where this is explained. Write everything in Russian. Video: {url}';

// The 1.9-1.11 default prompt_3 asked for answers in Russian; since 1.12
// they are in English.
const PROMPT_3_DEFAULT_1_11 =
  'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then make an INTERACTIVE quiz on that part: use your built-in interactive quiz feature, the one where I click an answer option and immediately see whether it is right, with an explanation. Do NOT write the quiz as plain text, and do NOT list the questions or answers in the message. The quiz must check real understanding, not memory of details: {questions} multiple-choice questions. No questions about names, dates, exact numbers, wording or who said what. Instead, ask the learner to apply an idea from the video to a new situation or example that was not in the video, to explain why something works or what causes what, to predict what happens if a condition changes, to compare or tell apart two close concepts, or to find the mistake in a plausible but wrong statement. Make the wrong options believable: typical misconceptions or half-right answers that someone who only skimmed the video would pick, all options similar in length. Order the questions from easier to harder. In each explanation, say why the right answer is right, why the tempting wrong answer is wrong, and the timestamp where this is explained. Write everything in Russian. Video: {url}';

// The 1.12 default prompt_3 had English written into it; since 1.13 the
// language comes from the answer_language setting ({language}). A saved
// copy where only that word was changed keeps its language as the setting.
const PROMPT_3_DEFAULT_1_12 =
  'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then make an INTERACTIVE quiz on that part: use your built-in interactive quiz feature, the one where I click an answer option and immediately see whether it is right, with an explanation. Do NOT write the quiz as plain text, and do NOT list the questions or answers in the message. The quiz must check real understanding, not memory of details: {questions} multiple-choice questions. No questions about names, dates, exact numbers, wording or who said what. Instead, ask the learner to apply an idea from the video to a new situation or example that was not in the video, to explain why something works or what causes what, to predict what happens if a condition changes, to compare or tell apart two close concepts, or to find the mistake in a plausible but wrong statement. Make the wrong options believable: typical misconceptions or half-right answers that someone who only skimmed the video would pick, all options similar in length. Order the questions from easier to harder. In each explanation, say why the right answer is right, why the tempting wrong answer is wrong, and the timestamp where this is explained. Write everything in English. Video: {url}';

function languageInPrompt3_1_12(prompt) {
  const [head, tail] = PROMPT_3_DEFAULT_1_12.split('English');
  if (typeof prompt !== 'string' || !prompt.startsWith(head) || !prompt.endsWith(tail)) return null;
  const language = prompt.slice(head.length, prompt.length - tail.length).trim();
  return language && language.length <= 40 ? language : null;
}

// One-time migrations, run only when updating from an older version (not on
// later updates or unpacked reloads).
// - From 1.0, which shipped Russian prompts with Russian verdict words: the
//   classifier now looks for USEFUL / ENTERTAINMENT, so a saved prompt_1
//   without them can never be classified; prompt_2 was the Russian default.
// - From 1.1: see PROMPT_3_DEFAULT_1_1.
// - From 1.2-1.4: see PROMPT_3_DEFAULT_1_2; the saved prompt_2 is unused.
// - From 1.5-1.6: see PROMPT_3_DEFAULT_1_5.
// - From 1.7: see PROMPT_3_DEFAULT_1_7.
// - From 1.8: see PROMPT_3_DEFAULT_1_8.
// - From 1.9-1.11: see PROMPT_3_DEFAULT_1_11.
// - From 1.12: see PROMPT_3_DEFAULT_1_12.
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
  if (isOlderThan(previousVersion, '1.7.0') && prompt_3 === PROMPT_3_DEFAULT_1_5) stale.push('prompt_3');
  if (isOlderThan(previousVersion, '1.8.0') && prompt_3 === PROMPT_3_DEFAULT_1_7) stale.push('prompt_3');
  if (isOlderThan(previousVersion, '1.9.0') && prompt_3 === PROMPT_3_DEFAULT_1_8) stale.push('prompt_3');
  if (isOlderThan(previousVersion, '1.12.0') && prompt_3 === PROMPT_3_DEFAULT_1_11) stale.push('prompt_3');
  if (isOlderThan(previousVersion, '1.13.0')) {
    const language = languageInPrompt3_1_12(prompt_3);
    if (language) {
      stale.push('prompt_3');
      await chrome.storage.local.set({ answer_language: language });
    }
  }
  // Settings that were removed: since 1.10 the verdict is asked before the
  // first break; since 1.11 breaks snap to chapters by a share of the interval.
  if (isOlderThan(previousVersion, '1.11.0')) await chrome.storage.local.remove(['watch_threshold_min', 'quiz_snap_min']);
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
      requestPartQuiz(msg.videoId, msg.part, msg.title).catch(logError);
      break;
    case 'SET_VIDEO_QUIZ':
      setVideoQuiz(msg.videoId, msg.quiz, msg.title).catch(logError);
      break;
  }
});
