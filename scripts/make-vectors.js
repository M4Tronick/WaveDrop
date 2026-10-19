// Generates protocol test vectors from src/shared/protocol.js for the native
// apps (Android/iOS), so their ports can be checked byte for byte.
// Run: node scripts/make-vectors.js > android/app/src/test/resources/vectors.json
'use strict';

const P = require('../src/shared/protocol');
const { x25519 } = require('@noble/curves/ed25519.js');

const hex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const key = (h) => {
  const sk = fromHex(h);
  return { sk, pk: x25519.getPublicKey(sk) };
};

// Fixed keys so the native tests are deterministic.
const A = key('a0'.repeat(31) + '01'); // phone
const B = key('b0'.repeat(31) + '02'); // PC
const EA = key('e1'.repeat(32)); // phone ephemeral
const EB = key('e2'.repeat(32)); // PC ephemeral

const request = { name: 'Telefono', platform: 'android', files: [{ name: 'foto.jpg', size: 3 }], text: null, thumbnail: null };
// askSeal/answerSeal draw a random ephemeral key internally, so the
// deterministic values are rebuilt here from the same exported primitives.
const ask = (() => {
  const salt = P.sha256(P.lv('wd-ask', A.pk, B.pk, EA.pk));
  const dh1 = x25519.getSharedSecret(EA.sk, B.pk);
  const dh2 = x25519.getSharedSecret(A.sk, B.pk);
  const k1 = P.kdf(new Uint8Array([...dh1, ...dh2]), salt, 'wavedrop ask');
  return { k1 };
})();

// Cross-check our manual k1 against the real askSeal/askOpen path.
const realAsk = P.askSeal({ sk: A.sk, pk: A.pk, peerPk: B.pk, request });
const opened = P.askOpen({ sk: B.sk, pk: B.pk, peerPk: A.pk, msg: realAsk.msg });
if (JSON.stringify(opened.request) !== JSON.stringify(request)) throw new Error('self-check failed');

const sessionKey = (() => {
  const dhEE = x25519.getSharedSecret(EB.sk, EA.pk);
  const dhES = x25519.getSharedSecret(EB.sk, A.pk);
  const salt = P.sha256(P.lv('wd-session', EA.pk, EB.pk));
  return P.kdf(new Uint8Array([...dhEE, ...dhES, ...ask.k1]), salt, 'wavedrop session');
})();

const chunkData = new Uint8Array(100).map((_, i) => i);
const sealedChunk = P.sealChunk(sessionKey, 'sessione-1', 2, 5, true, chunkData);
const linkKey = P.pairKey(A.sk, A.pk, B.pk, 'link');
const presenceKey = P.pairKey(A.sk, A.pk, B.pk, 'presence');
const secret = fromHex('5e'.repeat(16));

// A full sealed request/answer from JS, for the native side to open.
const jsAsk = P.askSeal({ sk: B.sk, pk: B.pk, peerPk: A.pk, request: { name: 'PC', platform: 'win32', files: [{ name: 'a.txt', size: 4 }], text: null } });
const jsAnswerOpenedByPhone = P.askOpen({ sk: A.sk, pk: A.pk, peerPk: B.pk, msg: jsAsk.msg });
const jsAnswer = P.answerSeal({ k1: jsAnswerOpenedByPhone.k1, eA: jsAnswerOpenedByPhone.eA, peerPk: B.pk, answer: { accepted: true, session: 's', token: 't' } });

const vectors = {
  phone: { sk: hex(A.sk), pk: hex(A.pk), id: P.deviceId(A.pk), safety: P.safetyCode(A.pk) },
  pc: { sk: hex(B.sk), pk: hex(B.pk), id: P.deviceId(B.pk), safety: P.safetyCode(B.pk) },
  ephemeralPhone: { sk: hex(EA.sk), pk: hex(EA.pk) },
  ephemeralPc: { sk: hex(EB.sk), pk: hex(EB.pk) },
  b64: { bytes: hex(fromHex('00ff10fe7f80')), text: P.b64(fromHex('00ff10fe7f80')) },
  lv: { hex: hex(P.lv('ab', fromHex('0102'))) },
  ask: { k1: hex(ask.k1) },
  session: { key: hex(sessionKey) },
  chunk: {
    session: 'sessione-1',
    file: 2,
    index: 5,
    last: true,
    plain: hex(chunkData),
    nonce: hex(P.chunkNonce(2, 5)),
    aad: hex(P.chunkAad('sessione-1', 2, 5, true)),
    sealed: hex(sealedChunk),
  },
  pairKeys: { link: hex(linkKey), presence: hex(presenceKey) },
  events: { t: '1792440662716', mac: P.b64(P.mac(linkKey, P.lv('wd-events', '1792440662716'))) },
  cancel: { offer: 'offerta-1', mac: P.b64(P.mac(sessionKey, P.lv('wd-cancel', 'offerta-1'))) },
  qr: {
    secret: hex(secret),
    pairProof: P.qrProof(secret, 'wd-mobile-pair', A.pk, B.pk),
    okProof: P.qrProof(secret, 'wd-mobile-ok', B.pk, A.pk),
  },
  chunkCount: [[0, 1], [1, 1], [1048576, 1], [1048577, 2], [5 * 1048576, 5]],
  // JS-made messages the native side must be able to open.
  jsAsk: { msg: jsAsk.msg, request: { name: 'PC', platform: 'win32', files: [{ name: 'a.txt', size: 4 }], text: null } },
  jsAnswer: { msg: jsAnswer.msg, askK1: hex(jsAnswerOpenedByPhone.k1), note: 'answer to jsAsk sealed by the phone side; opened by the PC with ephemeral from jsAsk' },
  jsAskEphemeral: { sk: hex(jsAsk.e.sk), pk: hex(jsAsk.e.pk), k1: hex(jsAsk.k1) },
};

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
