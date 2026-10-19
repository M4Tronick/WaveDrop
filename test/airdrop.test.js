'use strict';

// The AirDrop adapter's parsing, against sample outputs of omdrop and
// OpenDrop (see test/fixtures/airdrop/README.md for where each format comes
// from). Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const A = require('../src/core/airdrop');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'airdrop', name), 'utf8');
const lines = (name) => fixture(name).split('\n').filter(Boolean);
const events = (name) => lines(name).map(A.parseSendLine).filter(Boolean);

// ───────── omdrop status / doctor ─────────

test('status: an open window', () => {
  const st = A.parseStatus(fixture('omdrop-status-visible.json'));
  assert.deepEqual(st, {
    receiving: true,
    visible: true,
    remaining: 541,
    name: 'matteo-thinkpad',
    dir: '/home/matteo/Downloads/WaveDrop',
    mode: 'timed',
    reason: null,
    audience: 'everyone',
  });
});

test('status: off, and a warning printed before the JSON', () => {
  const st = A.parseStatus(`omdrop: the installed manifest says 0.18.0 but this script is from 0.18.1.\n${fixture('omdrop-status-off.json')}`);
  assert.equal(st.visible, false);
  assert.equal(st.receiving, false);
  assert.equal(st.remaining, null);
  assert.equal(st.mode, 'off');
  assert.equal(st.dir, '/home/matteo/Downloads');
});

test('status: garbage is not a status', () => {
  assert.equal(A.parseStatus(''), null);
  assert.equal(A.parseStatus('Not receiving'), null);
  assert.equal(A.parseStatus('[]'), null);
  assert.equal(A.parseStatus('{"visible": "true", "dir": "relative/dir"}').visible, null);
  assert.equal(A.parseStatus('{"visible": "true", "dir": "relative/dir"}').dir, null);
});

test('doctor: a missing service does not block (the first `omdrop on` installs it)', () => {
  const d = A.parseDoctor(fixture('omdrop-doctor-first-use.json'));
  assert.equal(d.ready, false);
  assert.equal(d.missing.length, 1);
  assert.deepEqual(d.blocking, []);
});

test('doctor: an untested card blocks, with an Italian sentence', () => {
  const d = A.parseDoctor(fixture('omdrop-doctor-untested-card.json'));
  assert.equal(d.blocking.length, 1);
  assert.equal(d.blocking[0].id, 'hardware');
  assert.match(d.blocking[0].say, /ath11k_pci/);
  assert.match(A.doctorMessage(d.blocking[0]), /scheda Wi-Fi/);
  assert.match(A.doctorMessage({ id: 'backend-radio', say: '' }), /omdrop-owl/);
  assert.match(A.doctorMessage({ id: 'something-new', say: '' }), /omdrop doctor/);
});

// ───────── peers ─────────

test('peers --stream: JSON lines, placeholders are not names', () => {
  const peers = lines('omdrop-peers-stream.txt').map(A.parsePeerLine);
  assert.deepEqual(peers[0], { mac: '22:8b:38:31:89:4e', rssi: -34, name: 'hume' });
  assert.deepEqual(peers[1], { mac: 'b2:c4:98:5e:e6:be', rssi: null, name: null });
  assert.equal(peers[2].name, "Brent's iPhone");
  assert.equal(peers[3].name, 'iPhone di Matteo');
});

test("peers: send-to-peer's table gives the same peers", () => {
  const peers = A.parsePeers(fixture('send-to-peer-list.txt'));
  assert.equal(peers.length, 4);
  assert.deepEqual(peers[0], { mac: '22:8b:38:31:89:4e', rssi: -34, name: 'hume' });
  assert.equal(peers[1].name, null); // (no response)
  assert.equal(peers[1].rssi, null); // "? dBm"
  assert.equal(peers[3].name, null); // no name column at all
});

test('peers: a JSON array (peers --json -n) and junk lines', () => {
  const arr = JSON.stringify(lines('omdrop-peers-stream.txt').map((l) => JSON.parse(l)));
  assert.equal(A.parsePeers(arr).length, 4);
  assert.equal(A.parsePeerLine('No devices found yet. Open the AirDrop sheet…'), null);
  assert.equal(A.parsePeerLine('{"mac": "not-a-mac", "name": "x"}'), null);
  assert.equal(A.parsePeerLine('{broken'), null);
});

// ───────── sending ─────────

test('send: two files accepted and stored', () => {
  const ev = events('omdrop-send-ok.txt');
  assert.deepEqual(ev.map((e) => e.type), ['asking', 'accepted', 'sent', 'sent']);
  assert.equal(ev[2].name, 'IMG_0042.HEIC');
  assert.equal(ev[3].name, 'Preventivo.pdf');
  assert.deepEqual(A.sendOutcome(0, ev), { status: 'done', reason: null });
});

