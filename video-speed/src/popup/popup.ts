import ban from 'bootstrap-icons/icons/ban.svg';
import cameraVideoOff from 'bootstrap-icons/icons/camera-video-off.svg';
import dashLg from 'bootstrap-icons/icons/dash-lg.svg';
import gear from 'bootstrap-icons/icons/gear.svg';
import plusLg from 'bootstrap-icons/icons/plus-lg.svg';
import shieldLock from 'bootstrap-icons/icons/shield-lock.svg';
import { displayHost, entriesBlocking, normalizeHost } from '../core/hosts';
import { keyLabel } from '../core/keys';
import { unavailableReason } from '../core/pages';
import { sanitizeSettings, type Settings } from '../core/settings';
import { formatSpeed, formatSpeedShort, PRESET_SPEEDS, roundSpeed, sameSpeed } from '../core/speed';
import { pickTarget } from '../core/target';
import {
  isCommandResponse,
  isFrameReport,
  isFrameStatus,
  type Command,
  type CommandRequest,
  type DiscoverRequest,
  type FrameStatus,
} from '../platform/messages';
import { loadSettings, saveSettings } from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon } from '../ui/icons';

/** How long sub-frames get to report after the top frame answered. */
const DISCOVERY_WAIT_MS = 200;

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  loading: byId<HTMLDivElement>('view-loading'),
  control: byId<HTMLElement>('view-control'),
  empty: byId<HTMLElement>('view-empty'),
  unavailable: byId<HTMLElement>('view-unavailable'),
  unavailableText: byId<HTMLParagraphElement>('unavailable-text'),
  blocked: byId<HTMLElement>('view-blocked'),
  blockedHost: byId<HTMLSpanElement>('blocked-host'),
  unblock: byId<HTMLButtonElement>('unblock'),
  slower: byId<HTMLButtonElement>('slower'),
  faster: byId<HTMLButtonElement>('faster'),
  speed: byId<HTMLOutputElement>('speed'),
  presets: byId<HTMLDivElement>('presets'),
  targetDot: byId<HTMLSpanElement>('target-dot'),
  targetInfo: byId<HTMLSpanElement>('target-info'),
  error: byId<HTMLDivElement>('error'),
  footer: byId<HTMLElement>('footer'),
  siteToggle: byId<HTMLInputElement>('site-toggle'),
  siteLabel: byId<HTMLLabelElement>('site-label'),
  keyHint: byId<HTMLSpanElement>('key-hint'),
};

type ViewName = 'loading' | 'control' | 'empty' | 'unavailable' | 'blocked';

let settings: Settings = sanitizeSettings(undefined);
let tabId: number | null = null;
let tabUrl: string | undefined;
let nonce = '';
let discovering = false;
let busy = false;
/** Status per frameId, from the latest discovery. */
const frames = new Map<number, FrameStatus>();
/** Frame whose media the popup controls. */
let chosenFrame: number | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Setup ------------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.openOptions.append(icon(gear, { size: 16 }));
  els.slower.append(icon(dashLg, { size: 18 }));
  els.faster.append(icon(plusLg, { size: 18 }));
  byId('empty-icon').append(icon(cameraVideoOff, { size: 20 }));
  byId('unavailable-icon').append(icon(shieldLock, { size: 20 }));
  byId('blocked-icon').append(icon(ban, { size: 20 }));
  for (const speed of PRESET_SPEEDS) {
    els.presets.append(
      h('button', {
        class: 'btn btn-choice',
        text: formatSpeedShort(speed),
        attrs: { type: 'button', 'data-speed': String(speed), 'aria-pressed': 'false' },
        on: { click: () => void send({ kind: 'set', speed }) },
      }),
    );
  }
  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch((error: unknown) => showError(`Couldn't open settings: ${errorMessage(error)}`));
  });
  els.slower.addEventListener('click', () => void send({ kind: 'step', direction: -1 }));
  els.faster.addEventListener('click', () => void send({ kind: 'step', direction: 1 }));
  els.unblock.addEventListener('click', () => void setSiteEnabled(true));
  els.siteToggle.addEventListener('change', () => void setSiteEnabled(els.siteToggle.checked));
  chrome.runtime.onMessage.addListener(onReport);

  try {
    settings = await loadSettings();
  } catch (error) {
    showError(`Couldn't read settings, using defaults: ${errorMessage(error)}`);
  }
  renderKeyHint();

  try {
    ({ id: tabId, url: tabUrl } = await resolveTab());
  } catch (error) {
    showUnavailable(`Couldn't find the current tab: ${errorMessage(error)}`);
    return;
  }
  if (tabId === null) {
    showUnavailable('There is no active tab in this window.');
    return;
  }
  await discover();
}

