# Edu Filter

**A Chrome extension that turns long YouTube lectures into summaries and quizzes with Google Gemini, one stretch at a time.**

![Chrome extension](https://img.shields.io/badge/Chrome-extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Gemini](https://img.shields.io/badge/Google-Gemini-8E75B2?logo=googlegemini&logoColor=white)
![No API key](https://img.shields.io/badge/API%20key-not%20needed-lightgrey)
![Vanilla JS](https://img.shields.io/badge/JavaScript-vanilla-F7DF1E?logo=javascript&logoColor=black)

Watching a 2-hour lecture is easy; remembering it is not. Every ~40 minutes of a lecture, Edu Filter offers a summary and a quiz on the part you just watched, so you review the material while it's fresh. Entertainment is left alone.

![Quiz card on a YouTube lecture](docs/quiz-card.png)

## How it works

![How it works](docs/how-it-works.svg)

1. **You watch a video.** Quiz breaks are placed every ~40 minutes of its timeline.
2. **About 2 minutes before the first break**, Gemini decides in a background tab whether the video is `USEFUL` or `ENTERTAINMENT`. You keep watching. A video you drop earlier is never sent.
3. **At each quiz break** of a useful video, a card appears in the top right corner. Breaks move to the nearest chapter start, so a quiz doesn't cut a topic in half. The video keeps playing. Skipping ahead past a break also shows the card: one card covers every stretch you skipped.
4. **Click "Summary and quiz"**. The same Gemini chat gets a request for that stretch only: a summary broken down by timestamps and a 7-question **interactive quiz**: Gemini's built-in quiz, where you click an answer and see right away whether it's correct. The questions check understanding rather than memory: applying an idea to a new example, explaining why, telling close concepts apart.

Short videos get a single card for the whole video near the end.

## Popup

<img src="docs/popup.png" alt="Edu Filter popup" width="420">

Every processed video, with its verdict and an **Open chat** button. If Gemini got it wrong, **Send again** asks once more.

## Install

1. `git clone https://github.com/borovetsav/edu-filter.git`
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Sign in to [gemini.google.com](https://gemini.google.com) in the same Chrome profile. Enabling the YouTube app in Gemini helps it see what's in the video.

No API key and no server: the extension drives the Gemini web app in your own browser.

## Settings

Click the extension icon → **Settings**. Changes are saved as you type.

| Setting | Default | |
|---|---|---|
| Quiz every | ~40 min | Distance between breaks on the video's timeline. The video is sent to Gemini about 2 minutes before the first one. |
| Questions per quiz | 7 | Number of questions in each quiz (1-20). |
| Prompt 1 | | Classification. Must ask for `USEFUL` or `ENTERTAINMENT`. |
| Prompt 2 | | Summary and quiz for a stretch. Placeholders: `{start}` `{end}` `{chapters}` `{url}` `{questions}`. Answers are in Russian by default; change that line for another language. |

## Troubleshooting

- **Nothing happens on YouTube.** After reloading the extension, reload the YouTube tab too. A video is processed once; use **Send again** in the popup to redo it.
- **The Gemini tab shows a status panel** in its bottom-left corner with the current step. Logs are in DevTools → Console, filter `[EduFilter]`.
- **"Timed out waiting for the input field".** You're signed out of Gemini, or a dialog covers the input.

<details>
<summary><b>Notes on automating Gemini</b></summary>

The extension drives Gemini's web interface rather than an API. Things that came up:

- In a background tab, Gemini keeps the answer hidden (`pending`, 0×0) until the tab is opened, so the script reads `textContent`, not `innerText`.
- Every answer starts with a screen-reader-only heading (`.cdk-visually-hidden`); it is skipped.
- Answer containers carry a `has-thoughts` class, so filtering by "thought" drops the answer. The answer itself is in `<message-content>`.
- Send and stop are one button in `div.send-button`, with a `submit` or `stop` class. Matching on classes works in any UI language.
- A click on send is sometimes ignored, so each send is verified and retried up to 3 times.
- Prompts are queued: a quiz request can arrive while Gemini is still answering.
- After an extension reload, the old script can no longer report back but still finishes its prompts; videos left in progress are marked as failed.

All selectors are at the top of `content_gemini.js`.

</details>

## Project structure

```
manifest.json       MV3 manifest
background.js       Service worker: Gemini tabs, per-video state
content_yt.js       YouTube: watch time, quiz breaks, cards
content_gemini.js   Gemini: sends prompts, reads answers
popup.html / .js    Video history and settings
defaults.js         Default prompts and settings
```

## Limitations

- Needs a signed-in Gemini session; prompts and answers stay in your Gemini history.
- Gemini and YouTube change their pages; selectors may need updates.
- Chapters from the video's chapter list work best; timestamps in the description are a fallback.
