# edu-filter

A Chrome extension (Manifest V3) that turns the YouTube videos you actually watch into study material.

After you've watched a video for 10 minutes (configurable), the extension asks [Gemini](https://gemini.google.com), in a background tab, whether the video is educational or just entertainment. Then, every ~40 minutes of a useful video's timeline (configurable), a card in the top right corner offers a summary and a quiz for the stretch you just watched, without stopping the video. There is no summary of the whole video: each stretch gets its own, broken down by timestamps.

## How it works

1. **Watch-time tracking (`content_yt.js`).** The extension counts the seconds a video is actually playing. Pauses, seeking and ads don't count. The counter resets when you move to another video. YouTube is a single-page app, so the extension listens for `yt-navigate-finish` to notice the change. Once you've watched it for N minutes (**Send a video to Gemini after N minutes of watching**, default 10), it fires once for that video. A video shorter than N minutes counts once 90% of it was watched. The idea: a video you keep watching is worth remembering, one you drop after 3 minutes is not.
2. **Background tab (`background.js`).** The extension opens `gemini.google.com/app` in an inactive tab and injects the automation script into it. It then hands that script the video URL and your prompts.
3. **Gemini automation (`content_gemini.js`):**
   - **Step 1.** Sends prompt 1 together with the video URL. Gemini is asked to answer with a single word: `USEFUL` or `ENTERTAINMENT`.
   - **Step 2.** Waits for Gemini to finish answering and reads the verdict.
   - That's all for now: the summaries and quizzes are requested later, one stretch at a time.
