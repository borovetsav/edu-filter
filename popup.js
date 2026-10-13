import { DEFAULT_PROMPTS, getPrompts, VIDEO_KEY_PREFIX } from './defaults.js';

// ---------- Промпты ----------

const fields = Object.keys(DEFAULT_PROMPTS).map((key) => document.getElementById(key));
const status = document.getElementById('status');

function fill(values) {
  for (const el of fields) el.value = values[el.id];
}

function flash(text) {
  status.textContent = text;
  setTimeout(() => (status.textContent = ''), 1500);
}

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(fields.map((el) => [el.id, el.value]));
  await chrome.storage.local.set(values);
  flash('Сохранено');
});

document.getElementById('reset').addEventListener('click', async () => {
  fill(DEFAULT_PROMPTS);
  await chrome.storage.local.set(DEFAULT_PROMPTS);
  flash('Сброшено');
});

// ---------- История полезных видео ----------

const list = document.getElementById('videos');
const empty = document.getElementById('empty');
const clearBtn = document.getElementById('clear');

const STATUS_TEXT = {
  PENDING: { text: 'Gemini анализирует видео…' },
  USEFUL: { text: 'Конспект и тест готовятся…' },
  SUMMARY_DONE: { text: 'Конспект и тест готовы', cls: 'ready' },
  UNKNOWN: { text: 'Не удалось распознать ответ Gemini', cls: 'error' },
  ERROR: { text: 'Ошибка', cls: 'error' },
};

async function getVideos() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(VIDEO_KEY_PREFIX))
    .map(([key, state]) => ({ videoId: key.slice(VIDEO_KEY_PREFIX.length), ...state }))
    // Развлекательные не показываем. Сбои (UNKNOWN, ERROR) показываем всегда,
    // чтобы было видно, что пошло не так.
    .filter((v) => v.status !== 'FUN')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

  const s = STATUS_TEXT[v.status] ?? { text: v.status };
  const meta = document.createElement('div');
  meta.className = `meta ${s.cls ?? ''}`;
  meta.textContent = [s.text, formatDate(v.createdAt)].filter(Boolean).join(' · ');

  info.append(link, meta);
  if ((v.status === 'ERROR' || v.status === 'UNKNOWN') && v.detail) {
    const detail = document.createElement('div');
    detail.className = 'meta error';
    detail.textContent = v.status === 'UNKNOWN' ? `Gemini ответил: «${v.detail}»` : v.detail;
    info.append(detail);
  }
  li.append(info);

  // Чат доступен, как только открыта вкладка Gemini, даже если вердикта ещё нет.
  if (v.tabId != null || v.chatUrl) {
    const open = document.createElement('button');
    open.className = 'open-chat';
    open.textContent = 'Открыть чат';
    open.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'OPEN_GEMINI_CHAT', videoId: v.videoId });
      window.close();
    });
    li.append(open);
  }
  return li;
}

async function renderVideos() {
  const videos = await getVideos();
  list.replaceChildren(...videos.map(renderVideo));
  empty.hidden = videos.length > 0;
  clearBtn.hidden = videos.length === 0;
}

// Подтверждение вторым нажатием: confirm() во всплывающем окне расширения
// ненадёжен (окно может закрыться, а confirm — вернуть false).
const CLEAR_LABEL = clearBtn.textContent;
let clearArmed = null;

clearBtn.addEventListener('click', async () => {
  if (!clearArmed) {
    clearBtn.textContent = 'нажмите ещё раз, чтобы удалить';
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

// Статусы обновляются, пока popup открыт (например, конспект дописался).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(VIDEO_KEY_PREFIX))) renderVideos();
});

fill(await getPrompts());
await renderVideos();
