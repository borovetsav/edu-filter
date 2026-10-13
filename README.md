# edu-filter

A Chrome extension (Manifest V3) that turns the YouTube videos you actually watch into study material.

After you've watched a video for one minute, the extension asks [Gemini](https://gemini.google.com) whether the video is educational or just entertainment. For educational videos, it then asks Gemini for a detailed summary and a short quiz. It all happens in a background tab, so you don't have to stop watching.

## How it works

1. **Watch-time tracking (`content_yt.js`).** The extension counts the seconds a video is actually playing. Pauses, seeking and ads don't count. The counter resets when you move to another video. YouTube is a single-page app, so the extension listens for `yt-navigate-finish` to notice the change. After 60 seconds of watching, it fires once for that video.
2. **Background tab (`background.js`).** The extension opens `gemini.google.com/app` in an inactive tab and injects the automation script into it. It then hands that script the video URL and your two prompts.
3. **Gemini automation (`content_gemini.js`):**
   - **Step 1.** Sends prompt 1 together with the video URL. Gemini is asked to answer with a single word: `ПОЛЬЗА` (useful) or `РАЗВЛЕЧЕНИЕ` (entertainment).
   - **Step 2.** Waits for Gemini to finish answering and reads the verdict.
   - **Step 3.** If the verdict is useful, sends prompt 2 to get the summary and the quiz. If it's entertainment, it stops there.
4. **Coming back to the chat:**
   - **End-of-video card.** When a useful video has less than 15 seconds left, a card appears on YouTube with a button that opens the Gemini chat for that video.
   - **Popup.** Clicking the extension icon shows every processed video with its status and an **Open chat** button. So you can still reach the chat if you closed the card.

## Installation

1. Clone the repository:
   ```sh
   git clone git@github.com:borovetsav/edu-filter.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Sign in to [gemini.google.com](https://gemini.google.com) in the same Chrome profile.

For better results, enable the YouTube app in Gemini. Without it, Gemini can't see what's in the video and has to guess from the link.

## Usage

Watch YouTube as usual. After a minute of watching:

- A Gemini tab opens in the background.
- Its status shows up in the popup:
  - *Gemini is analyzing* — the first prompt has been sent;
  - *Summary and quiz in progress* — the video was judged useful and the second prompt has been sent;
  - *Ready* — the summary and quiz are done;
  - an error, with the reason.
- Entertainment videos don't appear in the list.

Each video is processed only once, and the history is kept across browser restarts. To process a video again, open the popup and click **очистить историю** (clear history) twice. Then reload the YouTube tab.

### Customizing prompts

Open the popup, expand **Настройки промптов** (prompt settings), edit the prompts and click **Сохранить** (save).

| Prompt | Default (Russian) | Purpose |
|---|---|---|
| `prompt_1` | *Analyze the video at the link and reply with exactly one word: 'РАЗВЛЕЧЕНИЕ' if it's just for fun, or 'ПОЛЬЗА' if it has educational content. Link:* | Classification. The video URL is appended. |
| `prompt_2` | *Great, now write a detailed summary of this video and a 3-question quiz to test understanding.* | Summary and quiz. |

The classifier looks for the words `ПОЛЬЗА` and `РАЗВЛЕЧЕНИЕ` in Gemini's answer, case-insensitively. If you rewrite `prompt_1`, keep asking Gemini to reply with one of these two words.

## Project structure

```
manifest.json       MV3 manifest: permissions, content scripts, popup
defaults.js         Default prompts and shared storage helpers
background.js       Service worker: opens the Gemini tab, injects the script, stores per-video state
content_yt.js       YouTube: watch-time counter and end-of-video card
content_gemini.js   Gemini: sends prompts, waits for answers, classifies
popup.html/.js      Video history and prompt settings
```

Per-video state is kept in `chrome.storage.local` under keys like `video:<videoId>`. It includes the status, the verdict, the video title, the Gemini tab ID and the chat URL.

## Notes on automating Gemini

The extension drives Gemini's web interface rather than an API, so it depends on how that page is built. A few non-obvious details that came up during development:

- **Background tabs hide the answer.** In an inactive tab, Gemini adds the answer to the page but keeps it hidden (`pending` class, 0×0 size) until you open the tab. The script therefore reads the answer with `textContent`. `innerText` or a visibility check would see an empty answer.
- **There's a hidden "Ответ Gemini" heading.** Every answer contains an invisible heading meant for screen readers. It appears before the real answer, so the script skips it. Otherwise it would read the heading while the model is still thinking.
- **Don't filter by `thought`.** The answer containers carry a `has-thoughts` class, so dropping every element whose class contains "thought" would drop the answer too.
- **The send button** is `.send-button > button[aria-label="Отправить сообщение"]`. Matching "send" anywhere in an aria-label also hits unrelated buttons.

All selectors are listed at the top of `content_gemini.js`, from the most specific to the most generic. If Gemini changes its page, start there.

## Troubleshooting

- **The Gemini tab shows a status panel in its bottom-left corner.** It shows the current step, what the script has read from the answer, and whether Gemini is still generating.
- **Logs:**
  - in the YouTube and Gemini tabs, open DevTools (F12) → Console and filter by `[EduFilter]`;
  - for the background part, go to `chrome://extensions` → Edu Filter → **service worker**.
- **No Gemini tab opens.** Either the video is already in the history (clear it, see [Usage](#usage)), or the YouTube tab wasn't reloaded after you reloaded the extension. In the second case the old script on the page is disconnected and does nothing.
- **"Таймаут ожидания: поле ввода" (timed out waiting for the input field).** You're signed out of Gemini, or a dialog is covering the input field.

## Limitations

- **You need a signed-in Gemini session in the same Chrome profile.** Your prompts and Gemini's answers are saved in your Gemini chat history.
- **Gemini's page can change at any time.** When it does, the selectors in `content_gemini.js` may need updating.
- **Some short videos won't show the end-of-video card.** If Gemini's verdict arrives after the video has ended, the card isn't shown. The chat is still available from the popup.
- **The interface and default prompts are in Russian.**