/** The tab to control: the active one. The e2e build can point the popup at a tab with ?tab=. */
async function resolveTab(): Promise<{ id: number | null; url: string | undefined }> {
  if (__E2E__) {
    const param = new URLSearchParams(location.search).get('tab');
    if (param) {
      const tab = await chrome.tabs.get(Number(param));
      return { id: tab.id ?? null, url: tab.url };
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id ?? null, url: tab?.url };
}

// --- Discovery --------------------------------------------------------------------------------

async function discover(): Promise<void> {
  if (tabId === null) return;
  discovering = true;
  nonce = crypto.randomUUID();
  frames.clear();
  const request: DiscoverRequest = { type: 'vsp/discover', nonce };
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, request);
    if (isFrameStatus(response)) frames.set(0, response);
  } catch (error) {
    // No content script in the top frame: a page Chrome doesn't let extensions script, or a tab
    // opened before the extension was installed.
    if (/Receiving end does not exist|Could not establish connection/i.test(errorMessage(error))) {
      discovering = false;
      showUnavailable(unavailableReason(tabUrl));
      return;
    }
    // Otherwise the top frame just didn't answer; embedded frames may still report.
  }
  await sleep(DISCOVERY_WAIT_MS);
  discovering = false;
  render();
}

function onReport(message: unknown, sender: chrome.runtime.MessageSender): void {
  if (!isFrameReport(message) || message.nonce !== nonce) return;
  if (sender.tab?.id !== tabId || sender.frameId === undefined) return;
  frames.set(sender.frameId, message.status);
  if (!discovering && !busy) render();
}

/** The frame to control: same rule as inside a page, applied to each frame's own pick. */
function pickFrame(): number | null {
  const candidates = [...frames]
    .filter(([, status]) => status.blockedBy === null && status.target !== null)
    .map(([frameId, status]) => ({ frameId, ...status.target! }));
  return pickTarget(candidates)?.frameId ?? null;
}

function render(): void {
  const top = frames.get(0) ?? null;
  renderFooter(top);
  const problem = [...frames.values()].find((status) => status.problem)?.problem;
  if (problem) showError(problem, 'warning');

  chosenFrame = pickFrame();
  const chosen = chosenFrame === null ? undefined : frames.get(chosenFrame);
  if (chosen) {
    renderControl(chosen);
    return;
  }
  const blocked = top?.blockedBy ? top : [...frames.values()].find((status) => status.blockedBy && status.mediaCount > 0);
  if (blocked) {
    els.blockedHost.textContent = displayHost(blocked.top ? blocked.site : blocked.frameHost) || 'this page';
    show('blocked');
    return;
  }
  show('empty');
}

// --- Views ------------------------------------------------------------------------------------

function show(view: ViewName): void {
  els.loading.hidden = view !== 'loading';
  els.control.hidden = view !== 'control';
  els.empty.hidden = view !== 'empty';
  els.unavailable.hidden = view !== 'unavailable';
  els.blocked.hidden = view !== 'blocked';
}

function showUnavailable(text: string): void {
  els.unavailableText.textContent = text;
  els.footer.hidden = true;
  show('unavailable');
}

