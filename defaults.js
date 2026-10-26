// Shared by background.js and popup.js (content_yt.js keeps its own copy
// of DEFAULT_SETTINGS: content scripts cannot import modules).

// The verdict words are matched literally in Gemini's answer (see classify()
// in content_gemini.js), so custom prompts must keep asking for them.
// Summaries and quizzes are requested in English; edit the prompt for
// another language.
// prompt_1 only classifies the video; summaries and quizzes are made per
// stretch of the video, at quiz breaks (prompt_3).
export const DEFAULT_PROMPTS = {
  prompt_1:
    "Analyze the video at the link and reply with exactly one word: 'ENTERTAINMENT' if it is just for fun, or 'USEFUL' if it has educational or instructive content. Link: ",
  // Summary and quiz for one stretch, filled in automatically. Placeholders:
  // {start} {end} {chapters} {url} {questions}, plus {part} {total} (break
  // number). {questions} is the quiz_questions setting.
  prompt_3:
    'Now cover ONLY the part of this video from {start} to {end}{chapters}. First write a detailed summary of that part, broken down by timestamps (for each key moment: the timestamp and what is explained there). Then make an INTERACTIVE quiz on that part: use your built-in interactive quiz feature, the one where I click an answer option and immediately see whether it is right, with an explanation. Do NOT write the quiz as plain text, and do NOT list the questions or answers in the message. The quiz must check real understanding, not memory of details: {questions} multiple-choice questions. No questions about names, dates, exact numbers, wording or who said what. Instead, ask the learner to apply an idea from the video to a new situation or example that was not in the video, to explain why something works or what causes what, to predict what happens if a condition changes, to compare or tell apart two close concepts, or to find the mistake in a plausible but wrong statement. Make the wrong options believable: typical misconceptions or half-right answers that someone who only skimmed the video would pick, all options similar in length. Order the questions from easier to harder. In each explanation, say why the right answer is right, why the tempting wrong answer is wrong, and the timestamp where this is explained. Write everything in English. Video: {url}',
};

export async function getPrompts() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_PROMPTS));
  return { ...DEFAULT_PROMPTS, ...stored };
}

// In 'auto' mode a video is sent to Gemini for a verdict shortly before its
// first break, so there is no separate setting for that.
// Quiz breaks in useful videos: one every ~quiz_interval_min minutes of the
// video timeline, moved to the nearest chapter start when one is close
// (see SNAP_SHARE in content_yt.js).
// quiz_questions: number of questions in each quiz.
// check_mode: 'request' offers quiz breaks in every video and opens Gemini
// only when a quiz is asked for; 'auto' first has Gemini check each watched
// video in a background tab. The verdict only sets the tone of the cards: a
// quiz can be taken on an entertainment video too.
export const DEFAULT_SETTINGS = {
  quiz_interval_min: 40,
  quiz_questions: 7,
  check_mode: 'request',
};

// Per-video state lives in chrome.storage.local under `video:<videoId>`.
export const VIDEO_KEY_PREFIX = 'video:';
