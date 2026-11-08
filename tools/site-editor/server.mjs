#!/usr/bin/env node
/* site-editor — edit the static site's copy in the browser, write it back to disk.
 *
 *   node tools/site-editor/server.mjs [--port 4173] [--site site] [--no-open]
 *
 * Design:
 *   - serves `site/` as-is, except HTML responses get invisible <!--dsh-eN-L--> markers
 *     before every editable text node, plus an injected editor script;
 *   - a click on a text run maps back to either a source text span (HTML) or a string
 *     literal in assets/main.js / assets/arch.js, and POST /__edit/save splices exactly
 *     that span, leaving the rest of the file byte-identical;
 *   - every write is guarded by an "old text" check, so a stale page can never overwrite
 *     newer content silently;
 *   - fs.watch keeps open tabs in sync when files change elsewhere.
 */

import http from 'node:http';
import { promises as fsp, watch } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { markTextRuns, replaceTextRun } from './lib/html.mjs';
import { findVarNode, nodeAtPath, editStringNode, nodeKeys } from './lib/jsobj.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    'usage: node tools/site-editor/server.mjs [options]',
    '',
    '  --site <dir>   directory to edit (default: <repo>/site)',
    '  --port <n>     first port to try (default: 4173, increments when busy)',
    '  --no-open      do not open the browser',
    '',
    'Click any text in the page, press Enter to write it back to disk, Esc to cancel.',
  ].join('\n'));
  process.exit(0);
}
function argValue(name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  const v = argv[at + 1];
  return v && !v.startsWith('--') ? v : fallback;
}
const SITE = path.resolve(argValue('--site', path.join(HERE, '..', '..', 'site')));
const REPO = path.dirname(SITE);
const START_PORT = Number(argValue('--port', process.env.PORT || '4173'));
const NO_OPEN = argv.includes('--no-open');
const TOKEN = randomBytes(9).toString('hex');

const PAGES = [
  { file: 'index.html', label: 'Home', href: '/' },
  { file: 'architecture/index.html', label: 'Architecture', href: '/architecture/' },
  { file: 'roadmap/index.html', label: 'Roadmap', href: '/roadmap/' },
  { file: 'get-started/index.html', label: 'Get Started', href: '/get-started/' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function resolveSitePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  const abs = path.resolve(SITE, '.' + (clean.startsWith('/') ? clean : '/' + clean));
  const rel = path.relative(SITE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, 'path outside site root');
  return abs;
}

function relOf(abs) {
  return path.relative(SITE, abs).split(path.sep).join('/');
}

async function readText(rel) {
  const abs = resolveSitePath(rel);
  return { abs, src: await fsp.readFile(abs, 'utf8') };
}

/* ------------------------------------------------------------------ manifest */

let manifestCache = { key: '', value: null };

async function buildManifest() {
  const files = ['assets/arch.js', 'assets/main.js'];
  const stats = [];
  for (const f of files) {
    try {
      stats.push((await fsp.stat(path.join(SITE, f))).mtimeMs);
    } catch {
      stats.push(0);
    }
  }
  const key = files.join('|') + ':' + stats.join(',');
  if (manifestCache.key === key) return manifestCache.value;

  const i18n = { en: {}, zh: {} };
  for (const file of files) {
    let src = '';
    try {
      src = await fsp.readFile(path.join(SITE, file), 'utf8');
    } catch {
      continue;
    }
    const root = findVarNode(src, 'I18N');
    if (!root) continue;
    for (const lang of ['en', 'zh']) {
      const dict = nodeAtPath(root, [lang]);
      for (const k of nodeKeys(dict)) {
        if (!i18n[lang][k]) i18n[lang][k] = { file };
      }
    }
  }

  const pages = [];
  for (const p of PAGES) {
    try {
      const src = await fsp.readFile(path.join(SITE, p.file), 'utf8');
      const bare = src.replace(/<script[\s\S]*?<\/script>/gi, '');
      const hasLang = /class="lang__btn"|lang__btn/.test(bare);
      pages.push({ ...p, hasLang });
    } catch {
      pages.push({ ...p, hasLang: false });
    }
  }

  const value = { i18n, pages, site: path.basename(SITE) };
  manifestCache = { key, value };
  return value;
}

/* ------------------------------------------------------------------- serving */

const injectHead = (cfg) => {
  const config = JSON.stringify({ file: cfg.file, token: TOKEN, pages: PAGES }).replace(/</g, '\\u003c');
  return '<link rel="stylesheet" href="/__edit/editor.css">\n' +
    '<script>window.__SITE_EDIT__=' + config + ';</script>\n';
};

async function serveHtml(res, abs, plain) {
  const src = await fsp.readFile(abs, 'utf8');
  const rel = relOf(abs);
  if (plain) {
    const buf = Buffer.from(src, 'utf8');
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'content-length': buf.length,
    });
    return res.end(buf);
  }
  const marked = markTextRuns(src);
  let out = marked.html;
  const head = injectHead({ file: rel });
  const headAt = out.toLowerCase().lastIndexOf('</head>');
  if (headAt !== -1) out = out.slice(0, headAt) + head + out.slice(headAt);
  else {
    const openAt = out.search(/<head[^>]*>/i);
    if (openAt !== -1) {
      const gt = out.indexOf('>', openAt) + 1;
      out = out.slice(0, gt) + head + out.slice(gt);
    } else out = head + out;
  }
  const scriptTag = '<script src="/__edit/editor.js"></script>\n';
  const htmlAt = out.toLowerCase().lastIndexOf('</html>');
  if (htmlAt !== -1) out = out.slice(0, htmlAt) + scriptTag + out.slice(htmlAt);
  else out += scriptTag;
  const buf = Buffer.from(out, 'utf8');
  res.writeHead(200, {
    'content-type': MIME['.html'],
    'cache-control': 'no-store',
    'content-length': buf.length,
  });
  res.end(buf);
}

