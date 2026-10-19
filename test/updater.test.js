'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Updater, newer, installKind, parseSums } = require('../src/core/updater');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A fake GitHub: /releases/latest plus the assets it lists.
function fakeGitHub({ tag = 'v1.2.0', files = {}, sums }) {
  const assets = Object.entries(files).map(([name, data]) => ({ name, size: data.length, browser_download_url: `https://dl/${name}` }));
  const sumText = sums ?? Object.entries(files).map(([n, d]) => `${sha(d)}  ${n}`).join('\n');
  assets.push({ name: 'SHA256SUMS.txt', size: sumText.length, browser_download_url: 'https://dl/SHA256SUMS.txt' });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: tag, body: 'Novità', html_url: 'https://github.com/x/y/releases/tag/' + tag, assets }) };
    }
    const name = url.replace('https://dl/', '');
    const data = name === 'SHA256SUMS.txt' ? Buffer.from(sumText) : files[name];
    if (!data) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(data.length) },
      text: async () => data.toString(),
      body: (async function* () {
        for (let i = 0; i < data.length; i += 7) yield data.subarray(i, i + 7);
      })(),
    };
  };
  return { fetchImpl, calls };
}

function fakeSpawn(log, { fail = false } = {}) {
  return (cmd, args) => {
    log.push([cmd, args]);
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
    return child;
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wd-upd-'));

test('versions compare numerically', () => {
  assert.ok(newer('1.0.10', '1.0.9'));
  assert.ok(newer('v2.0.0', '1.9.9'));
  assert.ok(!newer('1.0.1', '1.0.1'));
  assert.ok(!newer('1.0.0', '1.0.1'));
});

test('install kinds pick the right release asset', () => {
  assert.equal(installKind({ packaged: false }).kind, 'source');
  assert.equal(installKind({ packaged: true, platform: 'win32', env: {} }).kind, 'installer');
  assert.ok(installKind({ packaged: true, platform: 'win32', env: {} }).asset.test('WaveDrop-Setup-1.2.0.exe'));
  const portable = installKind({ packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\WaveDrop.exe' } });
  assert.equal(portable.kind, 'portable');
  assert.ok(portable.asset.test('WaveDrop-1.2.0-portable.exe') && !portable.asset.test('WaveDrop-Setup-1.2.0.exe'));
  assert.equal(installKind({ packaged: true, platform: 'linux', env: { APPIMAGE: '/a/WaveDrop.AppImage' } }).kind, 'appimage');
  assert.equal(installKind({ packaged: true, platform: 'darwin', env: {} }).kind, 'other');
});

test('SHA256SUMS.txt parses with or without the binary marker', () => {
  const h = 'a'.repeat(64);
  const m = parseSums(`${h}  one.exe\r\n${h} *two.AppImage\nnoise`);
  assert.equal(m.get('one.exe'), h);
  assert.equal(m.get('two.AppImage'), h);
  assert.equal(m.size, 2);
});

test('check reports a newer release, or that this one is the latest', async () => {
  const gh = fakeGitHub({ tag: 'v1.2.0' });
  const base = { repo: 'x/y', packaged: true, enabled: () => true, openUrl() {}, quit() {}, fetchImpl: gh.fetchImpl, platform: 'win32', env: {} };
  const older = new Updater({ ...base, version: '1.0.1' });
  let announced = null;
  older.on('available', (v) => (announced = v.latest));
  assert.equal((await older.check()).status, 'available');
  assert.equal(announced, '1.2.0');
  assert.equal((await new Updater({ ...base, version: '1.2.0' }).check()).status, 'latest');
});

test('AppImage update: downloads, verifies, replaces the file and relaunches', async () => {
  const dir = tmp();
  const appImage = path.join(dir, 'WaveDrop.AppImage');
  fs.writeFileSync(appImage, 'old');
  const fresh = Buffer.from('new AppImage bytes '.repeat(50));
  const gh = fakeGitHub({ files: { 'WaveDrop-1.2.0.AppImage': fresh, 'WaveDrop-Setup-1.2.0.exe': Buffer.from('exe') } });
  const spawned = [];
  let quit = false;
  const u = new Updater({
    repo: 'x/y', version: '1.0.1', packaged: true, enabled: () => true, openUrl() {}, quit: () => (quit = true),
    fetchImpl: gh.fetchImpl, spawnImpl: fakeSpawn(spawned), platform: 'linux', env: { APPIMAGE: appImage }, tmpDir: dir,
  });
  await u.check();
  const v = await u.update();
  assert.equal(v.status, 'installing', v.error);
  assert.deepEqual(fs.readFileSync(appImage), fresh);
  assert.deepEqual(spawned, [[appImage, []]]);
  assert.ok(!gh.calls.some((c) => c.includes('Setup')), 'only the matching asset is downloaded');
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(quit);
});

test('a download that does not match SHA256SUMS.txt is thrown away', async () => {
  const dir = tmp();
  const gh = fakeGitHub({ files: { 'WaveDrop-Setup-1.2.0.exe': Buffer.from('tampered') }, sums: `${'0'.repeat(64)}  WaveDrop-Setup-1.2.0.exe` });
  const spawned = [];
  const u = new Updater({
    repo: 'x/y', version: '1.0.1', packaged: true, enabled: () => true, openUrl() {}, quit() { throw new Error('must not quit'); },
    fetchImpl: gh.fetchImpl, spawnImpl: fakeSpawn(spawned), platform: 'win32', env: {}, tmpDir: dir,
  });
  await u.check();
  const v = await u.update();
  assert.equal(v.status, 'available');
  assert.match(v.error, /impronta/);
  assert.equal(spawned.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'wavedrop-update', 'WaveDrop-Setup-1.2.0.exe')));
});

test('Windows installer runs silently; a failed start keeps the app running', async () => {
  const dir = tmp();
  const gh = fakeGitHub({ files: { 'WaveDrop-Setup-1.2.0.exe': Buffer.from('setup') } });
  const spawned = [];
  const ok = new Updater({
    repo: 'x/y', version: '1.0.1', packaged: true, enabled: () => true, openUrl() {}, quit() {},
    fetchImpl: gh.fetchImpl, spawnImpl: fakeSpawn(spawned), platform: 'win32', env: {}, tmpDir: dir,
  });
  await ok.check();
  assert.equal((await ok.update()).status, 'installing');
  assert.deepEqual(spawned[0][1], ['--updated', '/S', '--force-run']);

  const gh2 = fakeGitHub({ files: { 'WaveDrop-Setup-1.2.0.exe': Buffer.from('setup') } });
  const broken = new Updater({
    repo: 'x/y', version: '1.0.1', packaged: true, enabled: () => true, openUrl() {}, quit() { throw new Error('must not quit'); },
    fetchImpl: gh2.fetchImpl, spawnImpl: fakeSpawn([], { fail: true }), platform: 'win32', env: {}, tmpDir: dir,
  });
  await broken.check();
  const v = await broken.update();
  assert.equal(v.status, 'available');
  assert.match(v.error, /Avvio/);
});

test('installs that cannot update themselves open the release page', async () => {
  const gh = fakeGitHub({ files: { 'WaveDrop-Setup-1.2.0.exe': Buffer.from('x') } });
  let opened = null;
  const u = new Updater({ repo: 'x/y', version: '1.0.1', packaged: false, enabled: () => true, openUrl: (u) => (opened = u), quit() {}, fetchImpl: gh.fetchImpl });
  await u.check();
  await u.update();
  assert.match(opened, /releases\/tag\/v1\.2\.0$/);
});
