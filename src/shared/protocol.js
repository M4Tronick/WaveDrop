'use strict';

// WaveDrop protocol cryptography, shared by the desktop app (Node) and the
// phone web app (bundled for the browser). Pure JavaScript (noble libraries),
// so it also works on plain-HTTP pages where WebCrypto is unavailable.
//
//  Identity   X25519 static key pair per device; id = SHA-256(pk) prefix.
//  Pairing    CPace (balanced PAKE) on ristretto255 with a 6-digit code shown
//             on the receiver and typed on the sender. A man in the middle gets
//             one online guess per attempt; the receiver allows 3 attempts.
//  Transfers  Noise-IK-like handshake: the request is sealed with
//             DH(eA,sB)+DH(sA,sB) (authenticates the sender), the answer adds
//             DH(eB,eA)+DH(eB,sA) (forward secrecy, authenticates the receiver).
//             Files travel in 1 MiB chunks sealed with ChaCha20-Poly1305.
//  Phones     The Android and iPhone apps also serve /Ask, /Chunk and /Cancel
//             to each other (android/…/net/PeerServer.kt, ios/…/PeerCore.swift),
//             found over Bonjour (_wavedrop._tcp). Two phones pair with a QR
//             code instead of CPace: qrProof with "wd-peer-pair" / "wd-peer-ok".

const { x25519, ristretto255, ristretto255_hasher } = require('@noble/curves/ed25519.js');
const { chacha20poly1305 } = require('@noble/ciphers/chacha.js');
const { sha256, sha512 } = require('@noble/hashes/sha2.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { randomBytes, concatBytes, utf8ToBytes, bytesToHex } = require('@noble/hashes/utils.js');

const VERSION = 2;
const CHUNK_SIZE = 1024 * 1024;
const TAG_SIZE = 16;
const CODE_DIGITS = 6;

const Point = ristretto255.Point;
const te = (s) => utf8ToBytes(String(s));
const td = new TextDecoder();

// ───────────── encoding ─────────────

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(str) {
  if (typeof str !== 'string') throw new Error('expected base64 string');
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function u64(n) {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32));
  v.setUint32(4, n >>> 0);
  return b;
}

// Length-prefixed concatenation, so field boundaries cannot be shifted.
function lv(...parts) {
  return concatBytes(...parts.flatMap((p) => {
    const bytes = typeof p === 'string' ? te(p) : p;
    return [u32(bytes.length), bytes];
  }));
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sortedPair(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? [a, b] : [b, a];
  }
  return [a, b];
}

// ───────────── primitives ─────────────

const kdf = (ikm, salt, info, length = 32) => hkdf(sha256, ikm, salt, te(info), length);
const mac = (key, data) => hmac(sha256, key, data);