async function serveStatic(req, res, urlPath) {
  let abs = resolveSitePath(urlPath);
  let info = null;
  try {
    info = await fsp.stat(abs);
  } catch {
    info = null;
  }
  if (info && info.isDirectory()) {
    abs = path.join(abs, 'index.html');
    info = await fsp.stat(abs).catch(() => null);
  }
  if (!info || !info.isFile()) throw new HttpError(404, 'not found: ' + urlPath);

  const plain = new URL(req.url || '/', 'http://127.0.0.1').searchParams.has('plain');
  if (abs.toLowerCase().endsWith('.html')) return serveHtml(res, abs, plain);

  const ext = path.extname(abs).toLowerCase();
  const buf = await fsp.readFile(abs);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': ext === '.woff2' || ext === '.png' || ext === '.jpg' || ext === '.svg'
      ? 'public, max-age=60'
      : 'no-cache',
  });
  res.end(buf);
}

/* --------------------------------------------------------------------- save */

function assertEditableFile(rel) {
  if (!/\.(html|js)$/i.test(rel)) throw new HttpError(400, 'only .html and .js files are editable');
  if (rel.includes('..')) throw new HttpError(400, 'invalid path');
}

const undoStack = [];
const MAX_UNDO = 40;
let lastSelfWrite = { at: 0, file: '' };

async function writeFile(abs, out) {
  lastSelfWrite = { at: Date.now(), file: abs };
  await fsp.writeFile(abs, out, 'utf8');
}

async function applyEdit(req) {
  const kind = req.kind;
  if (typeof req.old !== 'string' || typeof req.new !== 'string') {
    throw new HttpError(400, 'old/new text required');
  }
  if (!Number.isInteger(req.run) || req.run < 0) throw new HttpError(400, 'run index required');

  if (kind === 'html') {
    const rel = String(req.file || '');
    assertEditableFile(rel);
    const { abs, src } = await readText(rel);
    const r = replaceTextRun(src, req.run, req.old, req.new);
    if (r.error) throw new HttpError(409, r.error);
    await writeFile(abs, r.out);
    return { ok: true, file: rel, line: r.line, changed: r.out !== src };
  }

  if (kind === 'i18n') {
    const lang = req.lang === 'zh' ? 'zh' : 'en';
    const key = String(req.key || '');
    if (!key) throw new HttpError(400, 'dictionary key required');
    // assets/arch.js is merged *over* assets/main.js (main.js: dict = I18N + ARCH_I18N),
    // so whichever file owns the key is the one that supplies the rendered string.
    for (const rel of ['assets/arch.js', 'assets/main.js']) {
      const { abs, src } = await readText(rel);
      const root = findVarNode(src, 'I18N');
      const target = nodeAtPath(root, [lang, key]);
      if (!target || target.type !== 'string') continue;
      const r = editStringNode(src, target, req.run, req.old, req.new);
      if (r.error) throw new HttpError(409, r.error);
      await writeFile(abs, r.out);
      return { ok: true, file: rel, line: r.line, lang, key };
    }
    throw new HttpError(404, '字典里没有键 ' + key + '（' + lang + '）');
  }

  if (kind === 'js') {
    const rel = String(req.file || 'assets/arch.js');
    assertEditableFile(rel);
    const rootName = String(req.root || '');
    const pathParts = Array.isArray(req.path) ? req.path : [];
    const { abs, src } = await readText(rel);
    const root = findVarNode(src, rootName);
    if (!root) throw new HttpError(404, '找不到数据根 ' + rootName);
    let target = nodeAtPath(root, pathParts);
    const lang = req.lang === 'zh' ? 'zh' : 'en';
    if (target && target.type === 'object' && target.props.has(lang)) target = target.props.get(lang);
    if (!target) throw new HttpError(404, '找不到数据字段 ' + pathParts.join('.'));
    const r = editStringNode(src, target, req.run, req.old, req.new);
    if (r.error) throw new HttpError(409, r.error);
    await writeFile(abs, r.out);
    return { ok: true, file: rel, line: r.line };
  }

  throw new HttpError(400, 'unknown edit kind: ' + String(kind));
}

