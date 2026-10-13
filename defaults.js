// Shared by background.js and popup.js.

// The verdict words are matched literally in Gemini's answer (see classify()
// in content_gemini.js), so custom prompts must keep asking for them.
// Summaries and quizzes are requested in Russian on purpose.
export const DEFAULT_PROMPTS = {
  prompt_1:
    "Analyze the video at the link and reply with exactly one word: 'ENTERTAINMENT' if it is just for fun, or 'USEFUL' if it has educational or instructive content. Link: ",
  prompt_2:
    'Great. Now write a detailed summary of this video and a 3-question quiz to check understanding. Write your answer in Russian.',
  // Placeholders: {part} {total} {start} {end} {chapters} {url}
  prompt_3:
    'Now write a 5-question quiz to reinforce the material covered ONLY in part {part} of {total} of this video, from {start} to {end}{chapters}. Use multiple-choice questions and put the correct answers with short explanations at the very end, after all questions. Write in Russian. Video: {url}',
};

export async function getPrompts() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_PROMPTS));
  return { ...DEFAULT_PROMPTS, ...stored };
}

// Per-video state lives in chrome.storage.local under `video:<videoId>`.
export const VIDEO_KEY_PREFIX = 'video:';
