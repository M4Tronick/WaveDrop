'use strict';

// WaveDrop transfer protocol v2 (HTTP on the LAN, end-to-end encrypted).
//
//   GET  /Hello          public announcement (for Bluetooth / unicast probes)
//   GET  /Avatar         profile picture (visibility "everyone" only)
//   POST /Pair/Start     first contact: receiver shows a 6-digit code
//   POST /Pair/Finish    sender proves it typed the code (CPace, 3 attempts)
//   POST /Ask            sealed request (files, text, thumbnail) from a contact;
//                        held open until the receiver accepts or declines
//   POST /Chunk          one sealed 1 MiB chunk per request, in order
//   POST /Cancel         sender aborts
//   /m/…                 phone web app and its API (see mobile.js)
//
// Every request after pairing is bound to the pinned public keys, so only the
// two devices can read the files: the network, a router or a second WaveDrop
// on the LAN see sizes and timing only.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../shared/protocol');
const { sanitizeRelPath, collectFiles, uniquePath, isInside } = require('./files');

const ASK_TIMEOUT_MS = 90_000;
const PAIR_TTL_MS = 3 * 60_000;
const PAIR_ATTEMPTS = 3;
const MAX_PAIRINGS = 5;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_THUMBNAIL_CHARS = 400_000;
const MAX_TEXT = 100_000;
const PROGRESS_MS = 120;
const KEEP_FINISHED_MS = 60_000;

