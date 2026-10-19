'use strict';

// Updates from the project's GitHub releases. The latest release is compared
// with this version; its asset for this kind of install is downloaded, checked
// against the release's SHA256SUMS.txt, and installed:
//   Windows installer  the new Setup runs silently over this install, then relaunches
//   Windows portable   the new portable .exe is saved next to this one and started
//   Linux AppImage     the AppImage file is replaced and relaunched
//   anything else      (macOS, or running from source) the release page opens

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 15_000;

// "1.2.3" > "1.2.0"; pre-release suffixes are ignored.
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Which install this is, and which release asset replaces it.
function installKind({ packaged, platform = process.platform, env = process.env }) {
  if (!packaged) return { kind: 'source', asset: null };
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_FILE) return { kind: 'portable', asset: /-portable\.exe$/i };
  if (platform === 'win32') return { kind: 'installer', asset: /^WaveDrop-Setup-.*\.exe$/i };
  if (platform === 'linux' && env.APPIMAGE) return { kind: 'appimage', asset: /\.AppImage$/i };
  return { kind: 'other', asset: null };
}

// "<sha256>  <name>" lines → Map(name → hash)
function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.repo         "owner/name" on GitHub
   * @param {string} o.version      this app's version
   * @param {boolean} o.packaged    app.isPackaged
   * @param {() => boolean} o.enabled  whether to check by itself
   * @param {(url: string) => void} o.openUrl
   * @param {() => void} o.quit     called once the new version is starting
   */
  constructor({ repo, version, packaged, enabled, openUrl, quit, fetchImpl = fetch, spawnImpl = spawn, env = process.env, platform = process.platform, tmpDir = os.tmpdir() }) {
    super();
    this.repo = repo;
    this.version = version;
    this.enabled = enabled;
    this.openUrl = openUrl;
    this.quit = quit;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.tmpDir = tmpDir;
    this.env = env;
    this.platform = platform;
    this.install = installKind({ packaged, platform, env });
    this.state = { status: 'idle', version, latest: null, notes: '', url: `https://github.com/${repo}/releases`, progress: 0, error: '', checkedAt: 0 };
    this.release = null;
    this.file = null;
  }

  start() {
    this.timer = setTimeout(() => this.auto(), FIRST_CHECK_MS);
    this.interval = setInterval(() => this.auto(), CHECK_EVERY_MS);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }

  auto() {
    if (this.enabled() && ['idle', 'latest', 'error'].includes(this.state.status)) this.check();
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.view());
  }

  view() {
    return { ...this.state, kind: this.install.kind };
  }

  async _json(url) {
    const res = await this.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'WaveDrop-updater' } });
    if (!res.ok) throw new Error(`GitHub ha risposto ${res.status}`);
    return res.json();
  }

  async check() {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.view();
    this._set({ status: 'checking', error: '' });
    try {
      const r = await this._json(`https://api.github.com/repos/${this.repo}/releases/latest`);
      const latest = String(r.tag_name || '').replace(/^v/, '');
      this.release = r;
      const available = newer(latest, this.version);
      this._set({
        status: available ? 'available' : 'latest',
        latest,
        notes: String(r.body || '').slice(0, 4000),
        url: r.html_url || this.state.url,
        checkedAt: Date.now(),
      });
      if (available) this.emit('available', this.view());
    } catch (err) {
      this._set({ status: 'error', error: friendly(err), checkedAt: Date.now() });
    }
    return this.view();
  }

  // Download, verify and start the new version (or open the page when this
  // install cannot update itself).
  async update() {
    if (this.state.status !== 'available' || !this.release) return this.view();
    const asset = this.install.asset && (this.release.assets || []).find((a) => this.install.asset.test(a.name));
    if (!asset) {
      this.openUrl(this.state.url);
      return this.view();
    }
    try {
      const sumsAsset = (this.release.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
      if (!sumsAsset) throw new Error('La release non ha SHA256SUMS.txt: impossibile verificare il file.');
      const sums = parseSums(await (await this.fetch(sumsAsset.browser_download_url, { headers: { 'user-agent': 'WaveDrop-updater' } })).text());
      const expected = sums.get(asset.name);
      if (!expected) throw new Error(`SHA256SUMS.txt non elenca ${asset.name}.`);

      this._set({ status: 'downloading', progress: 0, error: '' });
      const dir = path.join(this.tmpDir, 'wavedrop-update');
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, asset.name);
      const hash = await this._download(asset.browser_download_url, file, asset.size);
      if (hash !== expected) {
        await fsp.rm(file, { force: true });
        throw new Error("Il file scaricato non corrisponde all'impronta della release: aggiornamento annullato.");
      }
      this.file = file;
      this._set({ status: 'installing', progress: 1 });
      await this._install(file, asset.name);
    } catch (err) {
      this._set({ status: 'available', error: friendly(err) });
    }
    return this.view();
  }

  async _download(url, file, size) {
    const res = await this.fetch(url, { headers: { 'user-agent': 'WaveDrop-updater' } });
    if (!res.ok || !res.body) throw new Error(`Download non riuscito (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (total && Date.now() - lastEmit > 200) {
          lastEmit = Date.now();
          this._set({ progress: got / total });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    return hash.digest('hex');
  }

  async _install(file, name) {
    // Resolves once the new version's process exists; errors reach update().
    const detached = (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = this.spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.once('error', (err) => reject(new Error(`Avvio della nuova versione non riuscito: ${err.message}`)));
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    switch (this.install.kind) {
      case 'installer':
        // electron-builder's NSIS: silent, over the current install, then start it.
        await detached(file, ['--updated', '/S', '--force-run']);
        break;
      case 'portable': {
        const dest = path.join(path.dirname(this.env.PORTABLE_EXECUTABLE_FILE), name);
        await fsp.copyFile(file, dest);
        await detached(dest, []);
        break;
      }
      case 'appimage': {
        const dest = this.env.APPIMAGE;
        const tmp = `${dest}.new`;
        await fsp.copyFile(file, tmp);
        await fsp.chmod(tmp, 0o755);
        await fsp.rename(tmp, dest); // the running image stays mounted
        await detached(dest, []);
        break;
      }
      default:
        return this.openUrl(this.state.url);
    }
    setTimeout(() => this.quit(), 800);
  }
}

function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return 'Nessuna connessione a GitHub.';
  return msg;
}

module.exports = { Updater, newer, installKind, parseSums };
