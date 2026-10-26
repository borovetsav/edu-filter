# Privacy policy

Edu Filter does not collect, sell or share any data with its developer or any third party. It has no server, no analytics and no tracking.

## What the extension reads

On YouTube watch pages, it reads the video's address, title, length, chapters and your playback position. This is used to decide when to show a quiz break.

## Where data goes

- **Your own Gemini.** To make a summary and a quiz (and, if you turn that on, to classify a video), the extension opens [gemini.google.com](https://gemini.google.com) in your browser and sends the video's address and a prompt there, from your own signed-in Google account. These chats are stored in your Gemini history like any chat you type yourself and are covered by [Google's privacy policy](https://policies.google.com/privacy).
- **Your browser.** The list of processed videos (address, title, status, quiz progress) and your settings are kept in your browser's extension storage (`chrome.storage.local`). They never leave your computer. **Clear history** in the popup deletes the list; removing the extension deletes everything.

Nothing else is sent anywhere.

## Permissions

- `storage`: keeps your settings and the list of processed videos.
- `scripting`: adds the script that types prompts and reads answers in the Gemini tab.
- Access to `youtube.com`: shows quiz breaks on lecture videos.
- Access to `gemini.google.com`: sends prompts to your Gemini and reads the answers.

## Contact

Questions: open an issue at [github.com/borovetsav/edu-filter](https://github.com/borovetsav/edu-filter/issues).

Last updated: October 24, 2026.
