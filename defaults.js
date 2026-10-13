// Общие значения по умолчанию для popup.js и background.js.
export const DEFAULT_PROMPTS = {
  prompt_1:
    "Проанализируй видео по ссылке и ответь только одним словом: 'РАЗВЛЕЧЕНИЕ', если это просто фан, или 'ПОЛЬЗА', если там есть образовательный/поучительный контент. Ссылка: ",
  prompt_2:
    'Отлично, теперь сделай подробный конспект этого видео и составь тест из 3 вопросов для проверки знаний.',
};

export async function getPrompts() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_PROMPTS));
  return { ...DEFAULT_PROMPTS, ...stored };
}

// Состояние обработки видео хранится в chrome.storage.local под ключами
// `video:<videoId>` — его читают background.js и popup.js.
export const VIDEO_KEY_PREFIX = 'video:';
