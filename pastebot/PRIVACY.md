# Pastebot privacy policy

Last updated: 28 September 2026

Pastebot turns text you select on a web page into a prompt for an AI tool and puts it on your
clipboard. It works entirely inside your browser. It has no server, no account, no analytics
and no advertising, and it makes no network requests of its own. The only time anything leaves
your browser because of Pastebot is when you choose **Copy & open** (see below).

## What Pastebot reads, and when

- **The text you select**, as plain text. It is read only when you ask for it: the right-click
  menu, the keyboard shortcut or the toolbar button. Pastebot has no access to your pages
  otherwise. It uses Chrome's `activeTab` permission, which covers only the tab you invoked it
  on, and only at that moment.
- **The title and address of that page**, at the same moment, so your history shows where a
  prompt came from. They go into the prompt itself only if you turn on "Include page title &
  URL". Tracking parameters (such as `utm_source` or `fbclid`) and parameters that look like
  secrets (such as `token`, `session` or `code`) are removed from the address first. Addresses
  that aren't web pages (such as `file://`) are never used.
- **Text you type or paste** into the popup.

## Masking secrets

Before a prompt is made, Pastebot looks for sensitive values in the text (emails, phone numbers,
payment card numbers, IBANs, IP addresses, JSON Web Tokens, API keys and tokens, passwords and
secrets in URLs, logs and config, private keys, and the user name in home folder paths) and
replaces them with placeholders such as `[EMAIL_1]`. This runs inside your browser. The original
values exist only in memory while the prompt is made; they are never stored, logged or sent
anywhere. History keeps the masked prompt. If you choose "Undo masking for this prompt", that
single unmasked prompt is copied to your clipboard but not saved. Masking is on by default and can
be turned off, fully or per kind of data, in Settings.
## What Pastebot stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Pastebot or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| Your settings (`settings`: page context on/off, default action, prompt style, history size, masking on/off and the kinds of data turned off, the "Copy & open" destination you chose last, the Translate language) and plan (`plan`: free or Pro) | `chrome.storage.local` | Until you uninstall |
| Prompt history (`history`: each prompt, its action or template name, the first words of the source text after masking, the page title and address) | `chrome.storage.local` | Until you delete them, clear history or uninstall. You can turn history off or lower its size in Settings. |
| Your custom templates (`customTemplates`) and the last custom instruction you typed (`lastCustomInstruction`) | `chrome.storage.local` | Until you delete them or uninstall |
| A selection handed from the page to the popup (`pendingSelection`, when a page can't show Pastebot's panel) | `chrome.storage.session` (memory only) | Removed when the popup reads it, ignored after 5 minutes, gone when the browser closes |

Answers you type for template variables (such as `{{Audience}}`) are used for that one prompt
and not stored. "Export" saves your templates (names and instructions) to a file in your
downloads folder; Pastebot doesn't keep or send that file.

Uninstalling Pastebot deletes all of it. To delete things earlier: Clear history in the popup,
delete templates in Settings, or remove the extension.

## What Pastebot shares

Nothing on its own. Pastebot doesn't send, sell or share any data, and it contains no third-party
code that could. Your text leaves your computer only when you paste the prompt somewhere yourself,
or when you choose **Copy & open**, and then the privacy policy of that service applies.

**Copy & open** copies the prompt and opens one of these sites in a new tab, the one you pick:
`https://chatgpt.com`, `https://www.perplexity.ai`, `https://claude.ai` or
`https://gemini.google.com`. For ChatGPT and Perplexity the prompt is put into the address
(`?q=…`) when it is short enough, so that site receives it when the tab loads, just as if you had
pasted it there. Claude and Gemini open without the prompt; you paste it. Pastebot opens only these
fixed addresses and makes no other requests. Masking (when on) has already been applied to the
prompt.

## Permissions

- `activeTab`, `scripting`: read the selection and show the Pastebot panel on the tab you
  invoked it on, only when you do.
- Opening a tab for Copy & open needs no permission and gives Pastebot no access to that tab.
- `contextMenus`: the Pastebot right-click menu.
- `storage`: settings, history and templates, as described above.
- `offscreen`, `clipboardWrite`: put the prompt on your clipboard.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Pastebot's single purpose,
is never transferred to anyone, and is never used for advertising, credit decisions or any
purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Pastebot is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Pastebot's Chrome Web Store page.
