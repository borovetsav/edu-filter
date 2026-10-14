import { DEFAULT_PROMPTS, DEFAULT_SETTINGS, getPrompts, VIDEO_KEY_PREFIX } from './defaults.js';

// ---------- Prompts and settings ----------

const DEFAULTS = { ...DEFAULT_PROMPTS, ...DEFAULT_SETTINGS };
const fields = Object.keys(DEFAULTS).map((key) => document.getElementById(key));
const status = document.getElementById('status');

function fill(values) {
  for (const el of fields) el.value = values[el.id];
}

// Numbers are stored as numbers; an empty or invalid one falls back to its default.
function readField(el) {
  if (el.type !== 'number') return el.value;
  const value = Number(el.value);
  return el.value !== '' && Number.isFinite(value) && value >= Number(el.min) ? value : DEFAULT_SETTINGS[el.id];
}

function flash(text) {
  status.textContent = text;
  setTimeout(() => (status.textContent = ''), 1500);
}

// Every field is saved as soon as it changes: the popup closes on any click
// outside it, and an edit waiting for the Save button would be lost.
for (const el of fields) {
  el.addEventListener('input', () => {
    chrome.storage.local.set({ [el.id]: readField(el) });
    flash('Saved');
  });
  // Show the value that was actually stored (e.g. the default for an invalid number).
  el.addEventListener('change', () => {
    if (el.type === 'number') el.value = readField(el);
  });
}

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(fields.map((el) => [el.id, readField(el)]));
  await chrome.storage.local.set(values);
  fill(values);
  flash('Saved');
});

document.getElementById('reset').addEventListener('click', async () => {
  fill(DEFAULTS);
  await chrome.storage.local.set(DEFAULTS);
  flash('Reset');
});

// ---------- Video history ----------

const list = document.getElementById('videos');
const empty = document.getElementById('empty');
const clearBtn = document.getElementById('clear');

// Status chip: label and color class.
const STATUS_CHIP = {
  PENDING: { text: 'Analyzing', cls: 'pending' },
  USEFUL: { text: 'Useful', cls: 'useful' },
  // Videos processed before 1.5, which also had a whole-video summary.
  SUMMARY_DONE: { text: 'Useful', cls: 'useful' },
  FUN: { text: 'Entertainment', cls: '' },
  UNKNOWN: { text: 'No verdict', cls: 'error' },
  ERROR: { text: 'Error', cls: 'error' },
};

async function getVideos() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(VIDEO_KEY_PREFIX))
    .map(([key, state]) => ({ videoId: key.slice(VIDEO_KEY_PREFIX.length), ...state }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const countQuizzes = (quizzes, status) => Object.values(quizzes ?? {}).filter((s) => s === status).length;

// Counts only the stretches whose summary and quiz were requested, from the
// card at a quiz break.
function quizSummary(v) {
  const done = countQuizzes(v.quizzes, 'DONE');
  const requested = countQuizzes(v.quizzes, 'REQUESTED');
  const failed = countQuizzes(v.quizzes, 'ERROR');
  const parts = [
    done && `${done} reviewed`,
    requested && `${requested} in progress`,
    failed && `${failed} failed`,
  ].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return v.verdict === 'USEFUL' ? 'quiz at each break' : '';
}

function renderVideo(v) {
  const li = document.createElement('li');

  const info = document.createElement('div');
  info.className = 'info';

  const link = document.createElement('a');
  link.href = v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId}`;
  link.target = '_blank';
  link.textContent = v.title || v.videoId;
  link.title = link.textContent;

  const s = STATUS_CHIP[v.status] ?? { text: v.status, cls: '' };
  const meta = document.createElement('div');
  meta.className = 'meta';
  const chip = document.createElement('span');
  chip.className = `chip ${s.cls}`;
  chip.textContent = s.text;
  const rest = document.createElement('span');
  rest.textContent = [quizSummary(v), formatDate(v.createdAt)].filter(Boolean).join(' · ');
  meta.append(chip, rest);

  info.append(link, meta);
  if ((v.status === 'ERROR' || v.status === 'UNKNOWN') && v.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = v.status === 'UNKNOWN' ? `Gemini replied: "${v.detail}"` : v.detail;
    info.append(detail);
  }
  li.append(info);

  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  // The chat is reachable as soon as the Gemini tab exists, even before the verdict.
  if (v.tabId != null || v.chatUrl) {
    const open = document.createElement('button');
    open.className = 'open-chat';
    open.textContent = 'Open chat';
    open.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'OPEN_GEMINI_CHAT', videoId: v.videoId });
      window.close();
    });
    buttons.append(open);
  }

  // A video is processed once; this is the way to get another verdict.
  if (v.status === 'FUN' || v.status === 'UNKNOWN' || v.status === 'ERROR') {
    const retry = document.createElement('button');
    retry.className = 'retry';
    retry.textContent = 'Send again';
    retry.title = 'Ask Gemini about this video again';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      chrome.runtime.sendMessage({ type: 'RECHECK_VIDEO', videoId: v.videoId });
    });
    buttons.append(retry);
  }
  if (buttons.childElementCount) li.append(buttons);
  return li;
}

function renderStats(videos) {
  const set = (id, value) => (document.getElementById(id).textContent = value);
  set('stat-useful', videos.filter((v) => v.verdict === 'USEFUL').length);
  set('stat-quizzes', videos.reduce((n, v) => n + countQuizzes(v.quizzes, 'DONE'), 0));
  set(
    'stat-pending',
    videos.reduce((n, v) => n + (v.status === 'PENDING' ? 1 : 0) + countQuizzes(v.quizzes, 'REQUESTED'), 0)
  );
}

async function renderVideos() {
  const videos = await getVideos();
  renderStats(videos);
  list.replaceChildren(...videos.map(renderVideo));
  empty.hidden = videos.length > 0;
  clearBtn.hidden = videos.length === 0;
}

// Confirmation by a second click: confirm() in an extension popup is
// unreliable (the popup may close and confirm() returns false).
const CLEAR_LABEL = clearBtn.textContent;
let clearArmed = null;

clearBtn.addEventListener('click', async () => {
  if (!clearArmed) {
    clearBtn.textContent = 'click again to delete';
    clearArmed = setTimeout(() => {
      clearArmed = null;
      clearBtn.textContent = CLEAR_LABEL;
    }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  clearBtn.textContent = CLEAR_LABEL;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(VIDEO_KEY_PREFIX)));
});

// Keep statuses live while the popup is open (e.g. a summary just finished).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(VIDEO_KEY_PREFIX))) renderVideos();
});

fill({ ...(await getPrompts()), ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) });
await renderVideos();
