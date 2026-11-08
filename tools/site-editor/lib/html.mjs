/* Source-preserving HTML text scanner.
 *
 * The site is plain hand-written HTML: no build step, mixed line endings, entities
 * sprinkled around. Rather than re-serialise a parsed tree (which would rewrite the
 * whole file), we scan the *source text* and record the exact [start, end) span of
 * every text node. Edits then splice a single span, so the rest of the file stays
 * byte-identical.
 *
 * Fidelity notes (they matter for matching the browser DOM):
 *   - entity references are decoded (`&amp;` -> `&`), because DOM text is decoded;
 *   - CRLF / CR are normalised to LF, because the HTML parser does that to text nodes;
 *   - content of script/style/textarea/title... is skipped (RCDATA/RAWTEXT), so text
 *     runs inside them are never reported and never counted;
 *   - text node indices are stable across text-only edits, which is what the editor
 *     uses as a run id (see `markTextRuns`).
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Elements whose content is not parsed as normal markup; their text is not editable
// by this tool (title is also overwritten by main.js META, textarea/xmp contain code).
const RAW_TEXT = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
  'plaintext',
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  times: '\u00d7', divide: '\u00f7', middot: '\u00b7', bull: '\u2022',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  harr: '\u2194', deg: '\u00b0', plusmn: '\u00b1', frac12: '\u00bd',
  emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009', shy: '\u00ad',
  zwj: '\u200d', zwnj: '\u200c',
};

export function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const value = ENTITIES[body];
    return value === undefined ? match : value;
  });
}

/** Escape plain text so it can be spliced into HTML text content. */
export function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;');
}

export function buildLineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineAt(src, pos, lineStarts) {
  const starts = lineStarts || buildLineIndex(src);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function findTagEnd(src, from) {
  let quote = null;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

/**
 * Scan `src` and return every text node with its source span.
 * @returns {{start:number,end:number,raw:string,text:string,parent:string,index:number}[]}
 */
export function tokenize(src) {
  const nodes = [];
  const stack = [];
  let parent = '#root';
  let i = 0;

  const push = (start, end) => {
    if (end <= start) return;
    const raw = src.slice(start, end);
    nodes.push({
      start,
      end,
      raw,
      text: decodeEntities(raw).replace(/\r\n?/g, '\n'),
      parent,
      index: nodes.length,
    });
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { push(i, src.length); break; }
    if (lt > i) push(i, lt);
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const next = src[i + 1];
    if (next === '!' || next === '?') {
      const end = src.indexOf('>', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const nameMatch = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(src.slice(i, i + 64));
    const end = findTagEnd(src, i);
    if (end === -1) { push(i, src.length); break; }
    if (!nameMatch) { i = end + 1; continue; }

    const name = nameMatch[1].toLowerCase();
    const tagText = src.slice(i, end + 1);
    const closing = next === '/';

    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
      parent = stack.length ? stack[stack.length - 1] : '#root';
      i = end + 1;
      continue;
    }

    const selfClosing = /\/\s*>$/.test(tagText) || VOID.has(name);
    if (!selfClosing) stack.push(name);
    parent = stack.length ? stack[stack.length - 1] : '#root';
    i = end + 1;

    if (!selfClosing && RAW_TEXT.has(name)) {
      const close = new RegExp('</' + name + '\\s*>', 'i');
      const m = close.exec(src.slice(i));
      if (!m) break;
      i += m.index; // leave the closing tag for the loop so the stack unwinds normally
    }
  }

  return nodes;
}

export function isEditableText(node) {
  return node.text.trim().length > 0 && !RAW_TEXT.has(node.parent);
}

/**
 * Wrap every editable text run in `<!--dsh-e<run>-<line>-->` markers so the browser
 * can map a clicked DOM text node straight back to its source run id. Markers are
 * HTML comments: invisible, layout-neutral and preserved by the parser, which also
 * guarantees the text node that follows the marker is exactly that run.
 */
export function markTextRuns(src) {
  const nodes = tokenize(src);
  const lines = buildLineIndex(src);
  let out = '';
  let cursor = 0;
  let marked = 0;
  for (const node of nodes) {
    if (!isEditableText(node)) continue;
    out += src.slice(cursor, node.start);
    out += '<!--dsh-e' + node.index + '-' + lineAt(src, node.start, lines) + '-->';
    cursor = node.start;
    marked += 1;
  }
  out += src.slice(cursor);
  return { html: out, nodes: nodes.length, marked };
}

/**
 * Replace the text of source run `run` (as numbered by `tokenize`).
 * @returns {{out:string,line:number}|{error:string}}
 */
export function replaceTextRun(src, run, oldText, newText) {
  if (!Number.isInteger(run) || run < 0) return { error: '无效的文本编号' };
  const nodes = tokenize(src);
  const node = nodes[run];
  if (!node) return { error: '找不到第 ' + run + ' 段文字：页面与文件不同步，请刷新后重试' };
  if (node.text !== oldText) {
    return { error: '这段文字已经变了（可能刚被其它地方修改），请刷新页面后重试' };
  }
  if (node.text === newText) return { out: src, line: lineAt(src, node.start) };
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const encoded = escapeText(newText).replace(/\n/g, eol);
  return {
    out: src.slice(0, node.start) + encoded + src.slice(node.end),
    line: lineAt(src, node.start),
  };
}

/** Line of a run in the file, used for the "written to file:line" feedback. */
export function runLine(src, run) {
  const nodes = tokenize(src);
  const node = nodes[run];
  return node ? lineAt(src, node.start) : 0;
}
