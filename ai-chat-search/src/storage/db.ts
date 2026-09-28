import { sanitizeRecord, withMeta, type StoredConversation, type UserMeta } from './record';

/**
 * IndexedDB in the extension's origin (chrome-extension://<id>), shared by the service worker
 * and the extension pages. Content scripts never touch it: their IndexedDB would belong to the
 * chat site. Two stores, written together:
 *   conversations  full records (messages + search text), loaded by the search page
 *   summaries      small rows (title, size, dates), enough for the popup
 */

const DB_NAME = 'ai-chat-search';
const DB_VERSION = 1;
const CONVERSATIONS = 'conversations';
const SUMMARIES = 'summaries';

export interface ConversationSummary {
  key: string;
  site: StoredConversation['site'];
  title: string;
  url: string;
  updatedAt: number;
  savedAt: number;
  bytes: number;
  messageCount: number;
}

let opening: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS)) db.createObjectStore(CONVERSATIONS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("Couldn't open the database."));
    };
    request.onblocked = () => {
      opening = null;
      reject(new Error('The database is busy in another tab. Close other AI Chat Search tabs and try again.'));
    };
  });
  return opening;
}

function summaryOf(record: StoredConversation): ConversationSummary {
  return {
    key: record.key,
    site: record.site,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    savedAt: record.savedAt,
    bytes: record.bytes,
    messageCount: record.messages.length,
  };
}

/** Runs `work` in one transaction and resolves with its result once the transaction commits. */
async function transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const request = work(tx);
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? request?.error ?? new Error('Database error.'));
    tx.onabort = () => reject(tx.error ?? new Error('The database write was aborted.'));
  });
}

export async function getConversation(key: string): Promise<StoredConversation | undefined> {
  const raw = await transaction<unknown>([CONVERSATIONS], 'readonly', (tx) => tx.objectStore(CONVERSATIONS).get(key));
  return sanitizeRecord(raw) ?? undefined;
}

export async function getSummary(key: string): Promise<ConversationSummary | undefined> {
  return (await transaction<ConversationSummary | undefined>([SUMMARIES], 'readonly', (tx) => tx.objectStore(SUMMARIES).get(key))) ?? undefined;
}

export async function putConversation(record: StoredConversation): Promise<void> {
  await transaction([CONVERSATIONS, SUMMARIES], 'readwrite', (tx) => {
    tx.objectStore(CONVERSATIONS).put(record);
    tx.objectStore(SUMMARIES).put(summaryOf(record));
  });
}

export async function countConversations(): Promise<number> {
  return (await transaction<number>([SUMMARIES], 'readonly', (tx) => tx.objectStore(SUMMARIES).count())) ?? 0;
}

/**
 * Reads the saved copy and the number of saved conversations, lets `decide` build the new record
 * (or refuse), and writes it, all in one transaction: a star or tag set on the search page at the
 * same moment can't be lost, and two saves can't both squeeze past the free limit.
 */
export async function upsertConversation<T>(
  key: string,
  decide: (previous: StoredConversation | undefined, count: number) => { record: StoredConversation | null; result: T },
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([CONVERSATIONS, SUMMARIES], 'readwrite');
    let outcome: { result: T } | null = null;
    const get = tx.objectStore(CONVERSATIONS).get(key);
    const count = tx.objectStore(SUMMARIES).count();
    count.onsuccess = () => {
      try {
        const decided = decide(sanitizeRecord(get.result) ?? undefined, count.result);
        outcome = { result: decided.result };
        if (decided.record) {
          tx.objectStore(CONVERSATIONS).put(decided.record);
          tx.objectStore(SUMMARIES).put(summaryOf(decided.record));
        }
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => (outcome ? resolve(outcome.result) : reject(new Error('Database error.')));
    tx.onerror = () => reject(tx.error ?? new Error('Database error.'));
    tx.onabort = () => reject(tx.error ?? new Error('The database write was aborted.'));
  });
}

/** Changes the star/tags of a saved conversation. Resolves with the new record, or undefined if it's gone. */
export async function updateConversationMeta(key: string, patch: Partial<UserMeta>): Promise<StoredConversation | undefined> {
  return upsertConversation(key, (previous) => {
    if (!previous) return { record: null, result: undefined };
    const record = withMeta(previous, patch);
    return { record, result: record };
  });
}

export async function deleteConversation(key: string): Promise<void> {
  await transaction([CONVERSATIONS, SUMMARIES], 'readwrite', (tx) => {
    tx.objectStore(CONVERSATIONS).delete(key);
    tx.objectStore(SUMMARIES).delete(key);
  });
}

export async function clearConversations(): Promise<void> {
  await transaction([CONVERSATIONS, SUMMARIES], 'readwrite', (tx) => {
    tx.objectStore(CONVERSATIONS).clear();
    tx.objectStore(SUMMARIES).clear();
  });
}

/** Every saved conversation; malformed rows are skipped and counted. */
export async function getAllConversations(): Promise<{ records: StoredConversation[]; skipped: number }> {
  const raw = (await transaction<unknown[]>([CONVERSATIONS], 'readonly', (tx) => tx.objectStore(CONVERSATIONS).getAll())) ?? [];
  const records: StoredConversation[] = [];
  let skipped = 0;
  for (const item of raw) {
    const record = sanitizeRecord(item);
    if (record) records.push(record);
    else skipped++;
  }
  return { records, skipped };
}

export async function getAllSummaries(): Promise<ConversationSummary[]> {
  return (await transaction<ConversationSummary[]>([SUMMARIES], 'readonly', (tx) => tx.objectStore(SUMMARIES).getAll())) ?? [];
}

// --- Change notifications -----------------------------------------------------------------------

const CHANNEL = 'ai-chat-search:index';

/**
 * Tells open search pages that the index changed (same-origin BroadcastChannel). `source` lets a
 * page ignore its own changes, which it has already applied.
 */
export function notifyIndexChanged(source?: string): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: 'changed', at: Date.now(), source });
    channel.close();
  } catch {
    // Pages reload the index when they're opened anyway.
  }
}

export function onIndexChanged(listener: () => void, ignoreSource?: string): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener('message', (event: MessageEvent<{ source?: unknown } | null>) => {
    if (ignoreSource !== undefined && event.data?.source === ignoreSource) return;
    listener();
  });
}
