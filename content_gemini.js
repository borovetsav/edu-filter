// Injected by background.js into a gemini.google.com tab. Drives the chat:
// prompt_1 + URL -> wait for the verdict -> report it.
// Then sends extra prompts on request (summary and quiz for each stretch).
// background.js injects it only when no live copy answers EDU_PING.
(() => {
  const log = (...a) => console.log('[EduFilter/Gemini]', ...a);

  // Status panel in the corner of the page, for debugging without DevTools.
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

  // ---------- Selectors (most specific first) ----------
  // Send and stop are the same button inside div.send-button; the container
  // gets `submit` when there is text to send and `stop` while Gemini is
  // generating. Class-based selectors work regardless of the UI language;
  // the aria-label ones are fallbacks for an English UI.

  const INPUT_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    '.text-input-field [contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  const SEND_SELECTORS = [
    '.send-button.submit button',
    'button[data-test-id="send-button"]',
    'button[aria-label="Send message" i]',
  ];

  const STOP_SELECTORS = [
    '.send-button.stop button',
    'button[data-test-id="stop-button"]',
    'button[aria-label^="Stop" i]',
  ];

  // Containers of model answers. The first selector with matches wins so
  // nested elements are not counted twice.
  const RESPONSE_SELECTORS = [
    'model-response',
    '[data-test-id="model-response"]',
    '.model-response-text',
    'message-content',
    '[data-message-author-role="model"]',
  ];

  // The answer itself (without the thinking block) is in <message-content>.
  const ANSWER_SELECTORS = ['message-content', '.markdown-main-panel', '.model-response-text'];

  // Screen-reader-only text: in the DOM but not on screen. Every Gemini
  // answer has such a heading, and it appears before the answer does.
  const SCREEN_READER_ONLY_SELECTORS = [
    '.cdk-visually-hidden',
    '.visually-hidden',
    '.sr-only',
    '[class*="visually-hidden" i]',
  ].join(', ');

  // Sending is verified (see sendPrompt): wait SEND_SETTLE_MS after typing,
  // then up to SEND_CONFIRM_MS for proof the message went out, SEND_ATTEMPTS times.
  const SEND_SETTLE_MS = 1000;
  const SEND_CONFIRM_MS = 5000;
  const SEND_ATTEMPTS = 3;

  const VERDICT_USEFUL = 'USEFUL';
  const VERDICT_FUN = 'ENTERTAINMENT';
  // Gemini sometimes answers prompt_1 with nothing but the YouTube video
  // card. Then it is asked again, up to VERDICT_RETRIES times.
  const VERDICT_RETRY_PROMPT = `Answer with exactly one word: ${VERDICT_USEFUL} or ${VERDICT_FUN}.`;
  const VERDICT_RETRIES = 2;
  // How long a finished answer without the verdict word is waited on before asking again.
  const VERDICT_IDLE_MS = 20_000;

  // ---------- Utilities ----------

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

  // Resolves once predicate() returns a truthy value. MutationObserver reacts
  // to DOM changes; the interval covers changes that cause no mutations.
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
        reject(new Error(`Timed out waiting for ${label}`));
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

  // ---------- Input and sending ----------

  const findInput = () => queryFirstVisible(INPUT_SELECTORS);
  const isGenerating = () => !!queryFirstVisible(STOP_SELECTORS);
  const findSendButton = () =>
    queryFirstVisible(
      SEND_SELECTORS,
      (btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !btn.closest('.stop')
    );

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

    // Replace the whole content via execCommand so that Quill (Gemini's
    // editor) sees real input and updates its own state.
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);

    await sleep(300);
    if (!inputText(el).includes(text.trim().slice(0, 20))) {
      log('execCommand had no effect, writing to the DOM directly');
      el.replaceChildren(); // not innerHTML: Gemini enforces Trusted Types
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

  // A click can be ignored, e.g. when it lands before Gemini's editor state
  // catches up with the typed text (seen with a canvas document open in a
  // tab that had just been focused). So every attempt is verified: the
  // message counts as sent once a new user query appears or the input clears.
  async function sendPrompt(text) {
    // Never type into the chat while an answer is still streaming: the
    // button is a stop button at that moment.
    await waitFor(() => !isGenerating(), 10 * 60_000, 'the previous answer to finish');
    const input = await waitFor(findInput, 30_000, 'the input field');
    showStatus(`input found, typing: "${text.slice(0, 60)}..."`);
    await setInputText(input, text);

    const queriesBefore = document.querySelectorAll('user-query').length;
    const wasSent = () => document.querySelectorAll('user-query').length > queriesBefore || !inputText(input);
    await waitFor(findSendButton, 10_000, 'the send button').catch(() => null);

    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      await sleep(SEND_SETTLE_MS);
      const button = findSendButton();
      const how = button ? 'send button' : 'Enter key';
      if (button) button.click();
      else pressEnter(input);

      const sent = await waitFor(wasSent, SEND_CONFIRM_MS, 'the message to be sent').then(() => true, () => false);
      if (sent) {
        showStatus(`sent with the ${how}${attempt > 1 ? ` on attempt ${attempt}` : ''}`);
        return;
      }
      showStatus(`attempt ${attempt}/${SEND_ATTEMPTS}: used the ${how}, but the message is still in the input`);
    }
    throw new Error('The prompt was typed, but Gemini did not send it');
  }

  // ---------- Model answers ----------

  function getResponses() {
    for (const sel of RESPONSE_SELECTORS) {
      const list = document.querySelectorAll(sel);
      if (list.length) return [...list];
    }
    return [];
  }

  // Text is read from the DOM (textContent), not "as seen on screen": in a
  // BACKGROUND tab Gemini puts the answer into the DOM but keeps it hidden
  // (class `pending`, 0x0 size) until the tab is opened, so innerText and
  // visibility checks see nothing there.
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
    // An empty answer block means the model is still thinking: return nothing
    // rather than the whole response, whose thinking text may quote the prompt.
    for (const sel of ANSWER_SELECTORS) {
      const blocks = el.querySelectorAll(sel);
      if (blocks.length) return [...blocks].map(domText).filter(Boolean).join(' ');
    }
    return domText(el);
  }

  // Waits for a new answer and then for it to finish: its text has not
  // changed for quietMs. Only the answer is observed, not the whole page,
  // which mutates constantly. A visible stop button extends the wait, but at
  // most to maxStopWaitMs in case the selector catches the wrong element.
  // isComplete(text) is an extra readiness check, e.g. "the verdict word is
  // there": a long thinking pause must not count as the end of the answer.
  // With idleMs set, an answer that never passes isComplete is still returned
  // once Gemini has stopped generating and the text has not changed for idleMs.
  async function waitForNewResponse(
    prevCount,
    { step, isComplete = () => true, idleMs = null, quietMs = 3000, maxStopWaitMs = 20_000, timeoutMs = 5 * 60_000 } = {}
  ) {
    showStatus(`${step}: waiting for an answer (answers on page: ${prevCount})`);
    await waitFor(() => getResponses().length > prevCount, 90_000, 'an answer to appear');
    showStatus(`${step}: answer started, waiting for it to finish`);

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
          `${step}: waiting for the answer to finish\n` +
          `read ${text.length} chars: "${preview}"\n` +
          `unchanged for ${Math.round(stable / 1000)} s, stop button: ${generating ? 'yes' : 'no'}`;
        const logNow = now - lastLog > 10_000;
        if (logNow) lastLog = now;
        showStatus(state, { silent: !logNow });

        const settled = stable >= quietMs && (!generating || stable >= maxStopWaitMs);
        const gaveUp = idleMs != null && !generating && stable >= idleMs;
        const done = text && ((isComplete(text) && settled) || gaveUp);
        if (done) {
          if (generating) log('stop button still visible but the text is stable, treating the answer as done');
          cleanup();
          resolve(text);
        } else if (now - startedAt > timeoutMs) {
          cleanup();
          reject(new Error(`Timed out waiting for the answer to finish (read: "${preview}", stop=${generating})`));
        }
      };

      // The observer reacts quickly to changes in the answer; the interval
      // checks for silence and covers the answer being re-rendered.
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

  // ---------- Classification ----------

  // The verdict comes first in the answer; later text (e.g. the YouTube card
  // with the video title) may contain either word, so the first one wins.
  function classify(text) {
    const upper = text.toUpperCase();
    const useful = upper.indexOf(VERDICT_USEFUL);
    const fun = upper.indexOf(VERDICT_FUN);
    if (useful === -1 && fun === -1) return 'UNKNOWN';
    if (fun === -1) return 'USEFUL';
    if (useful === -1) return 'FUN';
    return useful < fun ? 'USEFUL' : 'FUN';
  }

  // ---------- Scenarios ----------

  // Prompts run one at a time: a quiz request may arrive while the summary
  // is still being written.
  let queue = Promise.resolve();
  const enqueue = (task) => (queue = queue.then(task, task));

  let currentVideoUrl = null;

  // After an extension reload this script is orphaned and sendMessage throws
  // synchronously ("Extension context invalidated"). The chat itself is still
  // fine, so the prompts already handed over keep going; only the result is
  // lost, and the background marks such videos as failed on reload.
  function notify(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      showStatus('the extension was reloaded: this result is not saved, the chat goes on');
    }
  }

  // chatUrl is the conversation address (Gemini switches to /app/<id> after
  // the first message), so the user can get back to this exact chat.
  function report(status, detail) {
    showStatus(`result: ${status}${detail ? `\n${detail}` : ''}`);
    notify({ type: 'GEMINI_RESULT', status, detail, videoUrl: currentVideoUrl, chatUrl: location.href });
  }

  async function run({ videoUrl, prompt_1 }) {
    currentVideoUrl = videoUrl;
    try {
      // Step 1
      showStatus('step 1: looking for the input field');
      const before1 = getResponses().length;
      await sendPrompt(`${prompt_1} ${videoUrl}`);

      // Step 2
      const hasVerdict = (text) => classify(text) !== 'UNKNOWN';
      let answer = await waitForNewResponse(before1, { step: 'step 2', isComplete: hasVerdict, idleMs: VERDICT_IDLE_MS });
      for (let retry = 1; !hasVerdict(answer) && retry <= VERDICT_RETRIES; retry++) {
        showStatus(`step 2: no verdict in "${answer.slice(0, 60)}", asking again (${retry}/${VERDICT_RETRIES})`);
        const before = getResponses().length;
        await sendPrompt(VERDICT_RETRY_PROMPT);
        answer = await waitForNewResponse(before, { step: 'step 2 (retry)', isComplete: hasVerdict, idleMs: VERDICT_IDLE_MS });
      }
      const verdict = classify(answer);
      showStatus(`answer to prompt_1: "${answer.slice(0, 80)}" -> ${verdict}`);

      // No whole-video summary: summaries and quizzes come per stretch,
      // when the YouTube page reaches a quiz break.
      report({ USEFUL: 'USEFUL', FUN: 'FUN' }[verdict] ?? 'UNKNOWN', answer.slice(0, 200));
    } catch (err) {
      report('ERROR', String(err?.message || err));
    }
  }

  async function sendExtraPrompt({ prompt, label, meta }) {
    const result = (status, detail) => {
      showStatus(`${label}: ${status}${detail ? `\n${detail}` : ''}`);
      notify({ type: 'GEMINI_PROMPT_RESULT', label, status, detail, meta });
    };
    try {
      // A chat reopened from its URL renders its history a moment after the
      // page loads; count answers only once it is there.
      if (/^\/app\/[^/]+/.test(location.pathname)) {
        await waitFor(() => getResponses().length > 0, 20_000, 'the chat history').catch(() => {});
      }
      const before = getResponses().length;
      await sendPrompt(prompt);
      await waitForNewResponse(before, { step: label, quietMs: 4000, timeoutMs: 10 * 60_000 });
      result('DONE');
    } catch (err) {
      result('ERROR', String(err?.message || err));
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EDU_PING') sendResponse(true);
    else if (msg?.type === 'RUN_GEMINI') enqueue(() => run(msg));
    else if (msg?.type === 'SEND_PROMPT') enqueue(() => sendExtraPrompt(msg));
  });
})();
