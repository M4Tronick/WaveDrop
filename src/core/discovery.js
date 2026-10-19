'use strict';

// LAN discovery over UDP multicast + subnet broadcast (plus unicast probes for
// devices found over Bluetooth, see ble.js).
//
// visibility "everyone": hello carries id, name and public key.
// visibility "contacts": hello carries only a fresh nonce and one short tag
//   per contact (HMAC with the pair's presence key); strangers learn nothing
//   and cannot link two announcements together.
// visibility "off": no announcements at all.

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const P = require('../shared/protocol');

const GROUP = '239.255.42.99';
const PORT = 47474;
const ANNOUNCE_MS = 2000;
const PEER_TTL_MS = 7000;
const ADDRESS_STICKY_MS = 4500;

function broadcastOf(ip, mask) {
  const a = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  return a.map((b, i) => (b & m[i]) | (~m[i] & 255)).join('.');
}

function ipv4Interfaces() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push({ address: a.address, broadcast: broadcastOf(a.address, a.netmask) });
      }
    }
  }
  return out;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class Discovery extends EventEmitter {
  constructor(describeSelf, contacts) {
    super();
    this.describeSelf = describeSelf;
    this.contacts = contacts;
    this.peers = new Map();
    this.senders = new Map();
    this.joined = new Set();
    this.timers = [];
    // Identifies our own queries without revealing who we are.
    this.queryToken = P.b64(P.randomBytes(9));
  }

  start() {
    const sock = (this.listener = dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on('error', (err) => this.emit('error', err));
    sock.bind(PORT, () => {
      try {
        sock.setMulticastLoopback(true);
      } catch {}
      this._refreshInterfaces();
      // Senders bind asynchronously; give them a moment before the first hello.
      setTimeout(() => {
        this.query();
        this.announce();
      }, 150);
    });
    this.timers.push(
      setInterval(() => this.announce(), ANNOUNCE_MS),
      setInterval(() => this._prune(), 1000),
      setInterval(() => this._refreshInterfaces(), 10000),
    );
  }

  stop() {
    this.bye();
    this.timers.forEach(clearInterval);
    for (const { socket } of this.senders.values()) socket.close();
    this.senders.clear();
    try {
      this.listener?.close();
    } catch {}
  }

  list() {
    return [...this.peers.values()]
      .map(({ addressSeen, lastSeen, ...p }) => p)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.peers.get(id);
  }

  // Our own announcement, also served on GET /Hello.
  hello() {
    const self = this.describeSelf();
    if (self.visibility === 'off' || !self.port) return null;
    if (self.visibility === 'contacts') {
      const nonce = P.randomBytes(12);
      return { kind: 'hello', vis: 'contacts', port: self.port, n: P.b64(nonce), tags: this.contacts.presenceTags(nonce) };
    }
    return {
      kind: 'hello',
      vis: 'everyone',
      id: self.id,
      pk: self.pk,
      name: self.name,
      platform: self.platform,
      port: self.port,
      av: self.avatar,
      c: self.color,
    };
  }

  announce() {
    const hello = this.hello();
    if (hello) this._send(hello);
  }

  // Ask everyone on the LAN to announce right away (used when the UI opens).
  query() {
    this._send({ kind: 'query', q: this.queryToken });
  }

  // Only public announcements say goodbye; a contacts-only id must not leak.
  bye() {
    const self = this.describeSelf();
    if (self.visibility === 'everyone') this._send({ kind: 'bye', id: self.id });
  }

  // Accepts a hello from UDP or from a unicast /Hello probe.
  ingest(m, address) {
    if (!m || m.kind !== 'hello' || !Number.isInteger(m.port) || m.port <= 0 || m.port > 65535) return;

    let peer;
    if (m.vis === 'contacts') {
      let nonce;
      try {
        nonce = P.unb64(m.n);
      } catch {
        return;
      }
      if (nonce.length !== 12) return;
      const contact = this.contacts.matchPresence(nonce, m.tags);
      if (!contact) return;
      peer = {
        id: contact.id,
        pk: contact.pk,
        name: contact.name,
        platform: contact.platform,
        avatar: contact.avatarHash || '',
        color: contact.color || 0,
        hidden: true,
      };
    } else {
      let pk;
      try {
        pk = P.unb64(m.pk);
      } catch {
        return;
      }
      if (pk.length !== 32 || P.deviceId(pk) !== m.id) return; // id must match the key
      peer = {
        id: m.id,
        pk: m.pk,
        name: str(m.name, 40) || 'Sconosciuto',
        platform: str(m.platform, 16),
        avatar: str(m.av, 16),
        color: Number.isInteger(m.c) ? m.c : 0,
        hidden: false,
      };
    }
    if (peer.id === this.describeSelf().id) return;

    const now = Date.now();
    const prev = this.peers.get(peer.id);
    // A multi-homed peer is heard on several addresses; stick to one while it stays fresh.
    let addressSeen = now;
    if (prev && prev.address !== address && now - prev.addressSeen < ADDRESS_STICKY_MS) {
      address = prev.address;
      addressSeen = prev.addressSeen;
    }
    Object.assign(peer, { port: m.port, address, addressSeen, lastSeen: now });
    this.peers.set(peer.id, peer);
    const changed =
      !prev || ['name', 'port', 'address', 'avatar', 'color', 'pk'].some((k) => prev[k] !== peer[k]);
    if (changed) this.emit('change');
  }

  _send(payload) {
    const buf = Buffer.from(JSON.stringify({ app: 'wavedrop', v: P.VERSION, ...payload }));
    for (const { socket, broadcast, ready } of this.senders.values()) {
      if (!ready()) continue;
      socket.send(buf, PORT, GROUP, () => {});
      socket.send(buf, PORT, broadcast, () => {});
    }
  }

  _refreshInterfaces() {
    const current = ipv4Interfaces();
    const live = new Set(current.map((i) => i.address));

    for (const [ip, sender] of this.senders) {
      if (!live.has(ip)) {
        sender.socket.close();
        this.senders.delete(ip);
        this.joined.delete(ip);
      }
    }

    for (const { address, broadcast } of current) {
      if (!this.joined.has(address)) {
        try {
          this.listener.addMembership(GROUP, address);
          this.joined.add(address);
        } catch {}
      }
      if (this.senders.has(address)) continue;
      const socket = dgram.createSocket({ type: 'udp4' });
      let bound = false;
      socket.on('error', () => {
        socket.close();
        this.senders.delete(address);
      });
      socket.bind({ address, port: 0 }, () => {
        try {
          socket.setBroadcast(true);
          socket.setMulticastTTL(2);
          socket.setMulticastLoopback(true);
          socket.setMulticastInterface(address);
          bound = true;
        } catch {}
      });
      this.senders.set(address, { socket, broadcast, ready: () => bound });
    }
  }

  _onMessage(buf, rinfo) {
    if (buf.length > 4096) return;
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.app !== 'wavedrop' || m.v !== P.VERSION) return;
    const self = this.describeSelf();

    if (m.kind === 'query') {
      if (m.q !== this.queryToken && self.visibility !== 'off') {
        clearTimeout(this.replyTimer);
        this.replyTimer = setTimeout(() => this.announce(), 50 + Math.random() * 250);
      }
      return;
    }

    if (m.kind === 'bye') {
      if (typeof m.id === 'string' && this.peers.delete(m.id)) this.emit('change');
      return;
    }

    this.ingest(m, rinfo.address);
  }

  _prune() {
    const cutoff = Date.now() - PEER_TTL_MS;
    let changed = false;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }
}

module.exports = { Discovery, ipv4Interfaces };
