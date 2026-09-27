import type { SnippetDraft } from './snippets';

/** Added once, on first install, so there is something to try right away. */
export const STARTER_SNIPPETS: readonly SnippetDraft[] = [
  { abbreviation: ';sig', label: 'Email signature', text: 'Best regards,\n[Your name]' },
  { abbreviation: ';ty', label: 'Thanks', text: 'Thank you so much for your help!' },
  { abbreviation: ';addr', label: 'Address (edit me)', text: '123 Main Street\nSpringfield, 12345' },
  { abbreviation: ';date', label: "Today's date", text: '{date:YYYY-MM-DD}' },
  {
    abbreviation: ';meet',
    label: 'Meeting request',
    text: 'Hi {cursor},\n\nWould you have 30 minutes this week for a quick call?\n\nThanks!',
  },
  { abbreviation: ';shrug', label: 'Shrug', text: '¯\\_(ツ)_/¯' },
];
