/**
 * A small zip reader and writer, written for the history import (no dependencies, no remote code).
 *
 * Reader: random access into a Blob (a File from an <input> or a drop), so a multi-gigabyte export
 * is never loaded as a whole: only the end of the archive, the central directory and the one entry
 * that is asked for are read. Stored and deflated entries are supported (DecompressionStream
 * 'deflate-raw'), Zip64 archives too. Guards against zip bombs: a cap on the entry count, the
 * central directory size and the uncompressed size of the entry, which is also enforced while
 * inflating (a header that lies about the size doesn't help), and the CRC-32 is checked.
 *
 * Writer: stored or deflated entries (CompressionStream 'deflate-raw', kept only when smaller),
 * UTF-8 names, no Zip64 (at most 65,535 entries and 4 GB, far beyond a chat history).
 *
 * Only standard web platform APIs (Blob, streams, compression streams): runs in extension pages
 * and in Node.
 */

export interface ZipLimits {
  /** Entries in the central directory. */
  maxEntries: number;
  /** Bytes of central directory read into memory. */
  maxDirectoryBytes: number;
  /** Uncompressed bytes of an entry that will be inflated. */
  maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxEntries: 200_000,
  maxDirectoryBytes: 64 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
});

export type ZipErrorCode = 'NOT_ZIP' | 'CORRUPT' | 'TOO_MANY_ENTRIES' | 'TOO_LARGE' | 'ENCRYPTED' | 'UNSUPPORTED_METHOD';

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX_COMMENT = 0xffff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const UTF8_FLAG = 0x0800;

async function readBytes(blob: Blob, offset: number, length: number): Promise<DataView> {
  if (offset < 0 || length < 0 || offset + length > blob.size) throw new ZipError('CORRUPT', 'The zip is damaged or incomplete.');
  return new DataView(await blob.slice(offset, offset + length).arrayBuffer());
}

/** True when the blob starts like a zip archive (a local file header or an empty archive). */
export async function looksLikeZip(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const signature = (await readBytes(blob, 0, 4)).getUint32(0, true);
  return signature === SIG_LOCAL || signature === SIG_END;
}

/** Reads the central directory: every entry's name, sizes and position. */
export async function readZipDirectory(blob: Blob, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipError('NOT_ZIP', 'This file is not a zip archive.');
  const tailLength = Math.min(blob.size, 22 + MAX_COMMENT);
  const tailStart = blob.size - tailLength;
  const tail = await readBytes(blob, tailStart, tailLength);

  // The end-of-central-directory record is the last one whose comment runs exactly to the end.
  let end = -1;
  for (let at = tailLength - 22; at >= 0; at--) {
    if (tail.getUint32(at, true) === SIG_END && at + 22 + tail.getUint16(at + 20, true) === tailLength) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new ZipError('NOT_ZIP', 'This file is not a zip archive, or it is incomplete.');

  let count = tail.getUint16(end + 10, true);
  let directorySize = tail.getUint32(end + 12, true);
  let directoryOffset = tail.getUint32(end + 16, true);

  if (count === UINT16_MAX || directorySize === UINT32_MAX || directoryOffset === UINT32_MAX) {
    // Zip64: a locator right before the classic record points at the Zip64 end record.
    const locatorAt = tailStart + end - 20;
    const locator = await readBytes(blob, locatorAt, 20);
    if (locator.getUint32(0, true) !== SIG_ZIP64_LOCATOR) throw new ZipError('CORRUPT', 'The zip is damaged (no Zip64 locator).');
    const record = await readBytes(blob, toNumber(locator.getBigUint64(8, true)), 56);
    if (record.getUint32(0, true) !== SIG_ZIP64_END) throw new ZipError('CORRUPT', 'The zip is damaged (no Zip64 directory).');
    count = toNumber(record.getBigUint64(32, true));
    directorySize = toNumber(record.getBigUint64(40, true));
    directoryOffset = toNumber(record.getBigUint64(48, true));
  }

  if (count > limits.maxEntries) throw new ZipError('TOO_MANY_ENTRIES', `This zip has ${count.toLocaleString('en-US')} files, more than the ${limits.maxEntries.toLocaleString('en-US')} it can open.`);
  if (directorySize > limits.maxDirectoryBytes) throw new ZipError('TOO_MANY_ENTRIES', 'This zip lists too many files to open.');
  const directory = await readBytes(blob, directoryOffset, directorySize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipError('CORRUPT', 'The zip is damaged (bad central directory).');
    }
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const crc32 = directory.getUint32(at + 16, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let localHeaderOffset = directory.getUint32(at + 42, true);
    const nameStart = at + 46;
    if (nameStart + nameLength + extraLength + commentLength > directory.byteLength) throw new ZipError('CORRUPT', 'The zip is damaged (bad central directory).');
    const name = decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + nameStart, nameLength));

    if (size === UINT32_MAX || compressedSize === UINT32_MAX || localHeaderOffset === UINT32_MAX) {
      // Zip64 extended information: only the fields that overflowed are present, in this order.
      let extra = nameStart + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.getUint16(extra, true);
        const length = directory.getUint16(extra + 2, true);
        if (id === 0x0001) {
          let field = extra + 4;
          const next = (): number => {
            if (field + 8 > extra + 4 + length) throw new ZipError('CORRUPT', 'The zip is damaged (bad Zip64 field).');
            const value = toNumber(directory.getBigUint64(field, true));
            field += 8;
            return value;
          };
          if (size === UINT32_MAX) size = next();
          if (compressedSize === UINT32_MAX) compressedSize = next();
          if (localHeaderOffset === UINT32_MAX) localHeaderOffset = next();
          break;
        }
        extra += 4 + length;
      }
    }

    entries.push({ name, method, flags, crc32, compressedSize, size, localHeaderOffset });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface OpenedEntry {
  /** The uncompressed contents. Errors if the data is damaged, bigger than declared or over the limit. */
  stream: ReadableStream<Uint8Array>;
  /** Compressed bytes read so far (for progress). */
  bytesRead(): number;
}

