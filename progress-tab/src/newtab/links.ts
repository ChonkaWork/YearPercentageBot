import {
  MAX_LINK_NAME_LENGTH,
  hostLabel,
  linkLetter,
  validateLinkDraft,
  type LinkErrors,
  type LinkField,
  type LinkFields,
  type QuickLink,
} from '../core/links';
import { errorMessage, h, placeChildren, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import type { ListLimit } from './countdowns';
import type { Toast } from './toast';

/** Storage operations; each resolves once the change is saved and throws when it isn't. */
export interface LinkActions {
  add(fields: LinkFields): Promise<QuickLink>;
  update(id: string, fields: LinkFields): Promise<void>;
  /** Moves a link one place left (−1) or right (+1). */
  move(id: string, delta: number): Promise<QuickLink[]>;
  remove(id: string): Promise<{ link: QuickLink; index: number }>;
  restore(link: QuickLink, index: number): Promise<void>;
  reload(): void;
  aboutPro(): void;
}

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

// --- One tile ----------------------------------------------------------------------------------

class LinkTile {
  readonly root: HTMLLIElement;
  readonly anchor: HTMLAnchorElement;
  readonly editButton: HTMLButtonElement;
  private readonly avatar = h('span', { class: 'link-avatar', attrs: { 'aria-hidden': 'true' } });
  private readonly name = h('span', { class: 'link-name' });

  constructor(
    readonly id: string,
    edit: (id: string) => void,
  ) {
    // No referrer: sites don't learn the extension's page address.
    this.anchor = h('a', { class: 'link-main', attrs: { rel: 'noreferrer' } }, this.avatar, this.name);
    this.editButton = h('button', { class: 'btn-icon btn-sm link-edit', attrs: { type: 'button', title: 'Edit' }, on: { click: () => edit(id) } }, icon('pencil'));
    this.root = h('li', { class: 'link-tile', attrs: { 'data-id': id } }, this.anchor, this.editButton);
  }

  update(link: QuickLink): void {
    setAttr(this.anchor, 'href', link.url);
    setAttr(this.anchor, 'title', `${link.name} · ${hostLabel(link.url)}`);
    setText(this.avatar, linkLetter(link));
    setText(this.name, link.name);
    setAttr(this.editButton, 'aria-label', `Edit “${link.name}”`);
  }
}

// --- Add / edit form ---------------------------------------------------------------------------

interface FormHandlers {
  submit(fields: LinkFields): Promise<void>;
  cancel(): void;
  move(delta: number): Promise<void>;
  remove(): void;
}

class LinkForm {
  readonly root: HTMLFormElement;
  private readonly inputs: Record<LinkField, HTMLInputElement>;
  private readonly feedback: Record<LinkField, HTMLDivElement>;
  private readonly saveError = h('div', { class: 'alert alert-danger alert-with-icon', attrs: { role: 'alert', hidden: '' } });
  private readonly saveButton: HTMLButtonElement;
  readonly moveLeft: HTMLButtonElement;
  readonly moveRight: HTMLButtonElement;
  private busy = false;

  constructor(
    /** null for a new link. */
    readonly linkId: string | null,
    initial: QuickLink | null,
    private readonly handlers: FormHandlers,
  ) {
    this.inputs = {
      name: h('input', { class: 'form-control', attrs: { type: 'text', id: 'link-name', maxlength: String(MAX_LINK_NAME_LENGTH), autocomplete: 'off', placeholder: 'e.g. Mail' } }),
      url: h('input', { class: 'form-control', attrs: { type: 'text', id: 'link-url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'example.com', required: '' } }),
    };
    this.feedback = {
      name: h('div', { class: 'invalid-feedback', attrs: { id: 'link-name-error' } }),
      url: h('div', { class: 'invalid-feedback', attrs: { id: 'link-url-error' } }),
    };
    this.inputs.name.setAttribute('aria-describedby', 'link-name-error');
    this.inputs.url.setAttribute('aria-describedby', 'link-url-error link-url-hint');
    this.inputs.name.value = initial?.name ?? '';
    this.inputs.url.value = initial?.url ?? '';

    this.saveButton = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'submit' }, text: initial ? 'Save' : 'Add link' });
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => this.handlers.cancel() } });
    const moveButton = (delta: number, label: string, iconName: 'arrowLeft' | 'arrowRight') =>
      h(
        'button',
        { class: 'btn-icon btn-sm', attrs: { type: 'button', title: label, 'aria-label': label }, on: { click: () => void this.handlers.move(delta) } },
        icon(iconName),
      );
    this.moveLeft = moveButton(-1, 'Move left', 'arrowLeft');
    this.moveRight = moveButton(1, 'Move right', 'arrowRight');
    const remove = h('button', { class: 'btn btn-link btn-sm link-delete', attrs: { type: 'button' }, text: 'Delete', on: { click: () => this.handlers.remove() } });

    this.root = h(
      'form',
      {
        class: 'link-form',
        attrs: { novalidate: '', 'aria-label': initial ? `Edit “${initial.name}”` : 'New quick link' },
        on: {
          submit: (event) => {
            event.preventDefault();
            void this.submit();
          },
          keydown: (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.handlers.cancel();
          },
        },
      },
      h(
        'div',
        { class: 'form-fields' },
        h('div', {}, h('label', { class: 'form-label', attrs: { for: 'link-url' }, text: 'Web address' }), this.inputs.url, this.feedback.url),
        h(
          'div',
          {},
          h('label', { class: 'form-label', attrs: { for: 'link-name' } }, 'Name ', h('span', { class: 'text-body-secondary fw-normal', text: '(optional)' })),
          this.inputs.name,
          this.feedback.name,
        ),
      ),
      h('p', { class: 'form-text', attrs: { id: 'link-url-hint' }, text: 'Only http and https addresses. The tile shows the first letter of the name; nothing is loaded from the site.' }),
      this.saveError,
      h(
        'div',
        { class: 'form-actions' },
        this.saveButton,
        cancel,
        initial ? h('span', { class: 'link-move', attrs: { role: 'group', 'aria-label': 'Order' } }, this.moveLeft, this.moveRight) : null,
        initial ? remove : h('span', { class: 'form-hint', text: 'Enter saves · Esc cancels' }),
      ),
    );
  }

  focus(): void {
    (this.linkId ? this.inputs.name : this.inputs.url).focus({ preventScroll: true });
    this.root.scrollIntoView({ block: 'nearest' });
  }

  /** Disables Move left/right at the ends (keeping focus on the form if it was on one of them). */
  setPosition(index: number, count: number): void {
    for (const [button, disabled] of [
      [this.moveLeft, index <= 0],
      [this.moveRight, index >= count - 1],
    ] as const) {
      if (button.disabled === disabled) continue;
      const hadFocus = document.activeElement === button;
      button.disabled = disabled;
      if (hadFocus && disabled) (button === this.moveLeft ? this.moveRight : this.moveLeft).focus();
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const result = validateLinkDraft({ name: this.inputs.name.value, url: this.inputs.url.value });
    this.showErrors(result.ok ? {} : result.errors);
    this.showSaveError(null);
    if (!result.ok) return;
    this.setBusy(true);
    try {
      await this.handlers.submit(result.value);
    } catch (error) {
      this.showSaveError(`Couldn’t save the link: ${errorMessage(error)}`);
      this.setBusy(false);
    }
  }

  showSaveError(message: string | null): void {
    this.saveError.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(this.saveError, !message);
  }

  private showErrors(errors: LinkErrors): void {
    let first: HTMLInputElement | null = null;
    for (const name of ['url', 'name'] as const) {
      const message = errors[name];
      const input = this.inputs[name];
      input.classList.toggle('is-invalid', Boolean(message));
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      this.feedback[name].textContent = message ?? '';
      if (message && !first) first = input;
    }
    first?.focus();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton.disabled = busy;
    this.root.setAttribute('aria-busy', String(busy));
  }
}

