// Minimal ASAR reader: no external deps. Reads the header pickle and extracts files by path.
const fs = require('fs');
const path = require('path');

const archive = process.argv[2];
const mode = process.argv[3]; // 'list' | 'read' | 'extract'
const arg = process.argv[4];
const outDir = process.argv[5];

const fd = fs.openSync(archive, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
// Electron asar header pickle layout used by current builds:
//   u32 pickleItemCount | u32 headerSize | u32 jsonLen | u32 padding | <json>
// Older builds start the JSON right after the first u32, so locate the '{' byte.
const firstU32 = sizeBuf.readUInt32LE(0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const jsonStart = headerBuf.indexOf(0x7b);
const jsonLen = firstU32 === 4 ? headerBuf.readUInt32LE(jsonStart - 4) : headerBuf.readUInt32LE(0);
const header = JSON.parse(headerBuf.toString('utf8', jsonStart, jsonStart + jsonLen));
const dataOffset = 8 + headerSize;

function walk(node, prefix, cb) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, cb);
    else cb(p, entry);
  }
}

const files = [];
walk(header, '', (p, e) => files.push([p, e]));

if (mode === 'list') {
  const re = new RegExp(arg || '.');
  for (const [p] of files) if (re.test(p)) console.log(p);
} else if (mode === 'read') {
  const hit = files.find(([p]) => p === arg);
  if (!hit) { console.error('NOT FOUND: ' + arg); process.exit(2); }
  const [, e] = hit;
  if (e.size === 0) { process.exit(0); }
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, dataOffset + Number(e.offset));
  process.stdout.write(buf);
} else if (mode === 'extract') {
  const re = new RegExp(arg);
  let n = 0;
  for (const [p, e] of files) {
    if (!re.test(p)) continue;
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(e.size);
    if (e.size > 0) fs.readSync(fd, buf, 0, e.size, dataOffset + Number(e.offset));
    fs.writeFileSync(dest, buf);
    n++;
  }
  console.error('extracted ' + n);
}
fs.closeSync(fd);
