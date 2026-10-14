// Shared by background.js and popup.js (content_yt.js keeps its own copy
// of DEFAULT_SETTINGS: content scripts cannot import modules).

// The verdict words are matched literally in Gemini's answer (see classify()
// in content_gemini.js), so custom prompts must keep asking for them.
// Summaries and quizzes are requested in Russian on purpose.
export const DEFAULT_PROMPTS = {
  prompt_1:
    "Analyze the video at the link and reply with exactly one word: 'ENTERTAINMENT' if it is just for fun, or 'USEFUL' if it has educational or instructive content. Link: ",
  prompt_2:
    'Great. Now write a detailed summary of this video and a 3-question quiz to check understanding. Write your answer in Russian.',
  // Filled in automatically for each quiz break. Placeholders:
  // {start} {end} {chapters} {url}, plus {part} {total} (break number).
  prompt_3:
    'Now write a 5-question quiz to reinforce the material covered ONLY in this video from {start} to {end}{chapters}. Use multiple-choice questions and put the correct answers with short explanations at the very end, after all questions. Write in Russian. Video: {url}',
};

export async function getPrompts() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_PROMPTS));
  return { ...DEFAULT_PROMPTS, ...stored };
}

// watch_threshold_min: minutes of actual watching before a video is sent to
// Gemini (a shorter video: once 90% of it was watched).
// Quiz breaks in useful videos: one every ~quiz_interval_min minutes of the
// video timeline, moved to the nearest chapter start within quiz_snap_min.
export const DEFAULT_SETTINGS = {
  watch_threshold_min: 10,
  quiz_interval_min: 40,
  quiz_snap_min: 10,
};

// Per-video state lives in chrome.storage.local under `video:<videoId>`.
export const VIDEO_KEY_PREFIX = 'video:';