function seal(key, nonce, plaintext, aad) {
  return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

function open(key, nonce, ciphertext, aad) {
  return chacha20poly1305(key, nonce, aad).decrypt(ciphertext); // throws on tampering
}

const ZERO_NONCE = new Uint8Array(12);

function sealJson(key, label, value) {
  return b64(seal(key, ZERO_NONCE, te(JSON.stringify(value)), te(label)));
}

function openJson(key, label, data) {
  return JSON.parse(td.decode(open(key, ZERO_NONCE, unb64(data), te(label))));
}

// ───────────── identity ─────────────

function newKeyPair() {
  const sk = x25519.utils.randomSecretKey();
  return { sk, pk: x25519.getPublicKey(sk) };
}

function publicKeyOf(sk) {
  return x25519.getPublicKey(sk);
}

const dh = (sk, pk) => x25519.getSharedSecret(sk, pk); // rejects low-order points

function deviceId(pk) {
  return bytesToHex(sha256(concatBytes(te('wavedrop-id'), pk)).subarray(0, 10));
}

// 12 digits both people can read aloud to compare identities ("numero di sicurezza").
function safetyCode(pk) {
  const h = sha256(concatBytes(te('wavedrop-safety'), pk));
  let digits = '';
  for (let i = 0; digits.length < 12; i += 2) digits += String(((h[i] << 8) | h[i + 1]) % 1000).padStart(3, '0');
  return digits.slice(0, 12).replace(/(\d{4})(?=\d)/g, '$1 ');
}

// Long-term key shared by two paired devices (both sides compute the same).
function pairKey(sk, myPk, otherPk, purpose) {
  const [lo, hi] = sortedPair(myPk, otherPk);
  return kdf(dh(sk, otherPk), concatBytes(lo, hi), `wavedrop ${purpose} v${VERSION}`);
}

// Contacts-only presence: a fresh nonce plus a short tag per contact; only a
// contact holding the pair key can recognise the device.
function presenceTag(presenceKey, nonce) {
  return b64(mac(presenceKey, nonce).subarray(0, 6));
}

// ───────────── pairing (CPace on ristretto255) ─────────────

function randomCode() {
  // Rejection sampling for an unbiased 6-digit code.
  const limit = Math.floor(2 ** 32 / 10 ** CODE_DIGITS) * 10 ** CODE_DIGITS;
  for (;;) {
    const v = new DataView(randomBytes(4).buffer).getUint32(0);
    if (v < limit) return String(v % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
  }
}

function cpaceGenerator(code, sid, pkA, pkB) {
  const seed = sha512(lv('WaveDrop-CPace-v2', String(code), sid, pkA, pkB));
  return ristretto255_hasher.deriveToCurve(seed);
}

function cpaceStart(code, sid, pkA, pkB) {
  const y = ristretto255_hasher.hashToScalar(randomBytes(64));
  const Y = cpaceGenerator(code, sid, pkA, pkB).multiply(y);
  return { y, Y: Y.toBytes() };
}

function cpaceKeys(y, Yother, sid, YA, YB, pkA, pkB) {
  const point = Point.fromBytes(Yother); // validates encoding
  const K = point.multiply(y);
  if (K.equals(Point.ZERO)) throw new Error('invalid pairing message');
  const isk = sha512(lv('WaveDrop-CPace-ISK', sid, K.toBytes(), YA, YB));
  const transcript = lv(pkA, pkB, sid, YA, YB);
  return {
    macA: mac(kdf(isk, sid, 'pair confirm A'), transcript),
    macB: mac(kdf(isk, sid, 'pair confirm B'), transcript),
  };
}

// ───────────── transfer handshake ─────────────

// Sender → receiver: seal the request (file list, thumbnail, text…).
function askSeal({ sk, pk, peerPk, request }) {
  const e = newKeyPair();
  const salt = sha256(lv('wd-ask', pk, peerPk, e.pk));
  const k1 = kdf(concatBytes(dh(e.sk, peerPk), dh(sk, peerPk)), salt, 'wavedrop ask');
  return { e, k1, msg: { e: b64(e.pk), ct: sealJson(k1, 'wd-ask', request) } };
}

// Receiver: open it with the sender's pinned public key.
function askOpen({ sk, pk, peerPk, msg }) {
  const eA = unb64(msg.e);
  const salt = sha256(lv('wd-ask', peerPk, pk, eA));
  const k1 = kdf(concatBytes(dh(sk, eA), dh(sk, peerPk)), salt, 'wavedrop ask');
  return { eA, k1, request: openJson(k1, 'wd-ask', msg.ct) };
}

function sessionKey(dhEE, dhES, k1, eA, eB) {
  return kdf(concatBytes(dhEE, dhES, k1), sha256(lv('wd-session', eA, eB)), 'wavedrop session');
}

// Receiver → sender: answer, adding its ephemeral key for forward secrecy.
function answerSeal({ k1, eA, peerPk, answer }) {
  const e = newKeyPair();
  const key = sessionKey(dh(e.sk, eA), dh(e.sk, peerPk), k1, eA, e.pk);
  return { key, msg: { e: b64(e.pk), ct: sealJson(key, 'wd-answer', answer) } };
}

function answerOpen({ k1, sk, e, msg }) {
  const eB = unb64(msg.e);
  const key = sessionKey(dh(e.sk, eB), dh(sk, eB), k1, e.pk, eB);
  return { key, answer: openJson(key, 'wd-answer', msg.ct) };
}

// ───────────── file chunks ─────────────

function chunkNonce(file, index) {
  return concatBytes(u32(file), u64(index));
}

function chunkAad(session, file, index, last) {
  return concatBytes(te('wd-chunk'), lv(session), u32(file), u64(index), Uint8Array.of(last ? 1 : 0));
}

function sealChunk(key, session, file, index, last, data) {
  return seal(key, chunkNonce(file, index), data, chunkAad(session, file, index, last));
}

function openChunk(key, session, file, index, last, data) {
  return open(key, chunkNonce(file, index), data, chunkAad(session, file, index, last));
}

const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

// ───────────── phone pairing (QR code secret) ─────────────

const qrProof = (secret, label, a, b) => b64(mac(secret, lv(label, a, b)));

// ───────────── Home Screen box ─────────────
// A phone's web-app identity, sealed under a key that lives only in the
// address saved to its Home Screen (after the #, so never sent). The PC keeps
// the sealed copy and hands it back by id: an iPhone Home Screen app, whose
// storage is separate from Safari's, recovers the same identity without
// pairing again. Removing the phone on the PC deletes the box.

const HOME_INFO = 'wavedrop home box v1';
const homeBoxId = (key) => bytesToHex(sha256(lv('wd-home-id', key))).slice(0, 32);

function homeSeal(key, value) {
  const salt = randomBytes(16);
  return b64(concatBytes(salt, seal(kdf(key, salt, HOME_INFO), ZERO_NONCE, te(JSON.stringify(value)), te('wd-home'))));
}

function homeOpen(key, data) {
  const raw = unb64(data);
  const salt = raw.subarray(0, 16);
  return JSON.parse(td.decode(open(kdf(key, salt, HOME_INFO), ZERO_NONCE, raw.subarray(16), te('wd-home'))));
}

module.exports = {
  VERSION,
  CHUNK_SIZE,
  TAG_SIZE,
  b64,
  unb64,
  lv,
  te,
  sameBytes,
  randomBytes,
  sha256,
  mac,
  kdf,
  newKeyPair,
  publicKeyOf,
  deviceId,
  safetyCode,
  pairKey,
  presenceTag,
  randomCode,
  cpaceStart,
  cpaceKeys,
  askSeal,
  askOpen,
  answerSeal,
  answerOpen,
  chunkNonce,
  chunkAad,
  sealChunk,
  openChunk,
  chunkCount,
  qrProof,
  homeBoxId,
  homeSeal,
  homeOpen,
};