/** Streams one entry's contents, inflating and checking it on the way. */
export async function openZipEntry(blob: Blob, entry: ZipEntry, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<OpenedEntry> {
  if (entry.flags & 0x0001) throw new ZipError('ENCRYPTED', 'This zip is password-protected. Export it again without a password.');
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('UNSUPPORTED_METHOD', `This zip uses a compression method (${entry.method}) that can't be read here.`);
  if (entry.size > limits.maxEntryBytes) throw new ZipError('TOO_LARGE', `${baseName(entry.name)} is ${formatBytes(entry.size)}, more than the ${formatBytes(limits.maxEntryBytes)} that can be read.`);
  if (entry.method === 0 && entry.compressedSize !== entry.size) throw new ZipError('CORRUPT', 'The zip is damaged (size mismatch).');

  const header = await readBytes(blob, entry.localHeaderOffset, 30);
  if (header.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('CORRUPT', 'The zip is damaged (bad local header).');
  const dataStart = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (dataStart + entry.compressedSize > blob.size) throw new ZipError('CORRUPT', 'The zip is damaged or incomplete.');

  let read = 0;
  const counted = blob
    .slice(dataStart, dataStart + entry.compressedSize)
    .stream()
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
  const inflated = entry.method === 8 ? counted.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : counted;
  return { stream: inflated.pipeThrough(guard(entry, limits)), bytesRead: () => read };
}

/** Counts, caps and checksums the uncompressed bytes. */
function guard(entry: ZipEntry, limits: ZipLimits): TransformStream<Uint8Array, Uint8Array> {
  const cap = Math.min(entry.size, limits.maxEntryBytes);
  let total = 0;
  let crc = CRC_INIT;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) throw new ZipError('CORRUPT', `${baseName(entry.name)} is bigger than its zip header says; the zip may be damaged or unsafe.`);
      crc = crc32Update(crc, chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (total !== entry.size || crc32Finish(crc) !== entry.crc32) {
        throw new ZipError('CORRUPT', `${baseName(entry.name)} is damaged in the zip (checksum mismatch). Download the export again.`);
      }
    },
  });
}

// --- Writer ------------------------------------------------------------------------------------

interface PendingEntry {
  name: Uint8Array;
  method: number;
  crc32: number;
  size: number;
  data: Uint8Array;
  time: number;
  date: number;
}

export interface ZipWriterOptions {
  /** Deflate entries (kept only when it saves space). Default true. */
  compress?: boolean;
}

