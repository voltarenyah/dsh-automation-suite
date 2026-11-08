/* Tiny position-aware scanner for the plain object/array literals that carry the
 * site copy (`var I18N = {...}` in assets/main.js, `GROUPS` / `COMPONENTS` /
 * `PRESETS` / `I18N` in assets/arch.js).
 *
 * It is not a JS parser. It only needs to answer two questions without disturbing
 * formatting:
 *   1. where does the string literal at path [root, ...keys] start and end?
 *   2. which run of text inside its decoded value is the one the user clicked?
 *
 * Everything else in the file stays byte-identical: we splice the literal only.
 */

import { tokenize, escapeText } from './html.mjs';

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUM = /^[0-9]/;

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

export function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && isWs(src[i])) i += 1;
    if (src.startsWith('//', i)) {
      const e = src.indexOf('\n', i);
      i = e === -1 ? src.length : e + 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    return i;
  }
}

export function decodeJsString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const d = raw[++i];
    switch (d) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x':
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case 'u':
        if (raw[i + 1] === '{') {
          const end = raw.indexOf('}', i);
          out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
          i = end;
        } else {
          out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      case '\n': break;
      case '\r': if (raw[i + 1] === '\n') i += 1; break;
      default: out += d === undefined ? '' : d;
    }
  }
  return out;
}

export function encodeJsString(value, quote) {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\u2028') out += '\\u2028';
    else if (ch === '\u2029') out += '\\u2029';
    else if (ch.length === 1 && ch.charCodeAt(0) < 0x20) {
      out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    } else out += ch;
  }
  return quote + out + quote;
}

function parseStringLiteral(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === quote) {
      return {
        type: 'string',
        start: i,
        end: j + 1,
        value: decodeJsString(src.slice(i + 1, j)),
      };
    }
    if (ch === '\n' && quote !== '`') return null; // unterminated
    j += 1;
  }
  return null;
}

function parseObjectLiteral(src, start) {
  const props = new Map();
  let i = skipTrivia(src, start + 1);
  while (i < src.length && src[i] !== '}') {
    let key;
    if (src[i] === '"' || src[i] === "'") {
      const lit = parseStringLiteral(src, i);
      if (!lit) break;
      key = lit.value;
      i = lit.end;
    } else {
      const m = IDENT.exec(src.slice(i));
      if (!m) break;
      key = m[0];
      i += key.length;
    }
    i = skipTrivia(src, i);
    if (src[i] !== ':') break;
    const value = parseValue(src, i + 1);
    if (!value) break;
    props.set(key, value);
    i = skipTrivia(src, value.end);
    if (src[i] === ',') i = skipTrivia(src, i + 1);
  }
  return { type: 'object', start, end: i + 1, props };
}

function parseArrayLiteral(src, start) {
  const items = [];
  let i = skipTrivia(src, start + 1);
  while (i < src.length && src[i] !== ']') {
    const value = parseValue(src, i);
    if (!value) break;
    items.push(value);
    i = skipTrivia(src, value.end);
    if (src[i] === ',') i = skipTrivia(src, i + 1);
  }
  return { type: 'array', start, end: i + 1, items };
}

function parsePrimitive(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const lit = parseStringLiteral(src, i);
      if (!lit) { i += 1; continue; }
      i = lit.end;
      continue;
    }
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    i += 1;
  }
  return { type: 'other', start, end: i };
}

export function parseValue(src, start) {
  const i = skipTrivia(src, start);
  const ch = src[i];
  if (ch === undefined) return null;
  if (ch === '"' || ch === "'") return parseStringLiteral(src, i);
  if (ch === '`') return parseStringLiteral(src, i);
  if (ch === '{') return parseObjectLiteral(src, i);
  if (ch === '[') return parseArrayLiteral(src, i);
  if (NUM.test(ch) || IDENT.test(src.slice(i, i + 1))) return parsePrimitive(src, i);
  return parsePrimitive(src, i);
}

/** Locate `var|let|const <name> = <value>` and return the parsed value node. */
export function findVarNode(src, name) {
  const re = new RegExp('(?:var|let|const)\\s+' + name.replace(/[$]/g, '\\$') + '\\s*=');
  const m = re.exec(src);
  if (!m) return null;
  return parseValue(src, m.index + m[0].length);
}

export function nodeAtPath(node, path) {
  let cur = node;
  for (const step of path) {
    if (!cur || cur === null) return null;
    if (typeof step === 'number') {
      if (cur.type !== 'array') return null;
      cur = cur.items[step];
    } else {
      if (cur.type !== 'object') return null;
      cur = cur.props.get(step);
    }
  }
  return cur || null;
}

/** Keys of an object node (empty array for anything else). */
export function nodeKeys(node) {
  if (!node || node.type !== 'object') return [];
  return Array.from(node.props.keys());
}

/**
 * Replace text run `run` inside the decoded string literal `node`.
 * @returns {{out:string,line:number,value:string}|{error:string}}
 */
export function editStringNode(src, node, run, oldText, newText) {
  if (!node || node.type !== 'string') return { error: '目标不是字符串字面量（站点结构可能已变化）' };
  const nodes = tokenize(node.value);
  const target = nodes[run];
  if (!target) return { error: '找不到第 ' + run + ' 段文字：页面与文件不同步，请刷新后重试' };
  if (target.text !== oldText) {
    return { error: '这段文字已经变了（可能刚被其它地方修改），请刷新页面后重试' };
  }
  const nextValue = node.value.slice(0, target.start) + escapeText(newText) + node.value.slice(target.end);
  const literal = src.slice(node.start, node.end);
  const quote = literal[0] === "'" ? "'" : '"';
  const out = src.slice(0, node.start) + encodeJsString(nextValue, quote) + src.slice(node.end);
  return { out, line: lineOf(src, node.start), value: nextValue };
}

export function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}