// --- Section -----------------------------------------------------------------------------------

/**
 * Quick links under the clock: letter tiles in the accent color, an Add tile at the end, and one
 * form below the row for adding, editing, reordering and deleting.
 */
export class QuickLinks {
  private readonly list = h('ul', { class: 'link-tiles' });
  private readonly addTile: HTMLLIElement;
  private readonly addButton: HTMLButtonElement;
  private readonly hint = h('li', { class: 'link-hint', text: 'Add the sites you open every day.' });
  private readonly panel = h('div', { class: 'link-panel' });
  private readonly error: HTMLDivElement;
  private readonly errorText = h('span');
  private readonly limitNote: HTMLDivElement;
  private readonly limitText = h('span');
  private readonly limitLink: HTMLButtonElement;
  private readonly announcer = h('p', { class: 'visually-hidden', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
  private limit: ListLimit = { max: Number.POSITIVE_INFINITY, message: '', upgradable: false };
  private limitShown = false;
  private readonly tiles = new Map<string, LinkTile>();
  private links: QuickLink[] = [];
  private state: LoadState = { kind: 'loading' };
  private form: LinkForm | null = null;

  constructor(
    private readonly section: HTMLElement,
    private readonly actions: LinkActions,
    private readonly toast: Toast,
  ) {
    this.addButton = h(
      'button',
      { class: 'link-main link-add', attrs: { type: 'button', 'aria-label': 'Add a quick link' }, on: { click: () => this.openForm(null) } },
      h('span', { class: 'link-avatar', attrs: { 'aria-hidden': 'true' } }, icon('plusLg')),
      h('span', { class: 'link-name', attrs: { 'aria-hidden': 'true' }, text: 'Add link' }),
    );
    this.addTile = h('li', { class: 'link-tile link-add-tile' }, this.addButton);
    this.error = h(
      'div',
      { class: 'alert alert-danger alert-with-icon links-error', attrs: { role: 'alert' } },
      icon('exclamationTriangleFill'),
      h('p', { class: 'mb-0' }, 'Couldn’t load your quick links: ', this.errorText, '. '),
      h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'Try again', on: { click: () => this.actions.reload() } }),
    );
    this.limitLink = h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'About Pro', on: { click: () => this.actions.aboutPro() } });
    this.limitNote = h('div', { class: 'list-limit', attrs: { role: 'status' } }, icon('infoCircle'), h('p', {}, this.limitText, ' ', this.limitLink));
    section.replaceChildren(this.list, this.error, this.limitNote, this.panel, this.announcer);
    this.render();
  }

  setLimit(limit: ListLimit): void {
    this.limit = limit;
    this.render();
  }

  setLoading(): void {
    this.state = { kind: 'loading' };
    this.render();
  }

  setError(message: string): void {
    this.state = { kind: 'error', message };
    this.render();
  }

  setLinks(links: QuickLink[]): void {
    this.links = links;
    this.state = { kind: 'ready' };
    if (this.form?.linkId && !links.some((link) => link.id === this.form?.linkId)) {
      this.closeForm(false);
      this.toast.show('The link you were editing was deleted in another tab.', { returnFocus: () => this.addButton.focus() });
    }
    this.render();
  }

  private render(): void {
    const { state } = this;
    setAttr(this.section, 'data-state', state.kind);
    setHidden(this.error, state.kind !== 'error');
    if (state.kind === 'error') setText(this.errorText, state.message);
    // While loading, nothing: storage answers in a few milliseconds, and an empty row doesn't jump.
    setHidden(this.list, state.kind !== 'ready');
    if (state.kind !== 'ready') {
      setHidden(this.limitNote, true);
      return;
    }

    if (this.links.length < this.limit.max) this.limitShown = false;
    setHidden(this.limitNote, !this.limitShown);
    if (this.limitShown) {
      setText(this.limitText, this.limit.message);
      setHidden(this.limitLink, !this.limit.upgradable);
    }

    const ids = new Set(this.links.map((link) => link.id));
    for (const [id, tile] of this.tiles) {
      if (ids.has(id)) continue;
      tile.root.remove();
      this.tiles.delete(id);
    }
    const nodes: HTMLElement[] = [];
    for (const link of this.links) {
      let tile = this.tiles.get(link.id);
      if (!tile) {
        tile = new LinkTile(link.id, (id) => this.openForm(id));
        this.tiles.set(link.id, tile);
      }
      tile.update(link);
      tile.root.classList.toggle('is-editing', this.form?.linkId === link.id);
      nodes.push(tile.root);
    }
    nodes.push(this.addTile);
    if (this.links.length === 0 && !this.form) nodes.push(this.hint);
    placeChildren(this.list, nodes);
    this.addButton.classList.toggle('is-editing', this.form !== null && this.form.linkId === null);
    setAttr(this.addButton, 'aria-expanded', String(this.form !== null && this.form.linkId === null));
    if (this.form?.linkId) {
      const index = this.links.findIndex((link) => link.id === this.form?.linkId);
      this.form.setPosition(index, this.links.length);
    }
  }

  private openForm(linkId: string | null): void {
    if (linkId === null && this.links.length >= this.limit.max) {
      if (this.form) this.closeForm(false);
      this.limitShown = true;
      this.render();
      return;
    }
    if (this.form) this.closeForm(false);
    const initial = linkId === null ? null : (this.links.find((link) => link.id === linkId) ?? null);
    if (linkId !== null && !initial) return;
    const form = new LinkForm(linkId, initial, {
      submit: async (fields) => {
        if (linkId === null) {
          const created = await this.actions.add(fields);
          this.closeForm(false);
          this.tiles.get(created.id)?.anchor.focus();
        } else {
          await this.actions.update(linkId, fields);
          this.closeForm(false);
          this.tiles.get(linkId)?.editButton.focus();
        }
      },
      cancel: () => this.closeForm(true),
      move: async (delta) => {
        if (!linkId) return;
        try {
          const list = await this.actions.move(linkId, delta);
          const index = list.findIndex((link) => link.id === linkId);
          const name = list[index]?.name ?? '';
          this.announcer.textContent = `${name}: position ${index + 1} of ${list.length}.`;
        } catch (error) {
          form.showSaveError(`Couldn’t move the link: ${errorMessage(error)}`);
        }
      },
      remove: () => {
        if (linkId) void this.remove(linkId);
      },
    });
    this.form = form;
    this.panel.replaceChildren(form.root);
    this.render();
    form.focus();
  }

  private closeForm(restoreFocus: boolean): void {
    const form = this.form;
    if (!form) return;
    this.form = null;
    const hadFocus = form.root.contains(document.activeElement);
    form.root.remove();
    this.render();
    if (!restoreFocus && !hadFocus) return;
    const tile = form.linkId ? this.tiles.get(form.linkId) : undefined;
    (tile ? tile.editButton : this.addButton).focus();
  }

  private async remove(id: string): Promise<void> {
    const name = this.links.find((link) => link.id === id)?.name ?? 'link';
    // Close first: the list update that follows would otherwise read as "deleted in another tab".
    this.closeForm(false);
    try {
      const { link, index } = await this.actions.remove(id);
      this.toast.show(`Deleted “${link.name}”.`, {
        actionLabel: 'Undo',
        focusAction: true,
        onAction: () => void this.restore(link, index),
        returnFocus: () => this.addButton.focus(),
      });
    } catch (error) {
      this.toast.show(`Couldn’t delete “${name}”: ${errorMessage(error)}`, { error: true, returnFocus: () => this.addButton.focus() });
    }
  }

  private async restore(link: QuickLink, index: number): Promise<void> {
    try {
      await this.actions.restore(link, index);
      this.tiles.get(link.id)?.anchor.focus();
    } catch (error) {
      this.toast.show(`Couldn’t restore “${link.name}”: ${errorMessage(error)}`, { error: true, returnFocus: () => this.addButton.focus() });
    }
  }
}