function renderControl(status: FrameStatus): void {
  const target = status.target;
  if (!target) return;
  const speed = target.speed;
  els.speed.value = formatSpeed(speed);
  els.speed.textContent = formatSpeed(speed);
  els.speed.classList.toggle('changed', !sameSpeed(speed, 1));
  for (const button of els.presets.querySelectorAll<HTMLButtonElement>('button')) {
    const pressed = sameSpeed(roundSpeed(speed), Number(button.dataset.speed));
    button.setAttribute('aria-pressed', String(pressed));
  }
  const total = [...frames.values()].reduce((sum, frame) => sum + (frame.blockedBy === null ? frame.mediaCount : 0), 0);
  const parts = [`${target.playing ? 'Playing' : 'Paused'} ${target.kind}`];
  if (!status.top && status.frameHost) parts.push(`embedded from ${displayHost(status.frameHost)}`);
  if (total > 1) parts.push(`${total} on this page`);
  els.targetInfo.textContent = parts.join(' · ');
  els.targetDot.classList.toggle('live', target.playing);
  show('control');
}

function renderFooter(top: FrameStatus | null): void {
  const site = top?.site ?? '';
  els.footer.hidden = !site;
  if (!site) return;
  els.siteToggle.checked = top?.blockedBy === null;
  els.siteLabel.textContent = `On for ${displayHost(site)}`;
  els.siteLabel.title = `Turn Video Speed+ on or off for ${displayHost(site)}`;
}

function renderKeyHint(): void {
  const { slower, faster, reset } = settings.keys;
  const parts: (Node | string)[] = [];
  if (slower && faster) parts.push(h('kbd', { text: keyLabel(slower) }), ' ', h('kbd', { text: keyLabel(faster) }), ' speed');
  if (reset) parts.push(parts.length ? ' · ' : '', h('kbd', { text: keyLabel(reset) }), ' reset');
  els.keyHint.replaceChildren(...parts);
}

function showError(text: string, tone: 'danger' | 'warning' = 'danger'): void {
  els.error.textContent = text;
  els.error.className = `alert alert-${tone} small py-2 px-3 mt-3 mb-0`;
  els.error.hidden = false;
}

function hideError(): void {
  els.error.hidden = true;
  els.error.textContent = '';
}

function setBusy(value: boolean): void {
  busy = value;
  for (const button of [els.slower, els.faster, ...els.presets.querySelectorAll('button')]) button.disabled = value;
}

// --- Actions ----------------------------------------------------------------------------------

async function send(command: Command): Promise<void> {
  if (tabId === null || chosenFrame === null || busy) return;
  const frameId = chosenFrame;
  setBusy(true);
  try {
    const request: CommandRequest = { type: 'vsp/command', command };
    const response: unknown = await chrome.tabs.sendMessage(tabId, request, { frameId });
    if (!isCommandResponse(response)) throw new Error('the page did not answer. Reload it and try again.');
    if (!response.ok) {
      showError(response.error);
      return;
    }
    hideError();
    frames.set(frameId, response.status);
    renderControl(response.status);
  } catch (error) {
    showError(`Couldn't change the speed: ${errorMessage(error)}`);
  } finally {
    setBusy(false);
  }
}

async function setSiteEnabled(enabled: boolean): Promise<void> {
  const site = frames.get(0)?.site;
  if (!site) return;
  els.siteToggle.disabled = true;
  els.unblock.disabled = true;
  try {
    const current = await loadSettings();
    let blocklist = current.blocklist;
    if (enabled) {
      const reported = [...frames.values()].map((status) => status.blockedBy).filter((entry): entry is string => entry !== null);
      const remove = new Set([...entriesBlocking(blocklist, site), ...reported]);
      blocklist = blocklist.filter((entry) => !remove.has(entry));
    } else {
      const host = normalizeHost(site);
      if (host && !blocklist.includes(host)) blocklist = [...blocklist, host];
    }
    settings = await saveSettings({ blocklist });
    hideError();
    // Content scripts pick the change up through storage.onChanged; then look again.
    show('loading');
    await sleep(150);
    await discover();
  } catch (error) {
    els.siteToggle.checked = !enabled;
    showError(`Couldn't save: ${errorMessage(error)}`);
  } finally {
    els.siteToggle.disabled = false;
    els.unblock.disabled = false;
  }
}

init().catch((error: unknown) => {
  show('empty');
  showError(`Something went wrong: ${errorMessage(error)}`);
});
