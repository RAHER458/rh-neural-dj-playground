#!/usr/bin/env node
/**
 * Публикация фронтенда RH—MUSIC на Cloudflare Pages (Direct Upload API).
 *
 * Порядок как у wrangler:
 *   1. upload-token (JWT)
 *   2. POST /pages/assets/upload      — файлы (base64)
 *   3. POST /pages/assets/upsert-hashes
 *   4. POST /pages/projects/{name}/deployments — манифест + branch + _worker.bundle
 *
 * Файл web/_worker.js (прокси /api → Worker) уезжает отдельным полем
 * _worker.bundle как Pages Function в advanced mode.
 *
 * Переменные окружения:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *   PAGES_PROJECT (по умолчанию rh-music), PAGES_BRANCH (main)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const webDir = join(root, 'public');

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const projectName = process.env.PAGES_PROJECT || 'rh-ai-dj-lab';
const branch = process.env.PAGES_BRANCH || 'main';
const COMPAT_DATE = '2025-01-15';

if (!token || !accountId) {
  console.error('Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

async function cf(path, init = {}, authToken = token) {
  const response = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${authToken}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 600) };
  }
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare ${path} → HTTP ${response.status} ${details || text.slice(0, 300)}`);
  }
  return payload.result;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CRLF = '\r\n';

function buildMultipart(parts) {
  const boundary = '----RHMusic' + randomBytes(12).toString('hex');
  const chunks = [];
  for (const part of parts) {
    const head = `--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="${part.name}"`
      + (part.filename ? `; filename="${part.filename}"` : '') + CRLF
      + (part.type ? `Content-Type: ${part.type}${CRLF}` : '')
      + CRLF;
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

/* 1. Проект */
let project = null;
try {
  project = await cf(`/accounts/${accountId}/pages/projects/${projectName}`);
  console.log(`Проект найден: ${project.name}`);
} catch (error) {
  if (!/HTTP 404/.test(error.message)) throw error;
  project = await cf(`/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, production_branch: branch }),
  });
  console.log(`Проект создан: ${project.name}`);
}

/* 2. Файлы: _worker.js — не статика, а Pages Function */
const files = [];
for (const full of await walk(webDir)) {
  const info = await stat(full);
  if (!info.isFile()) continue;
  const contents = await readFile(full);
  const rel = relative(webDir, full).split(sep).join('/');
  const ext = rel.includes('.') ? rel.split('.').pop() : '';
  const isEntry = rel === '_worker.js';
  // Хеш считается так же, как у wrangler: base64(содержимое) + расширение, без ведущего слэша.
  const hash = createHash('sha256')
    .update(contents.toString('base64') + ext)
    .digest('hex')
    .slice(0, 32);
  const type = rel === '_headers' || rel === '_redirects'
    ? 'text/plain; charset=utf-8'
    : (MIME['.' + ext] || 'application/octet-stream');
  files.push({
    path: '/' + rel,
    hash: isEntry ? '_worker.js' : hash,
    contents,
    type,
    isEntry,
  });
}

console.log(`Файлов: ${files.length} (из них функций: ${files.filter((f) => f.isEntry).length})`);

/* 3. JWT и загрузка статики */
const { jwt } = await cf(`/accounts/${accountId}/pages/projects/${projectName}/upload-token`);
if (!jwt) throw new Error('Не удалось получить upload-token');

const assets = files.filter((file) => !file.isEntry);
await cf('/pages/assets/upload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(assets.map((file) => ({
    key: file.hash,
    value: file.contents.toString('base64'),
    metadata: { contentType: file.type },
    base64: true,
  }))),
}, jwt);

try {
  await cf('/pages/assets/upsert-hashes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: assets.map((file) => file.hash) }),
  }, jwt);
} catch (error) {
  console.warn('upsert-hashes:', error.message);
}

/* 4. Манифест и вложенный бандл функции */
const manifest = {};
for (const file of assets) manifest[file.path] = file.hash;

const parts = [
  { name: 'manifest', data: JSON.stringify(manifest), type: 'application/json' },
  { name: 'branch', data: branch },
  { name: 'commit_hash', data: createHash('sha1').update(assets.map((f) => f.hash).sort().join(':')).digest('hex') },
  { name: 'commit_message', data: 'RH AI DJ Lab deploy' },
  { name: 'commit_dirty', data: 'false' },
];

const entryFile = files.find((file) => file.isEntry);
if (entryFile) {
  const inner = buildMultipart([
    {
      name: 'metadata',
      data: JSON.stringify({ main_module: '_worker.js', compatibility_date: COMPAT_DATE, bindings: [] }),
      type: 'application/json',
    },
    { name: '_worker.js', filename: '_worker.js', data: entryFile.contents, type: 'application/javascript+module' },
  ]);
  console.log(`Pages Function: ${entryFile.contents.length} байт`);
  parts.push({ name: '_worker.bundle', filename: '_worker.bundle', data: inner.body, type: 'application/octet-stream' });
}

const { body, contentType } = buildMultipart(parts);
const deployment = await cf(
  `/accounts/${accountId}/pages/projects/${projectName}/deployments`,
  { method: 'POST', headers: { 'Content-Type': contentType }, body },
);

console.log(`Деплой создан: ${deployment.id}`);
console.log(`Статус: ${deployment.latest_stage ? deployment.latest_stage.status : 'unknown'}`);
console.log(`URL: ${deployment.url}`);
console.log(`Production: https://${projectName}.pages.dev`);