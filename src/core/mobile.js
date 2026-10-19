'use strict';

// Phones (iPhone / Android) talk to WaveDrop through a web app served by this
// PC, so nothing needs installing: the phone scans a QR code, opens the page,
// and from then on is a paired, end-to-end encrypted contact.
//
//   GET  /m/…           the web app (static files)
//   POST /m/pair        QR pairing: the QR carries a one-time secret that both
//                       sides use to authenticate each other's public key
//   GET  /m/events      Server-Sent Events: presence + offers for the phone
//   POST /m/answer      phone accepts/declines an offer (sealed answer)
//   GET  /m/chunk       phone pulls sealed chunks of an accepted offer
//   POST /m/cancel      phone aborts a download
//   POST /m/home        phone stores its sealed identity (Home Screen box)
//   POST /m/home/get    a Home Screen app fetches that box back by id
// Phone → PC transfers use the regular /Ask + /Chunk endpoints.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../shared/protocol');
const { reply, readJson, sealChunk, codeError } = require('./transfer');

const QR_TTL_MS = 5 * 60_000;
const OFFER_TTL_MS = 2 * 60_000;
const EVENTS_SKEW_MS = 5 * 60_000;
const HOME_BOX_MAX = 8 * 1024; // base64 characters

const STATIC = {
  '/m/': ['index.html', 'text/html; charset=utf-8'],
  '/m/app.js': ['app.bundle.js', 'text/javascript; charset=utf-8'],
  '/m/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/m/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const b64url = (bytes) => P.b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The LAN address a phone should use: skip virtual adapters, prefer home ranges.
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth|Tailscale|ZeroTier/i.test(name)) continue;
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) candidates.push(a.address);
    }
  }
  const score = (ip) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] || '127.0.0.1';
}

class MobileHub extends EventEmitter {
  constructor({ service, identity, contacts, profile, webDir, iconFile }) {
    super();
    this.service = service;
    this.identity = identity;
    this.contacts = contacts;
    this.profile = profile;
    this.webDir = webDir;
    this.iconFile = iconFile;
    this.sessions = new Map(); // phone id -> { res, heartbeat }
    this.offers = new Map(); // offer id -> offer
    this.qr = null;
    service.mobile = this;
  }

  // ───────────── pairing link / QR ─────────────

  newPairingLink() {
    const secret = P.randomBytes(16);
    this.qr = { secret, expires: Date.now() + QR_TTL_MS };
    // The QR also carries our public key: the phone reads it from the screen, so
    // it is authentic without trusting the network.
    const url = `http://${lanAddress()}:${this.service.port}/m/#k=${b64url(secret)}&p=${b64url(this.identity.pk)}`;
    return { url, expires: this.qr.expires };
  }

  // ───────────── presence ─────────────

  list() {
    return [...this.sessions.keys()]
      .map((id) => this.contacts.get(id))
      .filter(Boolean)
      .map((c) => ({
        id: c.id,
        pk: c.pk,
        name: c.nickname || c.name,
        platform: c.platform,
        kind: 'phone',
        transport: 'mobile',
        color: c.color || 0,
        avatar: '',
      }));
  }

  isOnline(id) {
    return this.sessions.has(id);
  }

  _push(phoneId, event, data) {
    const s = this.sessions.get(phoneId);
    if (!s) return false;
    s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  stop() {
    for (const s of this.sessions.values()) {
      clearInterval(s.heartbeat);
      s.res.end();
    }
    this.sessions.clear();
  }

  // ───────────── HTTP ─────────────

  async handle(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /m') {
      res.writeHead(301, { location: '/m/' }); // relative asset URLs need the slash
      return res.end();
    }
    if (req.method === 'GET' && STATIC[url.pathname]) return this._static(res, ...STATIC[url.pathname]);
    switch (route) {
      case 'GET /m/icon.png':
        return this._file(res, this.iconFile, 'image/png');
      case 'POST /m/pair':
        return this._pair(req, res);
      case 'GET /m/events':
        return this._eventStream(req, res, url.searchParams);
      case 'POST /m/answer':
        return this._answer(req, res);
      case 'GET /m/chunk':
        return this._chunk(res, url.searchParams);
      case 'POST /m/cancel':
        return this._cancel(req, res);
      case 'POST /m/home':
        return this._homePut(req, res);
      case 'POST /m/home/get':
        return this._homeGet(req, res);
      default:
        return reply(res, 404);
    }
  }

  _static(res, file, type) {
    return this._file(res, path.join(this.webDir, file), type);
  }