4. **Quiz breaks** (see [below](#quiz-breaks)) offer a summary and a quiz for each ~40-minute stretch of the video once you reach its end.
5. **Coming back to the chat:**
   - **Short videos.** A useful video too short for a break gets the same card 15 seconds before its end, for the whole video.
   - **Popup.** Clicking the extension icon shows every processed video with its status and an **Open chat** button. So you can still reach the chat if you closed the card.

## Quiz breaks

Useful videos get a quiz break every ~40 minutes of the video timeline. Both numbers below are set in the popup under **Settings**:

- **Quiz every N minutes** (default 40). Each break is placed about N minutes after the previous one.
- **Move the break to a chapter boundary within ±M minutes** (default 10). The break moves to the nearest chapter start in that window, so a quiz doesn't cut a topic in half. Chapters come from the video's chapter list, or from timestamps in the description if there is no list. If no chapter is close enough, the break stays at exactly N minutes.
- **The end of the video counts as the last break.** It is placed 15 seconds before the end. No break is placed where less than N/2 minutes would remain, so videos shorter than about 1.5 × N get no breaks, only one card for the whole video near its end.

**What triggers a break.** A break fires when the playhead moves forward past it, either by playing or by seeking ahead:

- **When it fires,** a card appears in the top right corner, next to the extension icon, with **Summary and quiz** and **Later**. The video keeps playing, and the card stays until you click one of them. Summary and quiz sends prompt 2 to the video's Gemini chat and switches to it; the prompt asks for a summary of that stretch only, broken down by timestamps, and a 5-question quiz on it, with the time range and chapter titles.
- **One seek across several breaks** shows one card, covering everything from the first skipped break's stretch.
- **Breaks need the verdict.** A break reached before the video passed the watch threshold and Gemini called it useful does not fire. With the defaults (10 and 40 minutes) the verdict is long in place by the first break.
- **Seeking backward never fires a break,** and each break fires once per page load.
- **The position a video opens at** (YouTube resuming where you left off, or a `&t=` link) is not a move, so no card appears on load.

Example: the 1:56 lecture [*Let's build GPT*](https://www.youtube.com/watch?v=kCc8FmEb1nY) with the defaults gets breaks at 38:00 and 1:16:56 (chapter starts closest to 40:00 and 1:18:00), plus the end. With "every 30 minutes, ±5" the breaks are at 34:53, 1:02:00 and 1:32:51.

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

Watch YouTube as usual. Once a video passes the watch threshold:

- A Gemini tab opens in the background.
- Its status shows up in the popup:
  - *Gemini is analyzing* — the first prompt has been sent;
  - *Useful: a summary and quiz at each quiz break* — the video was judged useful;
  - an error, with the reason.
- Once you request summaries and quizzes at breaks, the popup also shows how many are ready.
- Entertainment videos are listed too, so a wrong verdict is easy to spot.

Each video is processed only once, and the history is kept across browser restarts. If Gemini judged a video as entertainment, or its processing failed, click **Send again** next to it in the popup: the video goes to Gemini again in a new chat, and once it is judged useful its quiz breaks appear on the open YouTube tab within a few seconds. To start over completely, click **clear history** twice and reload the YouTube tab.

### Customizing prompts

Open the popup, expand **Settings** and edit the prompts. Every change is saved as you type (the popup closes on any click outside it, so nothing waits for the **Save** button). **Reset to defaults** restores the built-in prompts and quiz settings.

| Prompt | Purpose |
|---|---|
| `prompt_1` | Classification. The video URL is appended. |
| `prompt_3` (shown as Prompt 2) | Summary and quiz for one stretch, at a break. Filled in automatically; you don't need to change it. Placeholders: `{start}`, `{end}`, `{chapters}` (". Topics of this part: ..." or empty), `{url}`, and `{part}` / `{total}` (break number and count). |

By default, the summary-and-quiz prompt asks Gemini to answer in Russian. Change that line to get summaries in another language.

The classifier looks for the words `USEFUL` and `ENTERTAINMENT` in Gemini's answer, case-insensitively. If both appear, the first one wins, because the verdict comes before the YouTube card with the video title. If you rewrite `prompt_1`, keep asking Gemini to reply with one of these two words.

## Project structure

```
manifest.json       MV3 manifest: permissions, content scripts, popup
defaults.js         Default prompts and shared storage helpers
background.js       Service worker: opens the Gemini tab, injects the script, stores per-video state
content_yt.js       YouTube: watch time, quiz breaks, quiz cards
content_gemini.js   Gemini: sends prompts, waits for answers, classifies
popup.html/.js      Video history and prompt settings
```

Per-video state is kept in `chrome.storage.local` under keys like `video:<videoId>`. It includes the status, the verdict, the video title, the Gemini tab ID, the chat URL and the part-quiz statuses.

## Notes on automating Gemini

The extension drives Gemini's web interface rather than an API, so it depends on how that page is built. A few non-obvious details that came up during development:

- **Background tabs hide the answer.** In an inactive tab, Gemini adds the answer to the page but keeps it hidden (`pending` class, 0×0 size) until you open the tab. The script therefore reads the answer with `textContent`. `innerText` or a visibility check would see an empty answer.
- **There's a hidden heading in every answer.** It is meant for screen readers (`.cdk-visually-hidden`) and appears before the real answer, so the script skips it. Otherwise it would read the heading while the model is still thinking.
- **Don't filter by `thought`.** The answer containers carry a `has-thoughts` class, so dropping every element whose class contains "thought" would drop the answer too. The answer itself is in `<message-content>`.
- **Send and stop are the same button.**
  - It lives in `div.send-button`. The container gets `submit` when there's text to send and `stop` while Gemini is generating.
  - The script matches on these classes, so it works whatever language Gemini's interface uses.
  - It never sends while `stop` is present.
- **Sending is verified.** Gemini sometimes ignores a click on the send button, for example when a canvas document is open in a tab that was just focused. After each attempt the script checks that a new user message appeared or the input cleared, and retries up to 3 times.
- **Prompts are queued.** A part-quiz request can arrive while Gemini is still writing the summary, so the script waits until that answer is done.

All selectors are listed at the top of `content_gemini.js`, from the most specific to the most generic. If Gemini changes its page, start there.

## Troubleshooting

- **The Gemini tab shows a status panel in its bottom-left corner.** It shows the current step, what the script has read from the answer, and whether Gemini is still generating.
- **Logs:**
  - in the YouTube and Gemini tabs, open DevTools (F12) → Console and filter by `[EduFilter]`. For a video with quiz breaks, the YouTube log lists them;
  - for the background part, go to `chrome://extensions` → Edu Filter → **service worker**.
- **No Gemini tab opens.** Either the video is already in the history (clear it, see [Usage](#usage)), or the YouTube tab wasn't reloaded after you reloaded the extension. In the second case the old script on the page is disconnected and does nothing.
- **"Extension context invalidated" in the Gemini status panel.** The extension was reloaded while that tab was working. The script still finishes the prompts it already has, but their results are not saved: after a reload, videos and quizzes that were in progress are marked as failed, and **Send again** in the popup restarts a video.
- **"Timed out waiting for the input field".** You're signed out of Gemini, or a dialog is covering the input field.

## Limitations

- **You need a signed-in Gemini session in the same Chrome profile.** Your prompts and Gemini's answers are saved in your Gemini chat history.
- **Gemini's page can change at any time, and so can YouTube's.** When that happens, the selectors in `content_gemini.js` and `content_yt.js` may need updating. For example, YouTube has rendered chapter titles both as `h3` and as `h4`.
- **Some short videos won't show their card.** If Gemini's verdict arrives after the video has ended, the card isn't shown. The chat is still available from the popup.
- **Timestamps in the description are less reliable than the chapter list.** Descriptions often contain unrelated timestamps, so breaks are only as well placed as the chapters found.