/**
 * Builds a zip in memory. `add` may be called without awaiting (entries keep the order of the
 * calls); `finish` waits for all of them and returns the archive's parts, ready for a Blob.
 */
export class ZipWriter {
  private readonly slots: (PendingEntry | null)[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly names = new Set<string>();
  private finished = false;

  constructor(private readonly options: ZipWriterOptions = {}) {}

  /** Entries being compressed right now (callers can wait when there are many). */
  get inFlight(): number {
    return this.pending.size;
  }

  add(name: string, content: string | Uint8Array, modified: Date = new Date()): Promise<void> {
    if (this.finished) throw new Error('ZipWriter: already finished');
    if (this.names.has(name)) throw new Error(`ZipWriter: duplicate entry ${name}`);
    if (this.slots.length >= UINT16_MAX) throw new ZipError('TOO_MANY_ENTRIES', 'Too many files for one zip.');
    this.names.add(name);
    const slot = this.slots.length;
    this.slots.push(null);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const { time, date } = dosDateTime(modified);
    const task = (async () => {
      let method = 0;
      let body = data;
      if (this.options.compress !== false && data.byteLength > 0) {
        const deflated = await deflateRaw(data);
        if (deflated.byteLength < data.byteLength) {
          method = 8;
          body = deflated;
        }
      }
      this.slots[slot] = { name: new TextEncoder().encode(name), method, crc32: crc32(data), size: data.byteLength, data: body, time, date };
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  async finish(): Promise<Uint8Array[]> {
    await Promise.all(this.pending);
    this.finished = true;
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of this.slots) {
      if (!entry) throw new Error('ZipWriter: an entry failed');
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, SIG_LOCAL, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, UTF8_FLAG, true);
      local.setUint16(8, entry.method, true);
      local.setUint16(10, entry.time, true);
      local.setUint16(12, entry.date, true);
      local.setUint32(14, entry.crc32, true);
      local.setUint32(18, entry.data.byteLength, true);
      local.setUint32(22, entry.size, true);
      local.setUint16(26, entry.name.byteLength, true);

      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, SIG_CENTRAL, true);
      header.setUint16(4, (3 << 8) | 20, true); // made by: Unix, so the permissions below apply
      header.setUint16(6, 20, true);
      header.setUint16(8, UTF8_FLAG, true);
      header.setUint16(10, entry.method, true);
      header.setUint16(12, entry.time, true);
      header.setUint16(14, entry.date, true);
      header.setUint32(16, entry.crc32, true);
      header.setUint32(20, entry.data.byteLength, true);
      header.setUint32(24, entry.size, true);
      header.setUint16(28, entry.name.byteLength, true);
      header.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
      header.setUint32(42, offset, true);

      parts.push(new Uint8Array(local.buffer), entry.name, entry.data);
      central.push(new Uint8Array(header.buffer), entry.name);
      offset += 30 + entry.name.byteLength + entry.data.byteLength;
      if (offset > UINT32_MAX) throw new ZipError('TOO_LARGE', 'The archive would be larger than 4 GB.');
    }
    const directorySize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, SIG_END, true);
    end.setUint16(8, this.slots.length, true);
    end.setUint16(10, this.slots.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return [...parts, ...central, new Uint8Array(end.buffer)];
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** DOS date and time (local time, 2-second resolution, 1980–2107). */
export function dosDateTime(date: Date): { time: number; date: number } {
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, valid.getFullYear()));
  if (year !== valid.getFullYear()) return { time: 0, date: ((year - 1980) << 9) | (1 << 5) | 1 };
  return {
    time: (valid.getHours() << 11) | (valid.getMinutes() << 5) | Math.floor(valid.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((valid.getMonth() + 1) << 5) | valid.getDate(),
  };
}

// --- CRC-32 ------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const CRC_INIT = 0xffffffff;

function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return c;
}

function crc32Finish(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array): number {
  return crc32Finish(crc32Update(CRC_INIT, data));
}

// --- Helpers -----------------------------------------------------------------------------------

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('CORRUPT', 'The zip is damaged (impossible size).');
  return Number(value);
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** "1.2 GB", "340 MB", "12 KB". */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${rounded} ${units[unit]}`;
}
