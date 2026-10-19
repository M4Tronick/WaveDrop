'use strict';

// Small JSON-on-disk stores: identity (key pair), contacts, transfer history.

const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// The private key is wrapped with `protect` (Electron safeStorage / DPAPI in
// the app) so a copied settings folder does not leak it.
function loadIdentity(dir, { protect, unprotect } = {}) {
  const file = path.join(dir, 'identity.json');
  const saved = readJson(file, null);
  if (saved && saved.pk && saved.sk) {
    try {
      const raw = Buffer.from(saved.sk, 'base64');
      const sk = new Uint8Array(saved.protected ? unprotect(raw) : raw);
      const pk = P.unb64(saved.pk);
      if (P.sameBytes(P.publicKeyOf(sk), pk)) return { sk, pk, id: P.deviceId(pk) };
    } catch {
      // Unreadable (e.g. moved to another Windows account): start fresh below.
    }
  }
  return resetIdentity(dir, { protect });
}

function resetIdentity(dir, { protect } = {}) {
  const { sk, pk } = P.newKeyPair();
  writeJson(path.join(dir, 'identity.json'), {
    pk: P.b64(pk),
    sk: Buffer.from(protect ? protect(Buffer.from(sk)) : sk).toString('base64'),
    protected: !!protect,
    created: Date.now(),
  });
  return { sk, pk, id: P.deviceId(pk) };
}

class Contacts {
  constructor(dir, identity) {
    this.file = path.join(dir, 'contacts.json');
    this.identity = identity;
    this.map = new Map(Object.entries(readJson(this.file, {})));
    this.keys = new Map(); // id -> { presence, link } derived lazily
  }

  list() {
    return [...this.map.values()].sort((a, b) => (a.nickname || a.name).localeCompare(b.nickname || b.name));
  }

  get(id) {
    return this.map.get(id) || null;
  }

  // Called after a successful pairing; keeps user choices on re-pairing.
  upsert(info) {
    const prev = this.map.get(info.id) || {};
    const contact = {
      trusted: false,
      nickname: '',
      pairedAt: Date.now(),
      ...prev,
      ...info,
      lastSeen: Date.now(),
    };
    this.map.set(info.id, contact);
    this.keys.delete(info.id);
    this.save();
    return contact;
  }

  update(id, patch) {
    const c = this.map.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    this.save();
    return c;
  }

  remove(id) {
    this.map.delete(id);
    this.keys.delete(id);
    this.save();
  }

  touch(id, patch = {}) {
    const c = this.map.get(id);
    if (!c) return;
    Object.assign(c, patch, { lastSeen: Date.now() });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  pk(id) {
    const c = this.map.get(id);
    return c ? P.unb64(c.pk) : null;
  }

  keysFor(id) {
    if (!this.keys.has(id)) {
      const peerPk = this.pk(id);
      if (!peerPk) return null;
      const { sk, pk } = this.identity;
      this.keys.set(id, {
        presence: P.pairKey(sk, pk, peerPk, 'presence'),
        link: P.pairKey(sk, pk, peerPk, 'link'),
      });
    }
    return this.keys.get(id);
  }

  // Tags for a contacts-only announcement.
  presenceTags(nonce) {
    return this.list()
      .filter((c) => c.kind !== 'phone')
      .slice(0, 60)
      .map((c) => P.presenceTag(this.keysFor(c.id).presence, nonce));
  }

  // Which contact (if any) produced one of these tags?
  matchPresence(nonce, tags) {
    if (!Array.isArray(tags)) return null;
    const wanted = new Set(tags);
    for (const c of this.map.values()) {
      if (c.kind === 'phone') continue;
      if (wanted.has(P.presenceTag(this.keysFor(c.id).presence, nonce))) return c;
    }
    return null;
  }

  save() {
    writeJson(this.file, Object.fromEntries(this.map));
  }
}

class History {
  constructor(dir, limit = 300) {
    this.file = path.join(dir, 'history.json');
    this.limit = limit;
    this.items = readJson(this.file, []);
  }

  add(item) {
    this.items.unshift({ time: Date.now(), ...item });
    this.items.length = Math.min(this.items.length, this.limit);
    writeJson(this.file, this.items);
  }

  clear() {
    this.items = [];
    writeJson(this.file, this.items);
  }
}

module.exports = { loadIdentity, resetIdentity, Contacts, History };
