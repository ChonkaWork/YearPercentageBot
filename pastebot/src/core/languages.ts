/** Target languages for the Translate action. Names are in English: they go into the prompt. */
export const TRANSLATE_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'ar', name: 'Arabic' },
  { code: 'pt-BR', name: 'Brazilian Portuguese' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'et', name: 'Estonian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'zh-CN', name: 'Simplified Chinese' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'zh-TW', name: 'Traditional Chinese' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
];

const BY_CODE = new Map(TRANSLATE_LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
/** Browser locales that map to a listed language under another code. */
const ALIASES: Readonly<Record<string, string>> = { nb: 'no', nn: 'no', iw: 'he', 'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'zh-hant': 'zh-TW', 'zh-hans': 'zh-CN', zh: 'zh-CN' };
const ENGLISH = { code: 'en', name: 'English' };

/** Setting value: '' (follow the browser's language) or a code from TRANSLATE_LANGUAGES. */
export function isTranslateSetting(value: unknown): value is string {
  return value === '' || (typeof value === 'string' && BY_CODE.has(value.toLowerCase()) && BY_CODE.get(value.toLowerCase())?.code === value);
}

/** The language the Translate action targets: the setting, else the browser UI language, else English. */
export function resolveTargetLanguage(setting: string, uiLanguage: string): { code: string; name: string } {
  if (setting && BY_CODE.has(setting.toLowerCase())) return BY_CODE.get(setting.toLowerCase()) ?? ENGLISH;
  return languageForLocale(uiLanguage);
}

/** `en-US` → English, `pt-BR` → Brazilian Portuguese, `zh-HK` → Traditional Chinese, `uk` → Ukrainian. */
export function languageForLocale(locale: string): { code: string; name: string } {
  const normalized = (locale || '').replace(/_/g, '-').toLowerCase();
  const alias = ALIASES[normalized] ?? ALIASES[normalized.split('-')[0] ?? ''];
  const exact = BY_CODE.get(normalized) ?? (alias ? BY_CODE.get(alias.toLowerCase()) : undefined);
  if (exact) return exact;
  return BY_CODE.get(normalized.split('-')[0] ?? '') ?? ENGLISH;
}
