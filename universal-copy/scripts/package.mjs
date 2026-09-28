// Builds the extension and packs the contents of dist/ into a zip for the Chrome Web Store:
//
//   npm run package        (typecheck + unit tests + this script)
//   node scripts/package.mjs
//
// Before zipping it checks the things that get an upload refused or an extension rejected:
// the manifest is the shipped one (no e2e name or test permissions), the version matches
// package.json, every file the manifest and the HTML pages point to exists, icons are real PNGs
// of the declared size, there are no source maps, reserved `_` names or remote scripts.
// The zip is deterministic (sorted entries, fixed timestamps) and is read back and compared
// with dist/ before the script reports success. No dependencies beyond Node itself.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const errors = [];
const warnings = [];

// --- Build ------------------------------------------------------------------------------------

const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail('build failed');

// --- Collect files ----------------------------------------------------------------------------

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(relative(dist, full).split(sep).join('/'));
  }
  return out;
}

const files = (await listFiles(dist)).sort();
const fileSet = new Set(files);

// --- Manifest ---------------------------------------------------------------------------------

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const source = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.version !== pkg.version) errors.push(`manifest version ${manifest.version} ≠ package.json ${pkg.version}`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version) || manifest.version.split('.').some((part) => Number(part) > 65535)) {
  errors.push(`version "${manifest.version}" is not 1-4 dot-separated integers (0-65535)`);
}
if (/\be2e\b/i.test(manifest.name)) errors.push(`manifest name "${manifest.name}" is the test build's`);
if (manifest.name.length > 75) errors.push(`name is ${manifest.name.length} characters (store limit 75)`);
if (manifest.short_name && manifest.short_name.length > 12) warnings.push(`short_name "${manifest.short_name}" is longer than 12 characters and may be truncated`);
if (!manifest.description) errors.push('description is missing');
else if (manifest.description.length > 132) errors.push(`description is ${manifest.description.length} characters (store limit 132)`);

// The shipped permissions must be exactly the ones in static/manifest.json: the e2e build adds
// host access and test-only permissions that must never reach the store.
for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions', 'content_scripts', 'commands']) {
  if (JSON.stringify(manifest[key] ?? null) !== JSON.stringify(source[key] ?? null)) {
    errors.push(`manifest "${key}" differs from static/manifest.json`);
  }
}

// --- Referenced files -------------------------------------------------------------------------

