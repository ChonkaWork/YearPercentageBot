import { crc32 as nodeCrc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { JsonArrayError, JsonArraySplitter } from '../src/core/import/jsonArray';
import { crc32, dosDateTime, formatBytes, looksLikeZip, openZipEntry, readZipDirectory, ZipError, ZipWriter, type ZipEntry } from '../src/core/import/zip';

// --- Helpers: zips built independently with node:zlib, and readers for the results --------------

interface RawEntry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8 | 12;
  flags?: number;
  /** Size written in the headers instead of the real one (for bomb/damage tests). */
  declaredSize?: number;
  crc?: number;
}

const encode = (text: string) => new TextEncoder().encode(text);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A little-endian record: [bytes, value] pairs (8 means a 64-bit field). */
function record(fields: [1 | 2 | 4 | 8, number | bigint][]): Uint8Array {
  const view = new DataView(new ArrayBuffer(fields.reduce((sum, [size]) => sum + size, 0)));
  let at = 0;
  for (const [size, value] of fields) {
    if (size === 1) view.setUint8(at, Number(value));
    else if (size === 2) view.setUint16(at, Number(value), true);
    else if (size === 4) view.setUint32(at, Number(value), true);
    else view.setBigUint64(at, BigInt(value), true);
    at += size;
  }
  return new Uint8Array(view.buffer);
}

/** A zip written the way other tools do (optionally Zip64), without our writer. */
function nodeZip(entries: RawEntry[], { zip64 = false, comment = '' } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encode(entry.data) : entry.data;
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = encode(entry.name);
    const size = entry.declaredSize ?? data.length;
    const crc = entry.crc ?? nodeCrc32(data);
    const flags = (entry.flags ?? 0) | 0x0800;
    const descriptor = (flags & 0x0008) !== 0;
    // With a data descriptor, the local header has no sizes (the central directory does).
    const local = record([
      [4, 0x04034b50], [2, 20], [2, flags], [2, method], [2, 0], [2, 0],
      [4, descriptor ? 0 : crc], [4, descriptor ? 0 : body.length], [4, descriptor ? 0 : size],
      [2, name.length], [2, 0],
    ]);
    const trailer = descriptor ? record([[4, 0x08074b50], [4, crc], [4, body.length], [4, size]]) : new Uint8Array();
    const extra = zip64 ? record([[2, 0x0001], [2, 24], [8, size], [8, body.length], [8, offset]]) : new Uint8Array();
    const central = record([
      [4, 0x02014b50], [2, zip64 ? 45 : 20], [2, zip64 ? 45 : 20], [2, flags], [2, method], [2, 0], [2, 0],
      [4, crc], [4, zip64 ? 0xffffffff : body.length], [4, zip64 ? 0xffffffff : size],
      [2, name.length], [2, extra.length], [2, 0], [2, 0], [2, 0], [4, 0], [4, zip64 ? 0xffffffff : offset],
    ]);
    locals.push(local, name, body, trailer);
    centrals.push(central, name, extra);
    offset += local.length + name.length + body.length + trailer.length;
  }
  const directory = concat(centrals);
  const tail: Uint8Array[] = [];
  if (zip64) {
    tail.push(
      record([[4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0], [8, entries.length], [8, entries.length], [8, directory.length], [8, offset]]),
      record([[4, 0x07064b50], [4, 0], [8, offset + directory.length], [4, 1]]),
    );
  }
  const commentBytes = encode(comment);
  const end = record([
    [4, 0x06054b50], [2, 0], [2, 0], [2, zip64 ? 0xffff : entries.length], [2, zip64 ? 0xffff : entries.length],
    [4, zip64 ? 0xffffffff : directory.length], [4, zip64 ? 0xffffffff : offset], [2, commentBytes.length],
  ]);
  return concat([...locals, directory, ...tail, end, commentBytes]);
}

interface NodeFile {
  data: Uint8Array;
  method: number;
  time: number;
  date: number;
}