test('send: a link', () => {
  const ev = events('omdrop-send-link.txt');
  assert.deepEqual(ev[2], { type: 'sent', name: 'https://www.example.com/', link: true });
  assert.equal(A.sendOutcome(0, ev).status, 'done');
});

test('send: declined, self-signed identity, cancelled', () => {
  assert.deepEqual(A.sendOutcome(1, events('omdrop-send-declined.txt')), { status: 'declined', reason: 'declined' });
  assert.deepEqual(A.sendOutcome(1, events('omdrop-send-self-signed.txt')), { status: 'failed', reason: 'AIRDROP_EVERYONE' });
  assert.equal(A.sendOutcome(130, events('omdrop-send-cancelled.txt')).status, 'cancelled');
  assert.equal(A.sendOutcome(130, []).status, 'cancelled');
});

test('send: the raw sender log (--verbose) reads the same', () => {
  const ev = events('omdrop-send-verbose.txt');
  assert.deepEqual(ev.map((e) => e.type), ['asking', 'accepted', 'sent']);
  assert.equal(ev[2].name, 'photo.jpg');
  assert.equal(ev[2].detail, '2493 B, 0.62s');
});

test('send: failure sentences map to reasons', () => {
  const reason = (line, code = 1) => A.sendOutcome(code, [A.parseSendLine(line)].filter(Boolean)).reason;
  assert.equal(reason('They never answered: timed out'), 'AIRDROP_UNREACHABLE');
  assert.equal(reason('It is not accepting files right now. On an iPhone, open a share sheet to wake AirDrop, then try again.'), 'AIRDROP_UNREACHABLE');
  assert.equal(reason('e2:9d:03:6c:58:23 never opened 8770; on an iPhone, open a share sheet'), 'AIRDROP_UNREACHABLE');
  assert.equal(reason('No device matching "aa:bb" was found. See what is nearby:  omdrop peers'), 'AIRDROP_NOT_FOUND');
  assert.equal(reason('The Apple-compatible radio is not running, so nobody can be heard and nothing can be sent.'), 'AIRDROP_OFF');
  assert.equal(reason('/home/m/Foto: a folder cannot be sent -- send files, or compress the folder first'), 'AIRDROP_FOLDER');
  assert.equal(reason('The transfer failed: connection reset'), 'AIRDROP_FAILED');
  assert.equal(reason('something nobody expected'), 'AIRDROP_FAILED');
  // Exit 0 with nothing to show for it is not a success either.
  assert.equal(A.sendOutcome(0, []).status, 'failed');
});

test('send (OpenDrop): exit 0 either way, the lines decide', () => {
  assert.equal(A.sendOutcome(0, events('opendrop-send-ok.txt')).status, 'done');
  assert.equal(A.sendOutcome(0, events('opendrop-send-declined.txt')).status, 'declined');
  assert.deepEqual(A.sendOutcome(0, events('opendrop-send-no-report.txt')), { status: 'failed', reason: 'AIRDROP_NOT_FOUND' });
});

// ───────── receiving ─────────

test('receiver log: asks, stored files, links, refusals', () => {
  const ev = lines('airdrop-receiver-journal.txt').map(A.parseReceiverLine);
  assert.equal(ev[0], null); // unrelated line
  assert.deepEqual(ev[1], { type: 'ask', sender: 'iPhone di Matteo', model: 'iPhone', kind: 'public.heic', count: 1 });
  assert.equal(ev[2], null); // budget line
  assert.deepEqual(ev[5], { type: 'stored', id: '6F1C2A90', names: ['IMG_0042.HEIC'] });
  assert.deepEqual(ev[6], { type: 'ask', sender: 'Mac di Giulia', model: 'MacBookPro18,3', kind: 'public.jpeg,com.adobe.pdf', count: 2 });
  assert.deepEqual(ev[7].names, ['foto', 'mare.jpg', 'Preventivo.pdf']);
  assert.equal(ev[8].kind, 'links');
  assert.deepEqual(ev[9], { type: 'link', name: 'www.example.com.url', url: 'https://www.example.com/' });
  assert.deepEqual(ev[10], { type: 'refused' });
});

test('receiver log: a sender without a model logs None', () => {
  const ev = A.parseReceiverLine('2026-10-19 21:14:02,101 INFO root: ask from None (None): type ?, 0 item(s): -');
  assert.equal(ev.sender, null);
  assert.equal(ev.model, null);
});

test('stored names: commas inside a file name are put back together', () => {
  const onDisk = new Set(['/inbox/foto, mare.jpg', '/inbox/Preventivo.pdf']);
  const paths = A.resolveStored('/inbox', ['foto', 'mare.jpg', 'Preventivo.pdf'], (p) => onDisk.has(p));
  assert.deepEqual(paths, ['/inbox/foto, mare.jpg', '/inbox/Preventivo.pdf']);
  assert.deepEqual(A.resolveStored('/inbox', ['gone.jpg'], () => false), []);
});