async function handleSave(req) {
  const result = await applyEdit(req);
  if (result.changed !== false) {
    undoStack.push({ ...req });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  return result;
}

async function handleUndo() {
  const entry = undoStack.pop();
  if (!entry) throw new HttpError(409, '没有可撤销的改动');
  const inverse = { ...entry, old: entry.new, new: entry.old };
  try {
    const result = await applyEdit(inverse);
    return { ...result, undone: entry };
  } catch (err) {
    undoStack.push(entry);
    throw err;
  }
}

/* --------------------------------------------------------------------- diff */

function runGit(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-C', REPO, ...args], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, out: String(err && err.message) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, out: String(e.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out || err, code }));
  });
}

async function getDiff() {
  const rel = path.basename(SITE);
  const stat = await runGit(['status', '--porcelain', '--', rel]);
  const diff = await runGit(['diff', '--stat', '-U2', '--', rel]);
  return { ok: stat.ok, status: stat.out, diff: diff.out, site: rel };
}

/* --------------------------------------------------------------------- http */

function checkAuth(req) {
  const token = req.headers['x-edit-token'];
  if (token !== TOKEN) throw new HttpError(403, 'bad edit token');
  const origin = req.headers.origin;
  if (origin) {
    const expected = 'http://127.0.0.1:' + server.address().port;
    const expectedLocal = 'http://localhost:' + server.address().port;
    if (origin !== expected && origin !== expectedLocal) throw new HttpError(403, 'cross-origin write rejected');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const clients = new Map(); // ServerResponse -> clientId (one per open tab)
function broadcast(event, exceptClientId) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const [res, clientId] of clients) {
    if (exceptClientId && clientId && clientId === exceptClientId) continue;
    try { res.write(payload); } catch { /* dropped */ }
  }
}

function watchSite() {
  let timer = null;
  let pending = new Set();
  let watcher;
  try {
    watcher = watch(SITE, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (rel.includes('node_modules')) return;
      const abs = path.join(SITE, rel);
      if (Date.now() - lastSelfWrite.at < 900 && path.resolve(lastSelfWrite.file) === abs) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = Array.from(pending);
        pending = new Set();
        broadcast({ type: 'change', files });
      }, 150);
    });
  } catch (err) {
    console.error('[site-editor] watch disabled:', err.message);
    return;
  }
  process.on('exit', () => { try { watcher.close(); } catch { /* ignore */ } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/__edit/editor.js' || p === '/__edit/editor.css') {
      const file = path.join(PUBLIC, path.basename(p));
      const buf = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': buf.length,
      });
      return res.end(buf);
    }
    if (p === '/__edit/manifest') return json(res, await buildManifest());
    if (p === '/__edit/diff') return json(res, await getDiff());
    if (p === '/__edit/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.set(res, url.searchParams.get('client') || '');
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(keep); clients.delete(res); });
      return;
    }
    if (p === '/__edit/save' && req.method === 'POST') {
      checkAuth(req);
      const body = await readJson(req);
      const clientId = String(req.headers['x-edit-client'] || '');
      const result = await handleSave(body);
      // Tell every *other* tab to reload; the tab that saved updates its DOM in place
      // (or reloads itself for dictionary edits, where the page must re-render).
      broadcast({ type: 'change', files: [result.file] }, clientId);
      return json(res, result);
    }
    if (p === '/__edit/undo' && req.method === 'POST') {
      checkAuth(req);
      const result = await handleUndo();
      broadcast({ type: 'change', files: [result.file] });
      return json(res, result);
    }
    if (p.startsWith('/__edit/')) throw new HttpError(404, 'unknown editor endpoint');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return await serveStatic(req, res, p);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[site-editor]', err);
    if (res.headersSent) return res.end();
    return json(res, { ok: false, error: err.message || String(err) }, status);
  }
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  } catch { /* best effort */ }
}

async function listen(port, tries = 0) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    return port;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE' && tries < 20) return listen(port + 1, tries + 1);
    throw err;
  }
}

const port = await listen(START_PORT);
watchSite();
const url = 'http://127.0.0.1:' + port + '/';
console.log('');
console.log('  site-editor  ' + url);
console.log('  serving      ' + SITE);
console.log('  edit token   ' + TOKEN + '  (injected into the page; not stored)');
console.log('  在浏览器里点任意文字即可修改，回车 / 点别处保存，Esc 取消。Ctrl+C 结束。');
console.log('');
if (!NO_OPEN) openBrowser(url);