/** Reads a zip with node:zlib only (checks that our writer's output is a normal zip). */
function nodeUnzip(bytes: Uint8Array): Map<string, NodeFile> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out = new Map<string, NodeFile>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(flags & 0x0800).toBe(0x0800);
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.slice(dataAt, dataAt + size);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(nodeCrc32(data)).toBe(crc);
    out.set(name, { data, method, time, date });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function entryText(blob: Blob, entry: ZipEntry, limits?: Parameters<typeof openZipEntry>[2]): Promise<string> {
  return readAll((await openZipEntry(blob, entry, limits)).stream);
}

async function zipError(promise: Promise<unknown>): Promise<ZipError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error('expected a ZipError');
}

const JSON_TEXT = JSON.stringify([{ title: 'Привіт, café', text: 'x'.repeat(5000) }]);

// --- CRC and helpers ---------------------------------------------------------------------------

describe('zip helpers', () => {
  it('computes CRC-32 like zlib', () => {
    const data = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    expect(crc32(data)).toBe(0x414fa339);
    expect(crc32(new Uint8Array())).toBe(0);
    const random = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7919) % 256);
    expect(crc32(random)).toBe(nodeCrc32(random));
  });

  it('encodes DOS dates in local time and clamps to 1980–2107', () => {
    expect(dosDateTime(new Date(2026, 8, 27, 14, 3, 9))).toEqual({ time: (14 << 11) | (3 << 5) | 4, date: (46 << 9) | (9 << 5) | 27 });
    expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
  });

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
  });
});

// --- Writer -------------------------------------------------------------------------------------

describe('ZipWriter', () => {
  it('writes a standard zip: deflated when smaller, stored otherwise, UTF-8 names, dates', async () => {
    const writer = new ZipWriter();
    const modified = new Date(2024, 2, 1, 10, 2, 4);
    const markdown = `# Notes\n\n${'Sorting in Python. '.repeat(200)}`;
    const noise = Uint8Array.from({ length: 300 }, (_, index) => (index * 2654435761) >>> 24);
    // Not awaited one by one: entries keep the order of the calls.
    const pending = [writer.add('Sorting in Python 2024-03-01.md', markdown, modified), writer.add('Привіт (2).md', 'short'), writer.add('noise.bin', noise)];
    await Promise.all(pending);
    const parts = await writer.finish();
    const bytes = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());

    const files = nodeUnzip(bytes);
    expect([...files.keys()]).toEqual(['Sorting in Python 2024-03-01.md', 'Привіт (2).md', 'noise.bin']);
    expect(new TextDecoder().decode(files.get('Sorting in Python 2024-03-01.md')?.data)).toBe(markdown);
    expect(files.get('Sorting in Python 2024-03-01.md')?.method).toBe(8);
    expect(files.get('Привіт (2).md')?.method).toBe(0);
    expect(files.get('noise.bin')?.method).toBe(0);
    expect(Array.from(files.get('noise.bin')?.data ?? [])).toEqual(Array.from(noise));
    expect(files.get('Sorting in Python 2024-03-01.md')).toMatchObject(dosDateTime(modified));
  });

  it('round-trips through the reader', async () => {
    const writer = new ZipWriter({ compress: false });
    void writer.add('a/conversations.json', JSON_TEXT);
    const blob = new Blob((await writer.finish()) as BlobPart[]);
    expect(await looksLikeZip(blob)).toBe(true);
    const [entry] = await readZipDirectory(blob);
    expect(entry).toMatchObject({ name: 'a/conversations.json', method: 0 });
    expect(await entryText(blob, entry as ZipEntry)).toBe(JSON_TEXT);
  });

  it('refuses duplicate names and an empty writer still makes a valid zip', async () => {
    const writer = new ZipWriter();
    void writer.add('index.md', '# x');
    expect(() => writer.add('index.md', '# y')).toThrow(/duplicate/);
    const empty = new Blob((await new ZipWriter().finish()) as BlobPart[]);
    expect(await readZipDirectory(empty)).toEqual([]);
  });
});