const ACTIVE = new Set(['preparing', 'pairing', 'waiting', 'sending', 'pending', 'receiving']);
const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function codeError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// What the UI calls the payload: the top-level items the user picked.
function describe(files, text) {
  if (!files.length && text) return { items: 1, label: null, isFolder: false, isText: true };
  const tops = [...new Set(files.map((f) => f.name.split('/')[0]))];
  return {
    items: tops.length,
    label: tops.length === 1 ? tops[0] : null,
    isFolder: tops.length === 1 && files.some((f) => f.name.includes('/')),
    isText: false,
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(codeError('TOO_LARGE'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  return JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
}

function reply(res, status, body = {}) {
  if (res.headersSent || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

// Small HTTP client: JSON in, JSON (or {}) out.
function call(peer, method, route, { json, body, signal, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? Buffer.from(JSON.stringify(json)) : body;
    const req = http.request(
      {
        host: peer.address,
        port: peer.port,
        method,
        path: route,
        agent,
        signal,
        timeout,
        headers: {
          'content-type': json !== undefined ? 'application/json' : 'application/octet-stream',
          'content-length': data ? data.length : 0,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let parsed = {};
          if ((res.headers['content-type'] || '').includes('json')) {
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {}
          }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(codeError('TIMEOUT')));
    req.on('error', reject);
    req.end(data);
  });
}

// ChaCha20-Poly1305 chunks: native when the crypto library has it (Node's
// OpenSSL), otherwise the pure-JS implementation (Electron's BoringSSL lacks
// it). Both produce exactly the same bytes as P.sealChunk.
const NATIVE_CHACHA = (() => {
  try {
    crypto.createCipheriv('chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 });
    return true;
  } catch {
    return false;
  }
})();

function sealChunk(key, session, file, index, last, data) {
  if (!NATIVE_CHACHA) return Buffer.from(P.sealChunk(key, session, file, index, last, data));
  const c = crypto.createCipheriv('chacha20-poly1305', key, P.chunkNonce(file, index), { authTagLength: 16 });
  c.setAAD(P.chunkAad(session, file, index, last), { plaintextLength: data.length });
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

function openChunk(key, session, file, index, last, data) {
  if (data.length < P.TAG_SIZE) throw codeError('AUTH');
  if (!NATIVE_CHACHA) return Buffer.from(P.openChunk(key, session, file, index, last, data));
  const body = data.subarray(0, data.length - P.TAG_SIZE);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, P.chunkNonce(file, index), { authTagLength: 16 });
  d.setAAD(P.chunkAad(session, file, index, last), { plaintextLength: body.length });
  d.setAuthTag(data.subarray(data.length - P.TAG_SIZE));
  return Buffer.concat([d.update(body), d.final()]);
}

class TransferService extends EventEmitter {
  /**
   * @param {object} o
   * @param {{sk: Uint8Array, pk: Uint8Array, id: string}} o.identity
   * @param {import('./store').Contacts} o.contacts
   * @param {() => {name: string, platform: string, color: number}} o.profile
   * @param {() => 'everyone'|'contacts'|'off'} o.visibility
   * @param {() => object|null} o.hello            public announcement for GET /Hello
   * @param {() => string|null} o.avatarFile       path of our avatar JPEG
   * @param {(file: string) => Promise<string|null>} o.thumbnail
   * @param {(contact: object) => boolean} o.autoAccept
   * @param {(entry: object) => string} o.defaultSaveDir
   * @param {(record: object) => void} [o.onFinished]
   */
  constructor(o) {
    super();
    this.identity = o.identity;
    this.contacts = o.contacts;
    this.profile = o.profile;
    this.visibility = o.visibility;
    this.hello = o.hello;
    this.avatarFile = o.avatarFile;
    this.thumbnail = o.thumbnail;
    this.autoAccept = o.autoAccept;
    this.defaultSaveDir = o.defaultSaveDir;
    this.onFinished = o.onFinished || (() => {});
    this.mobile = null; // set by MobileHub
    this.airdrop = null; // AirDropBridge, set by main on Linux (see airdrop.js)
    this.incoming = new Map();
    this.outgoing = new Map();
    this.pairings = new Map();
    this.reserved = new Set();
    this.port = 0;
  }

  // Prefers a fixed port so phones can bookmark the web app; falls back to any.
  async start(preferredPort = 0) {
    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((err) => {
        if (!res.headersSent) reply(res, err.code === 'TOO_LARGE' ? 413 : 500, { error: err.message });
        else res.destroy();
      });
    });
    this.server.requestTimeout = 0; // /Ask waits for a human; /m/events is long-lived
    this.server.headersTimeout = 30_000;
    const listen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        this.server.once('error', onError);
        this.server.listen(port, '0.0.0.0', () => {
          this.server.off('error', onError);
          resolve(this.server.address().port);
        });
      });
    try {
      this.port = await listen(preferredPort);
    } catch (err) {
      if (!preferredPort || err.code !== 'EADDRINUSE') throw err;
      this.port = await listen(0);
    }
    return this.port;
  }

  stop() {
    for (const t of this.outgoing.values()) if (ACTIVE.has(t.status)) this.cancelOutgoing(t.id);
    for (const e of this.incoming.values()) if (ACTIVE.has(e.status)) this.cancelIncoming(e.id);
    this.mobile?.stop();
    this.server?.close();
    agent.destroy();
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://wavedrop');
    if (url.pathname === '/m' || url.pathname.startsWith('/m/')) {
      return this.mobile ? this.mobile.handle(req, res, url) : reply(res, 404);
    }
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /Hello': {
        const hello = this.hello();
        return hello ? reply(res, 200, { app: 'wavedrop', v: P.VERSION, ...hello }) : reply(res, 404);
      }
      case 'GET /Avatar':
        return this._avatar(res);
      case 'POST /Pair/Start':
        return this._pairStart(req, res);
      case 'POST /Pair/Finish':
        return this._pairFinish(req, res);
      case 'POST /Ask':
        return this._ask(req, res);
      case 'POST /Chunk':
        return this._chunk(req, res, url.searchParams);
      case 'POST /Cancel':
        return this._remoteCancel(res, url.searchParams);
      default:
        return reply(res, 404);
    }
  }

  _avatar(res) {
    const file = this.avatarFile();
    if (!file || this.visibility() !== 'everyone' || !fs.existsSync(file)) return reply(res, 404);
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length, 'cache-control': 'max-age=3600' });
    res.end(data);
  }

  // ───────────── pairing: receiver side ─────────────

  async _pairStart(req, res) {
    const body = await readJson(req);
    if (this.visibility() !== 'everyone') return reply(res, 403, { reason: 'off' });
    let pkA;
    try {
      pkA = P.unb64(body.pk);
    } catch {
      return reply(res, 400);
    }
    if (pkA.length !== 32 || P.deviceId(pkA) !== body.id) return reply(res, 400);
    for (const p of this.pairings.values()) if (p.peer.id === body.id && p.status === 'waiting') this._endPairing(p, 'replaced');
    if ([...this.pairings.values()].filter((p) => p.status === 'waiting').length >= MAX_PAIRINGS) return reply(res, 429);

    const sid = P.randomBytes(16);
    const code = P.randomCode();
    const { y, Y } = P.cpaceStart(code, sid, pkA, this.identity.pk);
    const pairing = {
      id: P.b64(sid),
      sid,
      code,
      y,
      Y,
      pkA,
      peer: { id: body.id, name: clean(body.name, 40) || 'Sconosciuto', platform: clean(body.platform, 16) },
      attempts: PAIR_ATTEMPTS,
      status: 'waiting',
    };
    pairing.timer = setTimeout(() => this._endPairing(pairing, 'expired'), PAIR_TTL_MS);
    this.pairings.set(pairing.id, pairing);
    this.emit('pairing', pairing);
    const me = this.profile();
    reply(res, 200, {
      sid: pairing.id,
      Y: P.b64(Y),
      pk: P.b64(this.identity.pk),
      name: me.name,
      platform: me.platform,
      color: me.color,
    });
  }

  async _pairFinish(req, res) {
    const body = await readJson(req);
    const p = this.pairings.get(body.sid);
    if (!p || p.status !== 'waiting') return reply(res, 410, { reason: p ? p.status : 'unknown' });
    let keys = null;
    let theirMac = null;
    try {
      const YA = P.unb64(body.Y);
      keys = P.cpaceKeys(p.y, YA, p.sid, YA, p.Y, p.pkA, this.identity.pk);
      theirMac = P.unb64(body.mac);
    } catch {}
    if (!keys || !P.sameBytes(keys.macA, theirMac)) {
      p.attempts--;
      if (p.attempts <= 0) this._endPairing(p, 'failed');
      else this.emit('pairing', p);
      return reply(res, 403, { reason: 'bad-code', left: Math.max(0, p.attempts) });
    }
    this.contacts.upsert({ id: p.peer.id, pk: P.b64(p.pkA), name: p.peer.name, platform: p.peer.platform, kind: 'pc' });
    this._endPairing(p, 'done');
    reply(res, 200, { mac: P.b64(keys.macB) });
  }

  _endPairing(p, status) {
    if (p.status !== 'waiting') return;
    clearTimeout(p.timer);
    p.status = status;
    p.y = null;
    this.emit('pairing', p);
    setTimeout(() => this.pairings.delete(p.id), 30_000).unref();
  }

  cancelPairing(id) {
    const p = this.pairings.get(id);
    if (p) this._endPairing(p, 'cancelled');
  }

  viewPairing(p) {
    return {
      id: p.id,
      status: p.status,
      code: p.status === 'waiting' ? p.code : null,
      peer: p.peer,
      attempts: p.attempts,
    };
  }

  // ───────────── pairing: sender side ─────────────

  async _pair(peer, t) {
    const me = this.profile();
    const start = await call(peer, 'POST', '/Pair/Start', {
      json: { id: this.identity.id, pk: P.b64(this.identity.pk), name: me.name, platform: me.platform },
      signal: t.abort.signal,
      timeout: 15_000,
    });
    if (start.status === 403) throw codeError('OFF');
    if (start.status !== 200) throw codeError('PAIR_FAILED');
    const pkB = P.unb64(start.body.pk);
    // The device that answered must be the one we picked.
    if (P.deviceId(pkB) !== peer.id) throw codeError('PAIR_MISMATCH');
    const sid = P.unb64(start.body.sid);
    const YB = P.unb64(start.body.Y);

    t.status = 'pairing';
    t.pairError = null;
    this._out(t, true);
    for (;;) {
      const code = await new Promise((resolve, reject) => {
        t.codeWaiter = { resolve, reject };
      });
      const a = P.cpaceStart(code, sid, this.identity.pk, pkB);
      const keys = P.cpaceKeys(a.y, YB, sid, a.Y, YB, this.identity.pk, pkB);
      const fin = await call(peer, 'POST', '/Pair/Finish', {
        json: { sid: start.body.sid, Y: P.b64(a.Y), mac: P.b64(keys.macA) },
        signal: t.abort.signal,
        timeout: 15_000,
      });
      if (fin.status === 200) {
        let ok = false;
        try {
          ok = P.sameBytes(P.unb64(fin.body.mac), keys.macB);
        } catch {}
        if (!ok) throw codeError('PAIR_FAILED');
        this.contacts.upsert({
          id: peer.id,
          pk: P.b64(pkB),
          name: clean(start.body.name, 40) || peer.name,
          platform: clean(start.body.platform, 16) || peer.platform,
          color: Number.isInteger(start.body.color) ? start.body.color : 0,
          kind: 'pc',
        });
        t.pairError = null;
        this.emit('contacts');
        return;
      }
      if (fin.status === 403 && fin.body.left > 0) {
        t.pairError = { left: fin.body.left };
        this._out(t, true);
        continue;
      }
      throw codeError(fin.status === 403 ? 'PAIR_BAD_CODE' : 'PAIR_FAILED');
    }
  }

  submitCode(transferId, code) {
    const t = this.outgoing.get(transferId);
    if (!t || !t.codeWaiter || !/^\d{6}$/.test(String(code))) return false;
    t.codeWaiter.resolve(String(code));
    t.codeWaiter = null;
    return true;
  }

  // ───────────── receiving ─────────────

  async _ask(req, res) {
    const body = await readJson(req);
    const contact = typeof body.id === 'string' ? this.contacts.get(body.id) : null;
    if (!contact) return reply(res, 401, { reason: 'unpaired' });
    if (this.visibility() === 'off') return reply(res, 403, { accepted: false, reason: 'off' });

    const peerPk = P.unb64(contact.pk);
    let opened;
    try {
      opened = P.askOpen({ sk: this.identity.sk, pk: this.identity.pk, peerPk, msg: body });
    } catch {
      return reply(res, 401, { reason: 'auth' }); // not really that contact
    }
    const r = opened.request || {};
    const files = Array.isArray(r.files) ? r.files : [];
    const text = typeof r.text === 'string' && r.text.trim() ? r.text.slice(0, MAX_TEXT) : null;
    if ((!files.length && !text) || files.length > 10000) return reply(res, 400, { error: 'bad request' });
    const list = files.map((f) => ({ name: sanitizeRelPath(f && f.name), size: Number(f && f.size), next: 0, done: false }));
    if (list.some((f) => !Number.isSafeInteger(f.size) || f.size < 0)) return reply(res, 400, { error: 'bad size' });

    this.contacts.touch(contact.id, {
      name: clean(r.name, 40) || contact.name,
      platform: clean(r.platform, 16) || contact.platform,
      color: Number.isInteger(r.color) ? r.color : contact.color,
    });

    const entry = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      contact: {
        id: contact.id,
        name: contact.nickname || clean(r.name, 40) || contact.name,
        platform: clean(r.platform, 16) || contact.platform,
        kind: contact.kind,
        trusted: !!contact.trusted,
        color: Number.isInteger(r.color) ? r.color : contact.color || 0,
        avatarUrl: contact.avatarData || null,
      },
      files: list,
      text,
      totalSize: list.reduce((n, f) => n + f.size, 0),
      received: 0,
      thumbnail:
        typeof r.thumbnail === 'string' &&
        /^data:image\/(png|jpeg);base64,/.test(r.thumbnail) &&
        r.thumbnail.length < MAX_THUMBNAIL_CHARS
          ? r.thumbnail
          : null,
      status: 'pending',
      paths: [],
      topDirs: new Map(),
      k1: opened.k1,
      eA: opened.eA,
      peerPk,
      lastEmit: 0,
      auto: false,
    };
    this.incoming.set(entry.id, entry);

    let decision;
    if (this.autoAccept(contact)) {
      entry.auto = true;
      decision = { accept: true, saveDir: this.defaultSaveDir(entry) };
      this.emit('incoming:new', entry);
    } else {
      decision = await new Promise((resolve) => {
        entry.decide = resolve;
        entry.timer = setTimeout(() => resolve({ accept: false, reason: 'timeout' }), ASK_TIMEOUT_MS);
        res.on('close', () => {
          if (!res.writableFinished) resolve({ accept: false, reason: 'aborted' });
        });
        this.emit('incoming:new', entry);
      });
      clearTimeout(entry.timer);
      entry.decide = null;
    }

    if (decision.accept && !res.destroyed) {
      entry.saveDir = decision.saveDir;
      const { key, msg } = P.answerSeal({
        k1: entry.k1,
        eA: entry.eA,
        peerPk,
        answer: { accepted: true, session: entry.id, token: entry.token },
      });
      entry.key = Buffer.from(key);
      entry.status = list.length ? 'receiving' : 'done';
      reply(res, 200, msg);
      if (list.length) this._touchIdle(entry);
    } else {
      entry.status = decision.reason === 'aborted' ? 'cancelled' : 'declined';
      entry.reason = decision.reason || 'declined';
      reply(res, 403, { accepted: false, reason: entry.reason });
    }
    this._finishIfOver(entry);
    this.emit('incoming:update', entry);
  }

  async _destination(entry, relName) {
    const saveDir = entry.saveDir;
    const parts = relName.split('/');
    let target;
    if (parts.length > 1) {
      // Each received folder gets its own unique top-level name, so a second
      // "Foto" folder becomes "Foto (1)" instead of merging into the first.
      let top = entry.topDirs.get(parts[0]);
      if (!top) {
        top = uniquePath(path.join(saveDir, parts[0]), this.reserved);
        entry.topDirs.set(parts[0], top);
      }
      target = path.join(top, ...parts.slice(1));
    } else {
      target = path.join(saveDir, parts[0]);
    }
    const dest = uniquePath(target, this.reserved);
    if (!isInside(dest, saveDir)) throw new Error('invalid path');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    return dest;
  }

  async _chunk(req, res, q) {
    const entry = this.incoming.get(q.get('s'));
    if (!entry) return reply(res, 401);
    if (entry.status !== 'receiving' || !entry.key) {
      req.resume();
      return reply(res, 410, { reason: entry.status });
    }
    const f = Number(q.get('f'));
    const c = Number(q.get('c'));
    const last = q.get('last') === '1';
    const file = entry.files[f];
    if (!file || file.done || file.busy || c !== file.next) {
      req.resume();
      return reply(res, 409, { reason: 'order' });
    }
    const total = P.chunkCount(file.size);
    if (last !== (c === total - 1)) {
      req.resume();
      return reply(res, 400, { reason: 'framing' });
    }
    const expected = last ? file.size - c * P.CHUNK_SIZE : P.CHUNK_SIZE;

    file.busy = true;
    try {
      const sealed = await readBody(req, P.CHUNK_SIZE + P.TAG_SIZE);
      let plain;
      try {
        plain = openChunk(entry.key, entry.id, f, c, last, sealed);
      } catch {
        plain = null;
      }
      if (!plain || plain.length !== expected) {
        await this._failIncoming(entry, 'Dati non autentici: trasferimento interrotto');
        return reply(res, 400, { reason: 'auth' });
      }
      if (entry.status !== 'receiving') return reply(res, 410, { reason: entry.status });
      if (c === 0) {
        file.dest = await this._destination(entry, file.name);
        file.part = `${file.dest}.wavedrop-part`;
        file.fh = await fsp.open(file.part, 'w');
      }
      await file.fh.write(plain);
      file.next++;
      entry.received += plain.length;
      this._touchIdle(entry);
      if (last) {
        await file.fh.close();
        file.fh = null;
        await fsp.rename(file.part, file.dest);
        this.reserved.delete(file.dest);
        file.done = true;
        entry.paths.push(file.dest);
      }
    } finally {
      file.busy = false;
    }

    reply(res, 200, { ok: true });
    if (entry.files.every((x) => x.done)) {
      entry.status = 'done';
      this._finishIfOver(entry);
      this.emit('incoming:update', entry);
    } else {
      this._progress(entry);
    }
  }

  _remoteCancel(res, q) {
    const entry = this.incoming.get(q.get('s'));
    if (!entry || q.get('t') !== entry.token) return reply(res, 401);
    this._abortIncoming(entry, 'cancelled');
    reply(res, 200, { ok: true });
  }

  _touchIdle(entry) {
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this._failIncoming(entry, 'Connessione interrotta'), IDLE_TIMEOUT_MS);
    entry.idle.unref?.();
  }

  async _discardPartials(entry) {
    for (const file of entry.files) {
      if (file.done || !file.part) continue;
      try {
        await file.fh?.close();
      } catch {}
      file.fh = null;
      await fsp.rm(file.part, { force: true }).catch(() => {});
      this.reserved.delete(file.dest);
    }
  }

  async _failIncoming(entry, message) {
    if (!ACTIVE.has(entry.status)) return;
    entry.status = 'failed';
    entry.error = message;
    this._finishIfOver(entry);
    this.emit('incoming:update', entry);
  }

  _abortIncoming(entry, status) {
    if (!ACTIVE.has(entry.status)) return;
    if (entry.decide) return entry.decide({ accept: false, reason: status === 'cancelled' ? 'aborted' : 'declined' });
    entry.status = status;
    this._finishIfOver(entry);
    this.emit('incoming:update', entry);
  }

  respond(id, accept, saveDir) {
    this.incoming.get(id)?.decide?.({ accept: !!accept, saveDir, reason: accept ? null : 'declined' });
  }

  cancelIncoming(id) {
    const entry = this.incoming.get(id);
    if (entry) this._abortIncoming(entry, 'cancelled-local');
  }

  isReceivedPath(p) {
    const resolved = path.resolve(p);
    for (const e of this.incoming.values()) {
      if (e.paths.includes(resolved) || [...e.topDirs.values()].includes(resolved)) return true;
    }
    return false;
  }

  _progress(entry) {
    const now = Date.now();
    if (now - entry.lastEmit < PROGRESS_MS) return;
    entry.lastEmit = now;
    this.emit('incoming:update', entry);
  }

  _finishIfOver(entry) {
    if (ACTIVE.has(entry.status) || entry.endedAt) return;
    entry.endedAt = Date.now();
    clearTimeout(entry.idle);
    entry.key = null;
    if (entry.status !== 'done') this._discardPartials(entry);
    for (const top of entry.topDirs.values()) this.reserved.delete(top);
    this.onFinished({
      direction: 'in',
      peer: entry.contact.name,
      platform: entry.contact.platform,
      summary: describe(entry.files, entry.text),
      size: entry.totalSize,
      status: entry.status,
      text: entry.text ? entry.text.slice(0, 500) : null,
      reveal: this.viewIncoming(entry).reveal,
    });
    setTimeout(() => this.incoming.delete(entry.id), KEEP_FINISHED_MS).unref();
  }

  viewIncoming(e) {
    return {
      id: e.id,
      status: e.status,
      sender: e.contact,
      ...describe(e.files, e.text),
      text: e.text,
      totalSize: e.totalSize,
      received: e.received,
      progress: e.totalSize ? e.received / e.totalSize : e.status === 'done' ? 1 : 0,
      thumbnail: e.thumbnail,
      paths: e.paths,
      reveal: e.topDirs.values().next().value || e.paths[0] || null,
      auto: e.auto,
      error: e.error || null,
    };
  }

  // ───────────── sending ─────────────

  activeFor(peerId) {
    for (const t of this.outgoing.values()) if (t.peerId === peerId && ACTIVE.has(t.status)) return t;
    return null;
  }

  async send(peer, { paths = [], text = null, pairOnly = false } = {}) {
    if (this.activeFor(peer.id)) return null;
    const t = {
      id: crypto.randomUUID(),
      peerId: peer.id,
      peerName: peer.name,
      peer: { address: peer.address, port: peer.port },
      transport: peer.transport || 'lan',
      status: 'preparing',
      sent: 0,
      total: 0,
      summary: pairOnly ? { items: 0, label: null, isFolder: false, isText: false, pairOnly: true } : describe([], text),
      abort: new AbortController(),
      startedAt: Date.now(),
      lastEmit: 0,
    };
    this.outgoing.set(t.id, t);
    this._out(t, true);

    try {
      if (pairOnly) {
        if (t.transport === 'mobile') throw codeError('PHONE_QR', 'I telefoni si collegano con il codice QR');
        if (t.transport === 'airdrop') throw codeError('AIRDROP_PAIR', 'I dispositivi Apple non si abbinano');
        await this._pair(peer, t);
        t.status = 'done';
        return t.id;
      }
      const files = paths.length ? await collectFiles(paths) : [];
      if (!files.length && !text) throw new Error('Nessun file da inviare');
      t.total = files.reduce((n, f) => n + f.size, 0);
      t.summary = describe(files, text);
      const thumbnail = files.length ? await this.thumbnail(files[0].abs).catch(() => null) : null;
      if (t.abort.signal.aborted) throw codeError('ABORTED');

      if (t.transport === 'mobile') {
        await this.mobile.sendToPhone(t, peer, files, text, thumbnail);
      } else if (t.transport === 'airdrop') {
        await this._sendAirDrop(peer, t, files, text);
      } else {
        if (!this.contacts.get(peer.id)) await this._pair(peer, t);
        await this._askAndUpload(peer, t, files, text, thumbnail);
      }
    } catch (err) {
      if (t.abort.signal.aborted) t.status = 'cancelled';
      else if (err.code === 'REMOTE_CANCELLED') {
        t.status = 'cancelled';
        t.reason = 'remote';
      } else if (err.code === 'OFF') {
        t.status = 'declined';
        t.reason = 'off';
      } else {
        t.status = 'failed';
        t.reason = err.code || err.message;
        this._notifyCancel(t);
      }
    } finally {
      t.codeWaiter = null;
      t.endedAt = Date.now();
      if (t.status === 'done') t.sent = t.total;
      this._out(t, true);
      this.onFinished({
        direction: 'out',
        peer: t.peerName,
        summary: t.summary,
        size: t.total,
        status: t.status,
        reason: t.reason || null,
        text: text ? text.slice(0, 500) : null,
        ...(t.transport === 'airdrop' ? { via: 'airdrop' } : {}),
      });
      setTimeout(() => this.outgoing.delete(t.id), KEEP_FINISHED_MS).unref();
    }
    return t.id;
  }

  async _askAndUpload(peer, t, files, text, thumbnail, retried = false) {
    t.status = 'waiting';
    this._out(t, true);
    const contact = this.contacts.get(peer.id);
    const me = this.profile();
    const { e, k1, msg } = P.askSeal({
      sk: this.identity.sk,
      pk: this.identity.pk,
      peerPk: P.unb64(contact.pk),
      request: {
        name: me.name,
        platform: me.platform,
        color: me.color,
        files: files.map(({ name, size }) => ({ name, size })),
        text,
        thumbnail,
      },
    });
    const res = await call(peer, 'POST', '/Ask', { json: { id: this.identity.id, ...msg }, signal: t.abort.signal });

    if (res.status === 401 && res.body.reason === 'unpaired' && !retried) {
      // They no longer know us (reset or removed us): pair again, once.
      this.contacts.remove(peer.id);
      this.emit('contacts');
      await this._pair(peer, t);
      return this._askAndUpload(peer, t, files, text, thumbnail, true);
    }
    if (res.status === 401) throw codeError('AUTH');
    if (res.status !== 200) {
      t.status = 'declined';
      t.reason = res.body.reason || 'declined';
      return;
    }

    let opened;
    try {
      opened = P.answerOpen({ k1, sk: this.identity.sk, e, msg: res.body });
    } catch {
      throw codeError('AUTH'); // answer not from the paired device
    }
    if (!opened.answer.accepted) {
      t.status = 'declined';
      t.reason = 'declined';
      return;
    }
    t.session = { session: opened.answer.session, token: opened.answer.token };
    if (!files.length) {
      t.status = 'done';
      return;
    }

    t.status = 'sending';
    this._out(t, true);
    const key = Buffer.from(opened.key);
    for (let f = 0; f < files.length; f++) await this._sendFile(peer, t, key, f, files[f]);
    t.status = 'done';
  }

  // To an Apple device through the AirDrop bridge: no pairing (AirDrop has
  // its own prompt on the device) and no byte counts, only whole files.
  async _sendAirDrop(peer, t, files, text) {
    if (!this.airdrop) throw codeError('AIRDROP_OFF');
    t.status = 'waiting';
    this._out(t, true);
    const sizes = new Map(files.map((f) => [path.basename(f.name), f.size]));
    const r = await this.airdrop.send(peer, {
      files,
      text,
      signal: t.abort.signal,
      onEvent: (ev) => {
        if (ev.type === 'accepted' && t.status !== 'sending') {
          t.status = 'sending';
          this._out(t, true);
        } else if (ev.type === 'sent' && ev.name) {
          t.sent = Math.min(t.total, t.sent + (sizes.get(ev.name) || 0));
          this._out(t, true);
        }
      },
    });
    if (r.status === 'done') t.status = 'done';
    else if (r.status === 'declined') {
      t.status = 'declined';
      t.reason = 'declined';
    } else if (r.status === 'cancelled') throw codeError(t.abort.signal.aborted ? 'ABORTED' : 'REMOTE_CANCELLED');
    else throw codeError(r.reason || 'AIRDROP_FAILED');
  }

  async _sendFile(peer, t, key, f, file) {
    const fh = await fsp.open(file.abs, 'r');
    try {
      const count = P.chunkCount(file.size);
      const buf = Buffer.allocUnsafe(P.CHUNK_SIZE);
      for (let c = 0; c < count; c++) {
        const last = c === count - 1;
        const len = last ? file.size - c * P.CHUNK_SIZE : P.CHUNK_SIZE;
        const { bytesRead } = await fh.read(buf, 0, len, c * P.CHUNK_SIZE);
        if (bytesRead !== len) throw codeError('CHANGED', 'File modificato durante l\'invio');
        const sealed = sealChunk(key, t.session.session, f, c, last, buf.subarray(0, len));
        const route = `/Chunk?s=${encodeURIComponent(t.session.session)}&f=${f}&c=${c}&last=${last ? 1 : 0}`;
        const r = await call(peer, 'POST', route, { body: sealed, signal: t.abort.signal });
        if (r.status === 410) throw codeError('REMOTE_CANCELLED');
        if (r.status !== 200) throw codeError(`HTTP_${r.status}`);
        t.sent += len;
        this._out(t);
      }
    } finally {
      await fh.close();
    }
  }

  cancelOutgoing(id) {
    const t = this.outgoing.get(id);
    if (!t || !ACTIVE.has(t.status)) return;
    t.abort.abort();
    t.codeWaiter?.reject(codeError('ABORTED'));
    if (t.transport === 'mobile') this.mobile?.cancel(t);
    else this._notifyCancel(t);
  }

  _notifyCancel(t) {
    if (!t.session || t.transport === 'mobile') return;
    const { session, token } = t.session;
    call(t.peer, 'POST', `/Cancel?s=${encodeURIComponent(session)}&t=${encodeURIComponent(token)}`, { timeout: 5000 }).catch(() => {});
  }

  _out(t, force = false) {
    const now = Date.now();
    if (!force && now - t.lastEmit < PROGRESS_MS) return;
    t.lastEmit = now;
    this.emit('outgoing:update', t);
  }

  viewOutgoing(t) {
    return {
      id: t.id,
      peerId: t.peerId,
      peerName: t.peerName,
      status: t.status,
      reason: t.reason || null,
      pairError: t.pairError || null,
      ...t.summary,
      progress: t.total ? t.sent / t.total : t.status === 'done' ? 1 : 0,
      endedAt: t.endedAt || null,
    };
  }

  listOutgoing() {
    return [...this.outgoing.values()].map((t) => this.viewOutgoing(t));
  }
}

module.exports = { TransferService, ACTIVE, describe, call, reply, readJson, readBody, sealChunk, openChunk, codeError };
