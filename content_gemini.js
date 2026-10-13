// Инжектится background.js во вкладку gemini.google.com и ведёт диалог:
// prompt_1 + URL → ждём ответ → если «ПОЛЬЗА», отправляем prompt_2.
(() => {
  if (window.__eduFilterGeminiLoaded) return;
  window.__eduFilterGeminiLoaded = true;

  const log = (...a) => console.log('[EduFilter/Gemini]', ...a);

  // Табличка в углу страницы: на каком шаге скрипт и что он видит.
  // Нужна для отладки без DevTools.
  let overlay = null;
  function showStatus(text, { silent = false } = {}) {
    if (!silent) log(text);
    if (!overlay?.isConnected) {
      overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        maxWidth: '460px',
        padding: '8px 12px',
        borderRadius: '8px',
        background: 'rgba(32, 33, 36, 0.92)',
        color: '#fff',
        font: '12px/1.45 ui-monospace, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
      });
      document.body.appendChild(overlay);
    }
    overlay.textContent = `EduFilter\n${text}`;
  }

  // ---------- Селекторы (от самых специфичных к самым общим) ----------
  // Разметка Gemini меняется, поэтому для каждого элемента — список вариантов.

  const INPUT_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    '.text-input-field [contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  // Сейчас (окт. 2026) это <div class="send-button …"><button aria-label=
  // "Отправить сообщение">. Подписи сверяем целиком или по началу: у Gemini
  // есть посторонние кнопки, где «send» встречается внутри длинного текста.
  const SEND_SELECTORS = [
    '.send-button button',
    'button.send-button',
    'button[data-test-id="send-button"]',
    '.send-button-container button',
    'button[aria-label="Отправить сообщение" i]',
    'button[aria-label="Send message" i]',
    'button[aria-label^="Отправить" i]',
    'button[aria-label^="Send" i]',
  ];

  const STOP_SELECTORS = [
    'button.send-button.stop',
    'button[data-test-id="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Остановить" i]',
    'button[mattooltip*="Stop" i]',
    'button[mattooltip*="Остановить" i]',
  ];

  // Контейнеры ответов модели. Берётся первый селектор, давший совпадения,
  // чтобы вложенные элементы не считались дважды.
  const RESPONSE_SELECTORS = [
    'model-response',
    '[data-test-id="model-response"]',
    '.model-response-text',
    'message-content',
    '.response-content',
    '[data-message-author-role="model"]',
  ];

  const STOP_RE = /stop|останов/i;

  // ---------- Утилиты ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function queryFirstVisible(selectors, filter = () => true) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el) && filter(el)) return el;
      }
    }
    return null;
  }

  // Ждёт, пока predicate() вернёт truthy-значение. MutationObserver реагирует
  // на изменения DOM, интервал — страховка на случай изменений без мутаций.
  function waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const initial = predicate();
      if (initial) return resolve(initial);

      const check = () => {
        const result = predicate();
        if (result) {
          cleanup();
          resolve(result);
        }
      };
      const observer = new MutationObserver(check);
      const interval = setInterval(check, 1000);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Таймаут ожидания: ${label}`));
      }, timeoutMs);
      function cleanup() {
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(timer);
      }
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });
  }

  // ---------- Поле ввода и отправка ----------

  const findInput = () => queryFirstVisible(INPUT_SELECTORS);

  function isStopButton(btn) {
    return (
      btn.classList.contains('stop') ||
      STOP_RE.test(btn.getAttribute('aria-label') || '') ||
      STOP_RE.test(btn.getAttribute('mattooltip') || '')
    );
  }

  const findSendButton = () =>
    queryFirstVisible(
      SEND_SELECTORS,
      (btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !isStopButton(btn)
    );

  const isGenerating = () => !!queryFirstVisible(STOP_SELECTORS);

  function inputText(el) {
    return (el.value ?? el.innerText ?? '').trim();
  }

  async function setInputText(el, text) {
    el.focus();

    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Выделяем всё содержимое и заменяем его через execCommand — так Quill
    // (редактор Gemini) получает «настоящий» ввод и обновляет своё состояние.
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);

    await sleep(300);
    if (!inputText(el).includes(text.trim().slice(0, 20))) {
      // Запасной вариант: прямая запись в DOM + событие input.
      log('execCommand не сработал, пишу в DOM напрямую');
      el.replaceChildren(); // не innerHTML: Gemini требует Trusted Types
      const p = document.createElement('p');
      p.textContent = text;
      el.appendChild(p);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function sendPrompt(text) {
    const input = await waitFor(findInput, 30_000, 'поле ввода');
    showStatus(`поле ввода найдено, вставляю: «${text.slice(0, 60)}…»`);
    await setInputText(input, text);

    try {
      const button = await waitFor(findSendButton, 10_000, 'кнопка отправки');
      button.click();
      showStatus('отправлено кликом по кнопке');
    } catch {
      showStatus('кнопка отправки не найдена, эмулирую Enter');
      pressEnter(input);
    }
  }

  // ---------- Ответы модели ----------

  function getResponses() {
    for (const sel of RESPONSE_SELECTORS) {
      const list = document.querySelectorAll(sel);
      if (list.length) return [...list];
    }
    return [];
  }

  // Элементы «только для скринридеров»: на экране их нет, но в DOM есть текст.
  // В каждом ответе Gemini лежит скрытый заголовок «Ответ Gemini», который
  // появляется раньше самого ответа.
  const SCREEN_READER_ONLY_SELECTORS = [
    '.cdk-visually-hidden',
    '.visually-hidden',
    '.sr-only',
    '[class*="visually-hidden" i]',
  ].join(', ');

  // Сам текст ответа (без блока рассуждений) лежит в <message-content>.
  const ANSWER_SELECTORS = ['message-content', '.markdown-main-panel', '.model-response-text'];

  // Текст читаем из DOM (textContent), а не «как видно на экране»: во
  // ФОНОВОЙ вкладке Gemini кладёт ответ в разметку, но держит его скрытым
  // (класс pending, размер 0×0), пока вкладку не откроют. innerText и
  // проверки видимости в фоне видят пустоту.
  function domText(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue.trim();
      if (value && !node.parentElement?.closest(SCREEN_READER_ONLY_SELECTORS)) parts.push(value);
    }
    return parts.join(' ');
  }

  function responseText(el) {
    // Если блок ответа есть, но пуст (модель ещё думает) — возвращаем пустоту,
    // а не весь ответ: в рассуждениях могут встречаться оба слова из промпта.
    for (const sel of ANSWER_SELECTORS) {
      const blocks = el.querySelectorAll(sel);
      if (blocks.length) return [...blocks].map(domText).filter(Boolean).join(' ');
    }
    return domText(el);
  }

  // Ждём появления нового ответа, затем — окончания генерации: текст последнего
  // ответа не менялся quietMs. Следим только за самим ответом, а не за всей
  // страницей: в интерфейсе Gemini постоянно что-то мутирует.
  // Кнопка «Стоп» лишь продлевает ожидание, но не дольше maxStopWaitMs —
  // на случай, если селектор поймал посторонний элемент.
  // isComplete(text) — дополнительное условие готовности. Для шага 2 это
  // «в ответе уже есть ПОЛЬЗА или РАЗВЛЕЧЕНИЕ»: модель Pro может долго думать,
  // и пауза до начала ответа не должна считаться его концом.
  async function waitForNewResponse(
    prevCount,
    { step, isComplete = () => true, quietMs = 3000, maxStopWaitMs = 20_000, timeoutMs = 5 * 60_000 } = {}
  ) {
    showStatus(`${step}: жду появления ответа (ответов на странице: ${prevCount})`);
    await waitFor(() => getResponses().length > prevCount, 90_000, 'появление ответа');
    showStatus(`${step}: ответ появился, жду завершения генерации`);

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let lastText = '';
      let lastChange = Date.now();
      let lastLog = 0;

      const lastResponse = () => getResponses().at(-1);

      const check = () => {
        const el = lastResponse();
        const text = el ? responseText(el) : '';
        const now = Date.now();
        if (text !== lastText) {
          lastText = text;
          lastChange = now;
        }
        const stable = now - lastChange;
        const generating = isGenerating();

        const preview = text.replace(/\s+/g, ' ').slice(-80);
        const state =
          `${step}: жду конца ответа\n` +
          `прочитано ${text.length} симв.: «${preview}»\n` +
          `без изменений ${Math.round(stable / 1000)} с, кнопка «Стоп»: ${generating ? 'да' : 'нет'}`;
        const logNow = now - lastLog > 10_000;
        if (logNow) lastLog = now;
        showStatus(state, { silent: !logNow });

        const done =
          text && isComplete(text) && stable >= quietMs && (!generating || stable >= maxStopWaitMs);
        if (done) {
          if (generating) log('кнопка «Стоп» всё ещё видна, но текст давно не меняется — считаю ответ готовым');
          cleanup();
          resolve(text);
        } else if (now - startedAt > timeoutMs) {
          cleanup();
          reject(new Error(`Таймаут ожидания завершения ответа (прочитано: «${preview}», «Стоп»=${generating})`));
        }
      };

      // MutationObserver на самом ответе даёт быструю реакцию на изменения,
      // интервал — проверку «тишины» (и страховку, если ответ перерисовали).
      let scheduled = null;
      const observer = new MutationObserver(() => {
        scheduled ??= setTimeout(() => {
          scheduled = null;
          check();
        }, 200);
      });
      const interval = setInterval(check, 1000);
      const target = lastResponse();
      if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });

      function cleanup() {
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(scheduled);
      }

      check();
    });
  }

  // ---------- Классификация ----------

  function classify(text) {
    const upper = text.toUpperCase();
    const useful = upper.indexOf('ПОЛЬЗА');
    const fun = upper.indexOf('РАЗВЛЕЧЕНИЕ');
    if (useful === -1 && fun === -1) return 'UNKNOWN';
    if (fun === -1) return 'USEFUL';
    if (useful === -1) return 'FUN';
    // Оба слова (например, видны рассуждения): итоговый ответ — в конце.
    return upper.lastIndexOf('ПОЛЬЗА') > upper.lastIndexOf('РАЗВЛЕЧЕНИЕ') ? 'USEFUL' : 'FUN';
  }

  // ---------- Основной сценарий ----------

  let currentVideoUrl = null;

  // chatUrl — адрес текущего диалога (после первого сообщения Gemini меняет
  // его на /app/<id>), чтобы потом можно было вернуться именно в этот чат.
  function report(status, detail) {
    showStatus(`итог: ${status}${detail ? `\n${detail}` : ''}`);
    chrome.runtime
      .sendMessage({ type: 'GEMINI_RESULT', status, detail, videoUrl: currentVideoUrl, chatUrl: location.href })
      .catch(() => {});
  }

  let running = false;

  async function run({ videoUrl, prompt_1, prompt_2 }) {
    if (running) return;
    running = true;
    currentVideoUrl = videoUrl;
    try {
      // Шаг 1
      showStatus('шаг 1: ищу поле ввода');
      const before1 = getResponses().length;
      await sendPrompt(`${prompt_1} ${videoUrl}`);

      // Шаг 2
      const answer = await waitForNewResponse(before1, {
        step: 'шаг 2',
        isComplete: (text) => classify(text) !== 'UNKNOWN',
      });
      const verdict = classify(answer);
      showStatus(`ответ на prompt_1: «${answer.slice(-80)}» → ${verdict}`);

      if (verdict !== 'USEFUL') {
        report(verdict === 'FUN' ? 'FUN' : 'UNKNOWN', answer.slice(0, 200));
        return;
      }

      report('USEFUL', answer.slice(0, 200));

      // Шаг 3
      showStatus('шаг 3: отправляю prompt_2');
      const before2 = getResponses().length;
      await sendPrompt(prompt_2);
      await waitForNewResponse(before2, { step: 'шаг 3', quietMs: 4000, timeoutMs: 10 * 60_000 });
      report('SUMMARY_DONE', videoUrl);
    } catch (err) {
      report('ERROR', String(err?.message || err));
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'RUN_GEMINI') run(msg);
  });
})();