test('OpenDrop receive: listening, receiving, received', () => {
  const ev = lines('opendrop-receive.txt').map(A.parseOpenDropReceive);
  assert.equal(ev[0], null);
  assert.deepEqual(ev[1], { type: 'listening' });
  assert.deepEqual(ev[2], { type: 'receiving' });
  assert.equal(ev[3].type, 'received');
  assert.equal(ev[3].size, Math.round(2.4 * 1024 * 1024));
});

test('OpenDrop receive: what is new in the folder', () => {
  const before = new Map([['vecchio.txt', '3:100']]);
  const after = new Map([['vecchio.txt', '3:100'], ['IMG_1.HEIC', '2516582:200'], ['b.pdf', '10:200']]);
  assert.deepEqual(A.newEntries(before, after), ['IMG_1.HEIC', 'b.pdf']);
});

test('OpenDrop find', () => {
  const found = lines('opendrop-find.txt').map(A.parseOpenDropFind);
  assert.equal(found[0], null);
  assert.deepEqual(found[1], { index: 0, id: 'eccb2f2dcfe7', name: 'John’s iPhone' });
  assert.deepEqual(found[2], { index: 1, id: 'e63138ac6ba8', name: 'Jane’s MacBook Pro' });
});

// ───────── Wi-Fi mode ─────────

test('owl-profiles: Intel iwlwifi (the AC 9560) runs exclusive, unknown cards fall back to "*"', () => {
  const table = fixture('owl-profiles.txt');
  assert.equal(A.owlProfileFor('iwlwifi', [table]).mode, 'exclusive');
  assert.equal(A.owlProfileFor('mt76x2u', [table]).mode, 'active-monitor');
  assert.equal(A.owlProfileFor('mt7925e', [table]).mode, 'shared');
  assert.equal(A.owlProfileFor('ath11k_pci', [table]).driver, '*');
  // /etc/omdrop/owl-profiles is read first and wins.
  assert.equal(A.owlProfileFor('iwlwifi', ['iwlwifi tested shared station no no local test', table]).mode, 'shared');
  assert.equal(A.owlProfileFor('iwlwifi', []), null);
});

test('misc helpers', () => {
  assert.equal(A.stripLogPrefix('2026-09-18 12:00:02,000 INFO send: +  2.10s ASK -> accepted (1.69s)'), 'ASK -> accepted (1.69s)');
  assert.ok(A.isWebUrl('https://example.com/a?b=1'));
  assert.ok(!A.isWebUrl('ciao, come va?'));
  assert.ok(!A.isWebUrl('https://example.com/ e poi testo'));
  assert.match(A.onFailure('Error executing command as another user: Not authorized'), /Autorizzazione negata/);
  assert.match(A.onFailure('mysterious'), /omdrop on/);
});

// ───────── the bridge, driven by a fake CLI ─────────

// A stand-in for child_process.spawn that replays canned output.
function fakeSpawn(script) {
  const calls = [];
  const impl = (bin, args, opts) => {
    const child = new EventEmitter();
    calls.push({ bin, args, opts, child });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = null;
    child.kill = (signal) => {
      child.killed = signal;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 130, signal));
    };
    const plan = script(bin, args) || {};
    setImmediate(() => {
      if (plan.hang) {
        for (const l of plan.out || []) child.stdout.write(`${l}\n`);
        return;
      }
      child.stdout.end((plan.out || []).map((l) => `${l}\n`).join(''));
      child.stderr.end((plan.err || []).map((l) => `${l}\n`).join(''));
      setImmediate(() => child.emit('close', plan.code ?? 0, null));
    });
    return child;
  };
  return { impl, calls };
}

function bridgeWith(spawnImpl, inbox = '/inbox') {
  const b = new A.AirDropBridge({ platform: 'linux', inbox: () => inbox, name: () => 'PC', spawnImpl, env: { PATH: '' }, home: '/nowhere' });
  b.backend = 'omdrop';
  b.bin = '/usr/bin/omdrop';
  b.state = 'visible';
  return b;
}

test('bridge: not Linux means unsupported, and nothing runs', async () => {
  const { impl, calls } = fakeSpawn(() => ({}));
  const b = new A.AirDropBridge({ platform: 'win32', inbox: () => 'C:\\x', spawnImpl: impl });
  assert.equal((await b.refresh()).state, 'unsupported');
  assert.equal(b.available, false);
  assert.equal(await b.setVisible(true), false);
  assert.equal(calls.length, 0);
});

