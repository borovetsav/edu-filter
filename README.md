# Edu Filter

**Remember the lectures you watch.** A Chrome extension that adds quiz breaks to long YouTube lectures: every ~40 minutes, a summary and an interactive quiz in Google Gemini.

![Chrome extension](https://img.shields.io/badge/Chrome-extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Gemini](https://img.shields.io/badge/Google-Gemini-8E75B2?logo=googlegemini&logoColor=white)
![No API key](https://img.shields.io/badge/API%20key-not%20needed-lightgrey)
![Free](https://img.shields.io/badge/price-free-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

https://github.com/user-attachments/assets/fd4e0c6f-3b4d-407b-8fb6-6d99a0d70441

## Why

We spend hours on great lectures, and within days most of it is gone. Education is the best thing in the world, so everything you learn deserves to stick. Testing yourself is the most reliable way to make it stick:

- **Testing beats re-reading:** a week later, 61% recalled vs 40% ([Roediger & Karpicke, 2006](https://psychology.ecu.edu/wp-content/pv-uploads/sites/216/2019/03/Roediger-Karpicke-2006.pdf)).
- **Quizzes inside a video lecture** halved mind-wandering and improved learning ([Szpunar, Khan & Schacter, 2013](https://pmc.ncbi.nlm.nih.gov/articles/PMC3631699/)).
- **Recall builds understanding,** even on inference questions ([Karpicke & Blunt, 2011](https://www.purdue.edu/newsroom/research/2011/110120KarpickeScience.html)).

## How it works

![How it works](docs/how-it-works.svg)

1. **Watch** any lecture on YouTube.
2. **A card appears at each break.** The video keeps playing. Not a lecture? Click **Not for this video**, or switch quizzes off for it in the popup.
3. **Click "Summary and quiz":** Gemini opens with a summary by timestamps and a clickable quiz that tests understanding, not recall. Gemini opens only at this point, when you ask for a quiz.

## Install

1. Download [**edu-filter.zip**](https://github.com/borovetsav/edu-filter/releases/latest/download/edu-filter.zip) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the unzipped folder.
3. Sign in to [gemini.google.com](https://gemini.google.com) in the same Chrome profile.

That's it: no API key, no server, free. The extension uses the Gemini web app in your own browser. Made for Chrome; other Chromium browsers (Edge, Brave, Arc) should work too.

If Edu Filter helped a lecture stick, a ⭐ helps other learners find it.

## Screenshots

![Quiz card on a YouTube lecture](docs/quiz-card.png)

<p>
  <img src="docs/popup.png" alt="Popup: processed videos" width="380">
  <img src="docs/settings.png" alt="Popup: settings" width="380">
</p>

## Settings

Click the extension icon → **Settings**. Changes are saved as you type.

| Setting | Default | |
|---|---|---|
| Quiz every | ~40 min | Distance between breaks. Breaks move to the nearest chapter start, so a quiz doesn't cut a topic in half. |
| Questions per quiz | 7 | 1-20. |
| Answer language | English | Language of summaries and quizzes: pick a common one from the list, or **Other…** to type any language Gemini understands. |
| Gemini opens | only when I ask for a quiz | Or **to check every video**: Gemini checks in a background tab whether a video is educational, about 2 minutes before the first break, and the tab closes once it answers. Cards then wait for the verdict. An entertainment video still gets a card, worded "Quiz anyway?". |
| Prompts | | Classification (must ask for `USEFUL` or `ENTERTAINMENT`) and summary + quiz (placeholders `{start}` `{end}` `{chapters}` `{url}` `{questions}` `{language}`). |

Skipping ahead past a break also shows the card; one card covers every stretch you skipped. Videos too short for a break get one card near the end, if they are at least 10 minutes long, Gemini called them educational, or you turned quizzes on in the popup.

## Troubleshooting

- **Nothing happens on YouTube.** After reloading the extension, reload the YouTube tab too. Quizzes may be off for this video: open the popup on its tab and click **Turn on**. A video is checked once; use **Send again** in the popup to redo it.
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

<details>
<summary><b>Project structure</b></summary>

```
manifest.json       MV3 manifest
background.js       Service worker: Gemini tabs, per-video state
content_yt.js       YouTube: quiz breaks, cards
content_gemini.js   Gemini: sends prompts, reads answers
popup.html / .js    Video history and settings
defaults.js         Default prompts and settings
```

</details>

## Limitations

- Needs a signed-in Gemini session; prompts and answers stay in your Gemini history. Nothing is sent anywhere else: see the [privacy policy](PRIVACY.md).
- Gemini and YouTube change their pages; selectors may need updates.

## License

[MIT](LICENSE)