// --- Reader -------------------------------------------------------------------------------------

describe('zip reader', () => {
  it('reads stored and deflated entries from zips made by other tools', async () => {
    const blob = new Blob([
      nodeZip([
        { name: 'Export/conversations.json', data: JSON_TEXT },
        { name: 'Export/user.json', data: '{"id":"u"}', method: 0 },
      ]) as BlobPart,
    ]);
    const entries = await readZipDirectory(blob);
    expect(entries.map((entry) => [entry.name, entry.method])).toEqual([
      ['Export/conversations.json', 8],
      ['Export/user.json', 0],
    ]);
    expect(await entryText(blob, entries[0] as ZipEntry)).toBe(JSON_TEXT);
    expect(await entryText(blob, entries[1] as ZipEntry)).toBe('{"id":"u"}');
  });

  it('reports progress in compressed bytes', async () => {
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: JSON_TEXT }]) as BlobPart]);
    const [entry] = await readZipDirectory(blob);
    const opened = await openZipEntry(blob, entry as ZipEntry);
    expect(opened.bytesRead()).toBe(0);
    await readAll(opened.stream);
    expect(opened.bytesRead()).toBe(entry?.compressedSize);
  });

  it('reads entries written with a data descriptor (sizes only in the central directory)', async () => {
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: JSON_TEXT, flags: 0x0008 }]) as BlobPart]);
    const [entry] = await readZipDirectory(blob);
    expect(await entryText(blob, entry as ZipEntry)).toBe(JSON_TEXT);
  });

  it('reads Zip64 archives', async () => {
    const blob = new Blob([nodeZip([{ name: 'img/a.png', data: 'png', method: 0 }, { name: 'conversations.json', data: JSON_TEXT }], { zip64: true }) as BlobPart]);
    const entries = await readZipDirectory(blob);
    expect(entries.map((entry) => entry.name)).toEqual(['img/a.png', 'conversations.json']);
    expect(entries[1]?.size).toBe(new TextEncoder().encode(JSON_TEXT).length);
    expect(await entryText(blob, entries[1] as ZipEntry)).toBe(JSON_TEXT);
  });

  it('finds the directory behind an archive comment', async () => {
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: '[]' }], { comment: 'Exported by a tool, PK\u0005\u0006 inside' }) as BlobPart]);
    expect((await readZipDirectory(blob)).map((entry) => entry.name)).toEqual(['conversations.json']);
  });

  it('refuses files that are not zips, and truncated zips', async () => {
    expect(await looksLikeZip(new Blob(['[{"title":"x"}]']))).toBe(false);
    expect((await zipError(readZipDirectory(new Blob(['not a zip at all, just some text that is long enough'])))).code).toBe('NOT_ZIP');
    const bytes = nodeZip([{ name: 'conversations.json', data: JSON_TEXT }]);
    expect(await looksLikeZip(new Blob([bytes.slice(0, 200) as BlobPart]))).toBe(true);
    expect((await zipError(readZipDirectory(new Blob([bytes.slice(0, bytes.length - 30) as BlobPart])))).code).toBe('NOT_ZIP');
  });

  it('caps the number of entries', async () => {
    const blob = new Blob([nodeZip(Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.txt`, data: 'x', method: 0 as const }))) as BlobPart]);
    const error = await zipError(readZipDirectory(blob, { maxEntries: 4, maxDirectoryBytes: 1e6, maxEntryBytes: 1e6 }));
    expect(error.code).toBe('TOO_MANY_ENTRIES');
    expect(error.message).toBe('This zip has 5 files, more than the 4 it can open.');
  });

  it('refuses an entry whose declared size is over the cap before inflating anything', async () => {
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: JSON_TEXT }]) as BlobPart]);
    const [entry] = await readZipDirectory(blob);
    const error = await zipError(openZipEntry(blob, entry as ZipEntry, { maxEntries: 10, maxDirectoryBytes: 1e6, maxEntryBytes: 1000 }));
    expect(error.code).toBe('TOO_LARGE');
    expect(error.message).toMatch(/^conversations\.json is 4\.9 KB, more than the 1000 bytes/);
  });

  it('stops inflating a bomb that lies about its size', async () => {
    const bomb = 'A'.repeat(2_000_000);
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: bomb, declaredSize: 1000 }]) as BlobPart]);
    const [entry] = await readZipDirectory(blob);
    expect(entry?.size).toBe(1000);
    expect(entry?.compressedSize).toBeLessThan(10_000);
    const error = await readAll((await openZipEntry(blob, entry as ZipEntry)).stream).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ZipError);
    expect((error as ZipError).code).toBe('CORRUPT');
    expect((error as ZipError).message).toMatch(/bigger than its zip header says/);
  });

  it('detects damaged data (CRC mismatch)', async () => {
    const blob = new Blob([nodeZip([{ name: 'conversations.json', data: JSON_TEXT, crc: 1234 }]) as BlobPart]);
    const [entry] = await readZipDirectory(blob);
    await expect(readAll((await openZipEntry(blob, entry as ZipEntry)).stream)).rejects.toMatchObject({ code: 'CORRUPT', message: expect.stringMatching(/checksum mismatch/) });
  });

  it('refuses encrypted entries and unknown compression methods', async () => {
    const blob = new Blob([
      nodeZip([
        { name: 'secret.json', data: '[]', method: 0, flags: 0x0001 },
        { name: 'bzip.json', data: '[]', method: 12 },
      ]) as BlobPart,
    ]);
    const [secret, bzip] = await readZipDirectory(blob);
    expect((await zipError(openZipEntry(blob, secret as ZipEntry))).code).toBe('ENCRYPTED');
    expect((await zipError(openZipEntry(blob, bzip as ZipEntry))).code).toBe('UNSUPPORTED_METHOD');
  });
});

// --- JSON array splitter ------------------------------------------------------------------------

function split(chunks: string[]): string[] {
  const splitter = new JsonArraySplitter();
  const out = chunks.flatMap((chunk) => splitter.push(chunk));
  splitter.end();
  return out;
}

function splitError(chunks: string[]): string {
  try {
    split(chunks);
  } catch (error) {
    if (error instanceof JsonArrayError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('JsonArraySplitter', () => {
  const tricky = [
    { title: 'Brackets ] [ } { and commas, inside strings', parts: ['"quoted"', 'back\\slash\\', 'tab\tnew\nline'] },
    { title: 'Привіт 👋 café', nested: { a: [1, [2, [3]]], b: null } },
    42,
    'a string element',
    [],
    { empty: {} },
  ];
  const text = `﻿ [\n${tricky.map((item) => JSON.stringify(item)).join(' ,\n ')}\n] \n`;

  it('splits the elements of an array', () => {
    expect(split([text]).map((element) => JSON.parse(element))).toEqual(tricky);
  });

  it('gives the same result for any chunking, even inside strings and escapes', () => {
    const expected = split([text]);
    expect(split(Array.from(text))).toEqual(expected);
    for (const size of [2, 3, 7, 16, 61]) {
      const chunks: string[] = [];
      for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
      expect(split(chunks)).toEqual(expected);
    }
  });

  it('handles an empty array', () => {
    expect(split(['  [ ]  '])).toEqual([]);
  });

  it('reports what is wrong', () => {
    expect(splitError(['{"conversations": []}'])).toBe('NOT_ARRAY');
    expect(splitError(['   '])).toBe('EMPTY');
    expect(splitError(['[{"a": 1}, {"b": '])).toBe('TRUNCATED');
    expect(splitError(['[1,,2]'])).toBe('SYNTAX');
    expect(splitError(['[,1]'])).toBe('SYNTAX');
    expect(splitError(['[1,]'])).toBe('SYNTAX');
    expect(splitError(['[1] x'])).toBe('SYNTAX');
    expect(splitError(['[1}'])).toBe('SYNTAX');
  });
});