test('bridge: discovery lists named peers only, and send goes --to their address', async () => {
  const peerLines = lines('omdrop-peers-stream.txt');
  const { impl, calls } = fakeSpawn((bin, args) => {
    if (args[0] === 'peers') return { out: peerLines, hang: true };
    if (args[0] === 'send') return { out: lines('omdrop-send-ok.txt') };
    return {};
  });
  const b = bridgeWith(impl);
  b.setDiscovering(true);
  await new Promise((r) => setTimeout(r, 30));
  const names = b.list().map((p) => p.name).sort();
  assert.deepEqual(names, ["Brent's iPhone", 'hume', 'iPhone di Matteo']);

  const peer = b.list().find((p) => p.name === 'iPhone di Matteo');
  const seen = [];
  const files = [
    { abs: '/home/m/IMG_0042.HEIC', name: 'IMG_0042.HEIC', size: 2516582 },
    { abs: '/home/m/Preventivo.pdf', name: 'Preventivo.pdf', size: 183204 },
  ];
  const result = await b.send(peer, { files, onEvent: (e) => seen.push(e.type) });
  assert.deepEqual(result, { status: 'done', reason: null });
  assert.deepEqual(seen, ['asking', 'accepted', 'sent', 'sent']);
  const send = calls.find((c) => c.args[0] === 'send');
  assert.deepEqual(send.args, ['send', '--to', '86:08:04:8a:2b:f4', '--wait', '30', '--', '/home/m/IMG_0042.HEIC', '/home/m/Preventivo.pdf']);
  // The name lookup was stopped for the send (it shares the radio).
  assert.equal(calls.find((c) => c.args[0] === 'peers').child.killed, 'SIGTERM');
  b.setDiscovering(false);
});

test('bridge: folders are refused before anything runs, links go as links', async () => {
  const { impl, calls } = fakeSpawn((bin, args) => (args[0] === 'send' ? { out: lines('omdrop-send-link.txt') } : {}));
  const b = bridgeWith(impl);
  b.peers.set('airdrop:f2:f2:ee:c4:5a:f7', { id: 'airdrop:f2:f2:ee:c4:5a:f7', name: "Brent's iPhone", rssi: null, target: 'f2:f2:ee:c4:5a:f7', seenAt: Date.now() });
  const peer = { id: 'airdrop:f2:f2:ee:c4:5a:f7' };
  const folder = await b.send(peer, { files: [{ abs: '/home/m/Foto/a.jpg', name: 'Foto/a.jpg', size: 1 }] });
  assert.deepEqual(folder, { status: 'failed', reason: 'AIRDROP_FOLDER' });
  assert.equal(calls.length, 0);
  const link = await b.send(peer, { text: ' https://www.example.com/ ' });
  assert.equal(link.status, 'done');
  assert.deepEqual(calls[0].args.slice(-2), ['--', 'https://www.example.com/']);
});

test('bridge: cancelling a send stops the omdrop process', async () => {
  const { impl, calls } = fakeSpawn(() => ({ out: ['Asking them to accept it...'], hang: true }));
  const b = bridgeWith(impl);
  b.peers.set('airdrop:x', { id: 'airdrop:x', name: 'Mac', rssi: null, target: '22:8b:38:31:89:4e', seenAt: Date.now() });
  const ac = new AbortController();
  const pending = b.send({ id: 'airdrop:x' }, { files: [{ abs: '/a.txt', name: 'a.txt', size: 1 }], signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(calls[0].child.killed, 'SIGTERM');
});

test('bridge: received files from the journal are reported with their sender', async () => {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-airdrop-'));
  fs.writeFileSync(path.join(inbox, 'IMG_0042.HEIC'), 'x');
  fs.writeFileSync(path.join(inbox, 'foto, mare.jpg'), 'y');
  fs.writeFileSync(path.join(inbox, 'Preventivo.pdf'), 'z');
  fs.writeFileSync(path.join(inbox, 'www.example.com.url'), '[InternetShortcut]\nURL=https://www.example.com/\n');
  const { impl } = fakeSpawn((bin) => (bin === 'journalctl' ? { out: lines('airdrop-receiver-journal.txt'), hang: true } : {}));
  const b = bridgeWith(impl, inbox);
  b.dir = inbox;
  const got = [];
  b.on('received', (r) => got.push(r));
  b._followReceiver();
  await new Promise((r) => setTimeout(r, 30));
  b.follower.kill();
  try {
    assert.equal(got.length, 3);
    assert.equal(got[0].sender, 'iPhone di Matteo');
    assert.deepEqual(got[0].paths.map((p) => path.basename(p)), ['IMG_0042.HEIC']);
    assert.equal(got[1].sender, 'Mac di Giulia');
    assert.deepEqual(got[1].paths.map((p) => path.basename(p)), ['foto, mare.jpg', 'Preventivo.pdf']);
    assert.deepEqual(got[2].links, ['https://www.example.com/']);
  } finally {
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});