function requireFile(path, what) {
  const clean = posix.normalize(path.replace(/^\//, ''));
  if (!fileSet.has(clean)) errors.push(`${what} "${path}" is not in dist/`);
  return clean;
}

const icons = { ...manifest.icons, ...manifest.action?.default_icon };
if (!manifest.icons?.['128']) errors.push('no 128×128 icon (the store requires one)');
for (const [size, path] of Object.entries(icons)) {
  const clean = requireFile(path, `icon ${size}`);
  if (!fileSet.has(clean)) continue;
  const png = await readFile(join(dist, clean));
  const isPng = png.length > 24 && png.readUInt32BE(0) === 0x89504e47 && png.toString('latin1', 12, 16) === 'IHDR';
  if (!isPng) errors.push(`icon ${clean} is not a PNG`);
  else if (png.readUInt32BE(16) !== Number(size) || png.readUInt32BE(20) !== Number(size)) {
    errors.push(`icon ${clean} is ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}, declared ${size}×${size}`);
  }
}

const pages = [
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  manifest.options_page,
  ...Object.values(manifest.chrome_url_overrides ?? {}),
].filter(Boolean);
for (const page of pages) requireFile(page, 'page');
if (manifest.background?.service_worker) requireFile(manifest.background.service_worker, 'service worker');
for (const script of manifest.content_scripts ?? []) {
  for (const path of [...(script.js ?? []), ...(script.css ?? [])]) requireFile(path, 'content script');
}

for (const page of files.filter((file) => file.endsWith('.html'))) {
  const html = await readFile(join(dist, page), 'utf8');
  // Tags that load something (links a user clicks, <a href>, may point anywhere).
  for (const [, tag, attrs] of html.matchAll(/<(script|link|img|iframe|source|video|audio)\b([^>]*)>/gi)) {
    const url = /\b(?:src|href)\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!url || /^(data|chrome):/i.test(url)) continue;
    if (/^(https?:)?\/\//i.test(url)) {
      errors.push(`${page} <${tag}> loads a remote resource: ${url}`);
      continue;
    }
    requireFile(posix.join(posix.dirname(page), url.split(/[?#]/)[0]), `${page} <${tag}>`);
  }
}

// --- Content rules ----------------------------------------------------------------------------

for (const file of files) {
  const segments = file.split('/');
  if (segments.some((segment) => segment.startsWith('_') && segment !== '_locales')) {
    errors.push(`${file}: names starting with "_" are reserved by Chrome`);
  }
  if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(file) || segments.some((segment) => segment.startsWith('.'))) {
    errors.push(`${file}: hidden or OS junk file`);
  }
  if (file.endsWith('.map')) errors.push(`${file}: source maps don't belong in the store package`);
  if (/\.(js|css|html)$/.test(file)) {
    const text = await readFile(join(dist, file), 'utf8');
    if (text.includes('sourceMappingURL')) errors.push(`${file}: contains a sourceMappingURL`);
    if (text.includes('__E2E__')) errors.push(`${file}: contains the e2e flag`);
    if (/\bimportScripts\s*\(\s*['"]https?:/.test(text) || /\bimport\s*\(\s*['"]https?:/.test(text)) {
      errors.push(`${file}: loads remote code`);
    }
  }
}

// --- Git state (informational) ------------------------------------------------------------------

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.');
if (dirty.status === 0 && dirty.stdout.trim()) warnings.push('uncommitted changes in this folder: the zip will not match a commit');

if (errors.length) fail(`${errors.length} problem(s):\n${errors.map((error) => `  ✗ ${error}`).join('\n')}`);

// --- Zip --------------------------------------------------------------------------------------

// 1980-01-01 00:00 in DOS format: fixed so the same dist/ always gives the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

const locals = [];
const centrals = [];
const entries = [];
let offset = 0;
for (const file of files) {
  const data = await readFile(join(dist, file));
  const name = Buffer.from(file, 'utf8');
  const deflated = deflateRawSync(data, { level: 9 });
  const method = deflated.length < data.length ? 8 : 0;
  const body = method === 8 ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, zip 2.0 (so the permissions below apply)
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_FLAG, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
  central.writeUInt32LE(offset, 42);

  locals.push(local, name, body);
  centrals.push(central, name);
  entries.push({ file, data });
  offset += local.length + name.length + body.length;
}

const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, ...centrals, end]);

// --- Read it back -----------------------------------------------------------------------------

function readBack(buffer) {
  const endAt = buffer.length - 22;
  if (buffer.readUInt32LE(endAt) !== 0x06054b50) throw new Error('no end of central directory');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header #${i}`);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = buffer.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

const back = readBack(zip);
if (back.size !== entries.length) fail(`zip has ${back.size} entries, expected ${entries.length}`);
for (const { file, data } of entries) {
  if (!back.get(file)?.equals(data)) fail(`zip entry ${file} does not match dist/`);
}
if (!back.has('manifest.json')) fail('manifest.json is not at the root of the zip');

const releaseDir = join(root, 'release');
await mkdir(releaseDir, { recursive: true });
const zipName = `${basename(root)}-${manifest.version}.zip`;
await writeFile(join(releaseDir, zipName), zip);

const unpacked = entries.reduce((sum, entry) => sum + entry.data.length, 0);
console.log(`\n${manifest.name} ${manifest.version}${commit.status === 0 ? ` (commit ${commit.stdout.trim()})` : ''}`);
console.log(`  ${files.length} files, ${kb(unpacked)} unpacked → release/${zipName} ${kb(zip.length)}`);
console.log(`  sha256 ${createHash('sha256').update(zip).digest('hex')}`);
console.log(`  permissions: ${[...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])].join(', ') || 'none'}`);
if (manifest.optional_host_permissions) console.log(`  optional host permissions: ${manifest.optional_host_permissions.join(', ')}`);
for (const warning of warnings) console.log(`  ! ${warning}`);
if (!existsSync(join(root, 'PRIVACY.md'))) console.log('  ! no PRIVACY.md: the store needs a privacy policy URL');

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fail(message) {
  console.error(`\npackage: ${message}`);
  process.exit(1);
}
