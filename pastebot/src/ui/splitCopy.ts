import { DESTINATIONS, DESTINATION_INFO, openHint, type Destination } from '../core/destinations';
import { h } from './dom';
import { icon } from './icons';
import { pasteShortcutLabel } from './format';

/**
 * The split Copy button shared by the panel and the popup:
 *
 *   [Copy] [Copy & open ChatGPT][▾]
 *   ChatGPT opens with the prompt filled in.
 *
 * ▾ picks ChatGPT, Perplexity, Claude or Gemini; the choice is remembered by the caller. The
 * hint says what will happen before the new tab takes focus (Claude and Gemini need a paste).
 */
export interface SplitCopyOptions {
  destination: Destination;
  onCopy(): void;
  onOpen(destination: Destination): void;
  /** A different destination was picked in the menu (save it). */
  onChoose(destination: Destination): void;
}

export interface SplitCopy {
  element: HTMLElement;
  /** Updates the hint for the prompt that would be opened (prefill depends on its length). */
  setPrompt(prompt: string): void;
  focusOpen(): void;
  setDisabled(disabled: boolean): void;
}

let ids = 0;

export function splitCopy(options: SplitCopyOptions): SplitCopy {
  const menuId = `pb-dest-menu-${++ids}`;
  const size = ' btn-sm';
  let destination = options.destination;
  let prompt = '';

  const copyButton = h(
    'button',
    { class: `btn${size} btn-outline-secondary btn-copy`, attrs: { type: 'button', 'data-copy': '' }, on: { click: () => options.onCopy() } },
    icon('clipboard'),
    h('span', { text: 'Copy' }),
  );
  const openLabel = h('span', { class: 'open-label' });
  const openButton = h(
    'button',
    {
      class: `btn${size} btn-primary btn-open`,
      attrs: { type: 'button', 'data-open': '' },
      on: { click: () => options.onOpen(destination) },
    },
    icon('boxArrowUpRight'),
    openLabel,
  );
  const caret = h(
    'button',
    {
      class: `btn${size} btn-primary btn-caret`,
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': 'Choose where to open the prompt', title: 'Choose where to open' },
    },
    icon('caretDownFill'),
  );
  const items = DESTINATIONS.map((id) => {
    const info = DESTINATION_INFO[id];
    const item = h(
      'button',
      { class: 'dest-item', attrs: { type: 'button', role: 'menuitemradio', 'data-destination': id, tabindex: '-1' } },
      h('span', { class: 'dest-check' }, icon('check2')),
      h('span', { class: 'dest-name', text: info.label }),
      h('span', { class: 'dest-note', text: info.prefill ? 'fills in the prompt' : `paste with ${pasteShortcutLabel()}` }),
    );
    item.addEventListener('click', () => choose(id));
    return item;
  });
  const menu = h('div', { class: 'dest-menu', attrs: { id: menuId, role: 'menu', 'aria-label': 'Open in' } }, ...items);
  menu.hidden = true;
  const hint = h('p', { class: 'open-hint' });
  const element = h(
    'div',
    { class: 'split-copy' },
    h('div', { class: 'split-row', attrs: { role: 'group', 'aria-label': 'Copy the prompt' } }, copyButton, h('div', { class: 'open-group' }, openButton, caret, menu)),
    hint,
  );

  function render(): void {
    openLabel.textContent = `Copy & open ${DESTINATION_INFO[destination].label}`;
    hint.textContent = openHint(destination, prompt, pasteShortcutLabel());
    for (const item of items) item.setAttribute('aria-checked', String(item.dataset.destination === destination));
  }

  function choose(id: Destination): void {
    closeMenu(true, 'open');
    if (id === destination) return;
    destination = id;
    render();
    options.onChoose(id);
  }

  const onOutside = (event: Event) => {
    if (!event.composedPath().includes(caret) && !event.composedPath().includes(menu)) closeMenu(false);
  };

  function openMenu(): void {
    menu.hidden = false;
    caret.setAttribute('aria-expanded', 'true');
    (items.find((item) => item.dataset.destination === destination) ?? items[0])?.focus();
    element.getRootNode().addEventListener('pointerdown', onOutside, true);
  }

  function closeMenu(restoreFocus: boolean, target: 'caret' | 'open' = 'caret'): void {
    if (menu.hidden) return;
    menu.hidden = true;
    caret.setAttribute('aria-expanded', 'false');
    element.getRootNode().removeEventListener('pointerdown', onOutside, true);
    if (restoreFocus) (target === 'open' ? openButton : caret).focus();
  }

  caret.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu(true)));
  caret.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      closeMenu(false);
    }
  });

  render();
  return {
    element,
    setPrompt(next: string) {
      prompt = next;
      render();
    },
    focusOpen: () => openButton.focus({ preventScroll: true }),
    setDisabled(disabled: boolean) {
      for (const button of [copyButton, openButton, caret]) button.disabled = disabled;
    },
  };
}
