'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_FILES = 10000;
const MAX_DEPTH = 32;

function sanitizeSegment(segment) {
  let s = segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!s || s === '.' || s === '..') return null;
  if (RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 180);
}

// Turns a sender-supplied relative name ("Foto/IMG 1.jpg") into a safe,
// traversal-free relative path using "/" separators.
function sanitizeRelPath(name) {
  const segments = String(name)
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean)
    .slice(-16);
  return segments.length ? segments.join('/') : 'file';
}

// Expands dropped files and folders into a flat list. Folder contents keep
// their path relative to the dropped folder's parent.
async function collectFiles(inputs) {
  const out = [];
  async function walk(abs, rel, depth) {
    if (out.length >= MAX_FILES) throw new Error('Troppi file (massimo 10.000)');
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      if (depth >= MAX_DEPTH) return;
      const names = (await fsp.readdir(abs)).sort((a, b) => a.localeCompare(b));
      for (const name of names) await walk(path.join(abs, name), `${rel}/${name}`, depth + 1);
    } else if (st.isFile()) {
      out.push({ abs, name: rel, size: st.size });
    }
  }
  for (const input of inputs) {
    const abs = path.resolve(input);
    await walk(abs, path.basename(abs), 0);
  }
  return out;
}

const exists = (p) => fs.existsSync(p) || fs.existsSync(`${p}.wavedrop-part`);

// Picks "name.ext", "name (1).ext", … that is neither on disk nor reserved by
// a transfer still in flight, and reserves it.
function uniquePath(target, reserved) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 0; ; n++) {
    const candidate = n ? path.join(dir, `${base} (${n})${ext}`) : target;
    if (!reserved.has(candidate) && !exists(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { sanitizeRelPath, collectFiles, uniquePath, isInside };
