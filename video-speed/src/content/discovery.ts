/**
 * Finds <video> (and optionally <audio>) elements: those present at start, those added
 * later, and those inside shadow roots (open ones, and closed ones through
 * chrome.dom.openOrClosedShadowRoot).
 *
 * Kept cheap because it runs in every frame of every page:
 *  - The MutationObserver callback only looks at added nodes, using the native
 *    getElementsByTagName (no selector matching, no full-document scans).
 *  - Looking for shadow roots means walking the added subtree; that is deferred to idle
 *    time and time-sliced.
 *  - Custom elements often attach their shadow root after insertion (no mutation record
 *    for that), so hyphenated elements without one are re-checked twice shortly after.
 */

const RECHECK_DELAYS_MS = [700, 2500];
const DEEP_SCAN_THROTTLE_MS = 1000;

type Root = Document | ShadowRoot;

function shadowRootOf(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? null;
  } catch {
    // Not an element that can host a shadow root.
    return null;
  }
}

export class MediaScanner {
  private observer: MutationObserver | null = null;
  private readonly observed = new WeakSet<Root>();
  private walkQueue: Node[] = [];
  private idleHandle: number | null = null;
  private pendingHosts: { element: Element; attempt: number }[] = [];
  private recheckTimer: number | null = null;
  private lastDeepScan = 0;

  constructor(
    private readonly onFound: (media: HTMLMediaElement) => void,
    private readonly includeAudio: () => boolean,
    /** Our own UI host, never scanned. */
    private readonly isOwnNode: (node: Node) => boolean,
  ) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observeRoot(document);
    this.scanRoot(document);
    if (document.documentElement) this.queueWalk(document.documentElement);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.idleHandle !== null) cancelIdleCallback(this.idleHandle);
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.idleHandle = null;
    this.recheckTimer = null;
    this.walkQueue = [];
    this.pendingHosts = [];
  }

  /**
   * Synchronous full rescan, including shadow roots. Used on demand (a shortcut found
   * nothing, the popup asks) and throttled, so it never runs in a loop.
   */
  deepScan(force = false): void {
    if (!this.observer) return;
    const now = Date.now();
    if (!force && now - this.lastDeepScan < DEEP_SCAN_THROTTLE_MS) return;
    this.lastDeepScan = now;
    this.scanRoot(document);
    if (document.documentElement) this.walk(document.documentElement);
    this.drainQueue(Number.POSITIVE_INFINITY);
  }

  private selector(): string {
    return this.includeAudio() ? 'video, audio' : 'video';
  }

  private isMedia(element: Element): element is HTMLMediaElement {
    const name = element.localName;
    return (name === 'video' || (name === 'audio' && this.includeAudio())) && element instanceof HTMLMediaElement;
  }

  private observeRoot(root: Root): void {
    if (this.observed.has(root)) return;
    this.observed.add(root);
    this.observer?.observe(root, { childList: true, subtree: true });
  }

  private scanRoot(root: Root): void {
    for (const element of root.querySelectorAll(this.selector())) {
      if (element instanceof HTMLMediaElement) this.onFound(element);
    }
  }

  private onMutations(records: MutationRecord[]): void {
    const audio = this.includeAudio();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || this.isOwnNode(node)) continue;
        const element = node as Element;
        if (this.isMedia(element)) {
          this.onFound(element);
        } else if (element.firstElementChild) {
          for (const media of element.getElementsByTagName('video')) this.onFound(media);
          if (audio) for (const media of element.getElementsByTagName('audio')) this.onFound(media);
        }
        if (element.firstElementChild || shadowRootOf(element)) this.queueWalk(element);
        else if (element.localName.includes('-')) this.watchHost(element);
      }
    }
  }

  // --- Shadow roots ---------------------------------------------------------------------------

  private adoptShadowRoot(root: ShadowRoot): void {
    if (this.observed.has(root)) return;
    this.observeRoot(root);
    this.scanRoot(root);
    this.queueWalk(root);
  }

  private visit(element: Element): void {
    const root = shadowRootOf(element);
    if (root) this.adoptShadowRoot(root);
    else if (element.localName.includes('-')) this.watchHost(element);
  }

  /** Visits every element under `root` looking for shadow roots (not into them: adopt queues those). */
  private walk(root: Node): void {
    if (this.isOwnNode(root)) return;
    if (root instanceof Element) this.visit(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) this.visit(node as Element);
  }

  private queueWalk(node: Node): void {
    this.walkQueue.push(node);
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.idleHandle !== null || !this.walkQueue.length) return;
    this.idleHandle = requestIdleCallback(
      (deadline) => {
        this.idleHandle = null;
        this.drainQueue(Math.max(4, deadline.timeRemaining()));
      },
      { timeout: 1000 },
    );
  }

  private drainQueue(budgetMs: number): void {
    const started = performance.now();
    while (this.walkQueue.length) {
      if (performance.now() - started > budgetMs) {
        this.scheduleIdle();
        return;
      }
      const node = this.walkQueue.shift();
      if (node?.isConnected) this.walk(node);
    }
  }

  private watchHost(element: Element): void {
    if (this.pendingHosts.length > 200 || this.pendingHosts.some((entry) => entry.element === element)) return;
    this.pendingHosts.push({ element, attempt: 0 });
    this.scheduleRecheck();
  }

  private scheduleRecheck(): void {
    if (this.recheckTimer !== null || !this.pendingHosts.length) return;
    const attempt = Math.min(...this.pendingHosts.map((entry) => entry.attempt));
    this.recheckTimer = window.setTimeout(() => {
      this.recheckTimer = null;
      const due = this.pendingHosts;
      this.pendingHosts = [];
      for (const entry of due) {
        const root = entry.element.isConnected ? shadowRootOf(entry.element) : null;
        if (root) this.adoptShadowRoot(root);
        else if (entry.element.isConnected && entry.attempt + 1 < RECHECK_DELAYS_MS.length) {
          this.pendingHosts.push({ element: entry.element, attempt: entry.attempt + 1 });
        }
      }
      this.scheduleRecheck();
    }, RECHECK_DELAYS_MS[attempt] ?? RECHECK_DELAYS_MS[0]);
  }
}