  _file(res, file, type) {
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return reply(res, 404);
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-cache',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  }

  async _pair(req, res) {
    const body = await readJson(req);
    const qr = this.qr;
    if (!qr || Date.now() > qr.expires) return reply(res, 410, { reason: 'expired' });
    let pkP;
    let proof;
    try {
      pkP = P.unb64(body.pk);
      proof = P.unb64(body.proof);
    } catch {
      return reply(res, 400);
    }
    if (pkP.length !== 32) return reply(res, 400);
    const expected = P.unb64(P.qrProof(qr.secret, 'wd-mobile-pair', pkP, this.identity.pk));
    if (!P.sameBytes(expected, proof)) return reply(res, 403, { reason: 'bad-proof' });
    this.qr = null; // single use

    const id = P.deviceId(pkP);
    const prev = this.contacts.get(id);
    const contact = this.contacts.upsert({
      id,
      pk: P.b64(pkP),
      name: String(body.name || 'Telefono').trim().slice(0, 40) || 'Telefono',
      platform: ['ios', 'android'].includes(body.platform) ? body.platform : 'phone',
      kind: 'phone',
      trusted: prev ? prev.trusted : true, // you just scanned your own screen
    });
    this.emit('paired', contact);
    const me = this.profile();
    reply(res, 200, {
      id: this.identity.id,
      pk: P.b64(this.identity.pk),
      name: me.name,
      platform: me.platform,
      proof: P.qrProof(qr.secret, 'wd-mobile-ok', this.identity.pk, pkP),
    });
  }

  _eventStream(req, res, q) {
    const id = q.get('id');
    const contact = id ? this.contacts.get(id) : null;
    const t = Number(q.get('t'));
    if (!contact || contact.kind !== 'phone' || !Number.isFinite(t) || Math.abs(Date.now() - t) > EVENTS_SKEW_MS) {
      return reply(res, 401);
    }
    let sig;
    try {
      sig = P.unb64(q.get('sig') || '');
    } catch {
      return reply(res, 401);
    }
    const expected = P.mac(this.contacts.keysFor(id).link, P.lv('wd-events', String(t)));
    if (!P.sameBytes(expected, sig)) return reply(res, 401);

    const old = this.sessions.get(id);
    if (old) {
      clearInterval(old.heartbeat);
      old.res.end();
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const session = { res, heartbeat: setInterval(() => res.write(': ping\n\n'), 15_000) };
    this.sessions.set(id, session);
    this.contacts.touch(id);
    const me = this.profile();
    this._push(id, 'hello', { name: me.name, platform: me.platform, trusted: !!contact.trusted });
    // Offers made while the phone was asleep (iOS suspends background pages).
    for (const offer of this.offers.values()) {
      if (offer.phoneId === id && offer.status === 'waiting') this._push(id, 'offer', offer.event);
    }
    this.emit('change');

    req.on('close', () => {
      clearInterval(session.heartbeat);
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        this.emit('change');
      }
    });
  }

  // ───────────── Home Screen box ─────────────

  // The phone (signed with its link key) leaves its identity here, sealed
  // under a key we never see. One box per phone; a newer one replaces it.
  async _homePut(req, res) {
    const body = await readJson(req);
    const contact = typeof body.id === 'string' ? this.contacts.get(body.id) : null;
    const t = Number(body.t);
    if (!contact || contact.kind !== 'phone' || !Number.isFinite(t) || Math.abs(Date.now() - t) > EVENTS_SKEW_MS) {
      return reply(res, 401);
    }
    const box = String(body.box || '');
    const blob = String(body.blob || '');
    if (!/^[0-9a-f]{32}$/.test(box) || !blob || blob.length > HOME_BOX_MAX) return reply(res, 400);
    let sig;
    try {
      sig = P.unb64(String(body.sig || ''));
    } catch {
      return reply(res, 401);
    }
    const expected = P.mac(this.contacts.keysFor(contact.id).link, P.lv('wd-home', String(t), box, blob));
    if (!P.sameBytes(expected, sig)) return reply(res, 401);
    this.contacts.update(contact.id, { home: { box, blob } });
    reply(res, 200);
  }

  // Anyone holding the box id (derived from the key in the saved address)
  // gets the sealed box; without the key it is useless.
  async _homeGet(req, res) {
    const body = await readJson(req);
    const box = String(body.box || '');
    if (!/^[0-9a-f]{32}$/.test(box)) return reply(res, 400);
    const contact = this.contacts.list().find((c) => c.kind === 'phone' && c.home && c.home.box === box);
    if (!contact) return reply(res, 404);
    reply(res, 200, { blob: contact.home.blob });
  }

  // ───────────── PC → phone ─────────────

  async sendToPhone(t, peer, files, text, thumbnail) {
    const contact = this.contacts.get(peer.id);
    if (!contact) throw codeError('UNPAIRED');
    if (!this.sessions.has(peer.id)) throw codeError('PHONE_OFFLINE');
    const me = this.profile();
    const { e, k1, msg } = P.askSeal({
      sk: this.identity.sk,
      pk: this.identity.pk,
      peerPk: P.unb64(contact.pk),
      request: {
        name: me.name,
        platform: me.platform,
        files: files.map(({ name, size }) => ({ name, size })),
        text,
        thumbnail,
      },
    });
    const offer = {
      id: crypto.randomUUID(),
      phoneId: peer.id,
      t,
      files: files.map((f) => ({ ...f, next: 0 })),
      k1,
      e,
      status: 'waiting',
    };
    offer.event = { offer: offer.id, from: this.identity.id, ...msg };
    this.offers.set(offer.id, offer);
    t.status = 'waiting';
    this.service._out(t, true);

    try {
      await new Promise((resolve, reject) => {
        offer.resolve = resolve;
        offer.reject = reject;
        offer.timer = setTimeout(() => {
          if (offer.status === 'waiting') reject(codeError('TIMEOUT'));
        }, OFFER_TTL_MS);
        t.abort.signal.addEventListener('abort', () => reject(codeError('ABORTED')), { once: true });
        this._push(peer.id, 'offer', offer.event);
      });
      t.status = 'done';
    } catch (err) {
      if (err.code === 'DECLINED') {
        t.status = 'declined';
        t.reason = 'declined';
        return;
      }
      if (err.code === 'TIMEOUT') {
        t.status = 'declined';
        t.reason = 'timeout';
        return;
      }
      throw err;
    } finally {
      clearTimeout(offer.timer);
      if (offer.status === 'waiting' || offer.status === 'sending') offer.status = 'closed';
      setTimeout(() => this.offers.delete(offer.id), 30_000).unref();
    }
  }

  async _answer(req, res) {
    const body = await readJson(req);
    const offer = this.offers.get(body.offer);
    if (!offer || offer.status !== 'waiting') return reply(res, 410);
    let opened;
    try {
      opened = P.answerOpen({ k1: offer.k1, sk: this.identity.sk, e: offer.e, msg: body });
    } catch {
      return reply(res, 401);
    }
    if (!opened.answer.accepted) {
      offer.status = 'declined';
      offer.reject(codeError('DECLINED'));
      return reply(res, 200, { ok: true });
    }
    offer.key = Buffer.from(opened.key);
    if (!offer.files.length) {
      offer.status = 'done';
      offer.resolve();
      return reply(res, 200, { ok: true, session: offer.id });
    }
    offer.status = 'sending';
    offer.t.status = 'sending';
    this.service._out(offer.t, true);
    reply(res, 200, { ok: true, session: offer.id });
  }

  async _chunk(res, q) {
    const offer = this.offers.get(q.get('o'));
    if (!offer || offer.status !== 'sending') return reply(res, 410);
    const f = Number(q.get('f'));
    const c = Number(q.get('c'));
    const file = offer.files[f];
    if (!file || !Number.isInteger(c) || c < 0 || c > file.next) return reply(res, 409);
    const count = P.chunkCount(file.size);
    if (c >= count) return reply(res, 400);
    const last = c === count - 1;
    const len = last ? file.size - c * P.CHUNK_SIZE : P.CHUNK_SIZE;

    const buf = Buffer.allocUnsafe(len);
    const fh = await fsp.open(file.abs, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, len, c * P.CHUNK_SIZE);
      if (bytesRead !== len) throw codeError('CHANGED');
    } finally {
      await fh.close();
    }
    const sealed = sealChunk(offer.key, offer.id, f, c, last, buf);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': sealed.length, 'cache-control': 'no-store' });
    res.end(sealed);

    if (c === file.next) {
      file.next++;
      offer.t.sent += len;
      this.service._out(offer.t);
    }
    if (last && f === offer.files.length - 1 && offer.files.every((x) => x.next >= P.chunkCount(x.size))) {
      offer.status = 'done';
      offer.resolve();
    }
  }

  async _cancel(req, res) {
    const body = await readJson(req);
    const offer = this.offers.get(body.offer);
    if (!offer || !offer.key || !['sending', 'waiting'].includes(offer.status)) return reply(res, 410);
    let sig;
    try {
      sig = P.unb64(body.mac || '');
    } catch {
      return reply(res, 401);
    }
    if (!P.sameBytes(P.mac(offer.key, P.lv('wd-cancel', offer.id)), sig)) return reply(res, 401);
    offer.status = 'cancelled';
    offer.reject(codeError('REMOTE_CANCELLED'));
    reply(res, 200, { ok: true });
  }

  // PC cancelled a send to a phone.
  cancel(t) {
    for (const offer of this.offers.values()) {
      if (offer.t !== t || !['waiting', 'sending'].includes(offer.status)) continue;
      offer.status = 'cancelled';
      this._push(offer.phoneId, 'cancel', { offer: offer.id });
    }
  }
}

module.exports = { MobileHub, lanAddress };
