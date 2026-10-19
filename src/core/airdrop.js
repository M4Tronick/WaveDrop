'use strict';

// Optional bridge to Apple's AirDrop (Linux only).
//
// AirDrop runs over AWDL, a Wi-Fi link that needs a card in monitor mode with
// frame injection. WaveDrop cannot do that itself, and Windows, WSL, Android
// and iOS apps cannot do it at all. On Linux, omdrop-owl (the radio, through
// OWL) and omdrop-plugin (the `omdrop` command, its receiver and its sender)
// can, and this module drives their CLI:
//
//   omdrop status --json             {"receiving","visible","remaining","dir",...}
//   omdrop doctor --json             {"ready","missing":[{"id","say"}]}
//   omdrop on 10m | off --force      the visibility window (pkexec inside)
//   omdrop dir [PATH]                where the receiver stores files
//   omdrop peers --json -n --stream  one {"mac","rssi","name"} per line, per pass
//   omdrop send --to MAC FILE|URL…   "Asking them…", "They accepted…", "Sent …"
//   journalctl --user -u airdrop-receiver.service -f
//                                    "ask from NAME (MODEL): …", "upload ID: stored A, B"
//
// OpenDrop (`opendrop find | send | receive`) is the fallback backend, for a
// machine where OWL already runs by hand and awdl0 exists.
//
// The receiver accepts every transfer itself (Everyone mode has no prompt on
// this side). While WaveDrop holds the window open it points the receiver at
// WaveDrop's inbox, and puts the previous folder back afterwards.

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_WINDOW_MIN = 10;
const PEER_TTL_MS = 90_000;
const STATUS_POLL_MS = 5000;
const DISCOVER_PAUSE_MS = 3000;
const OPENDROP_FIND_MS = 12_000;
const SEND_WAIT_S = 30;
const ASK_MEMORY_MS = 5 * 60_000;
const MAX_CAPTURE = 64 * 1024;
const RECEIVER_UNIT = 'airdrop-receiver.service';
const SYS_NET = '/sys/class/net';
const AWDL_IFACES = new Set(['awdl0', 'mon0', 'awdlibss0', 'awdlap0', 'lo']);
const EXCLUSIVE_MODES = new Set(['exclusive', 'active-monitor']);
const PROFILE_TABLES = ['/etc/omdrop/owl-profiles', '/usr/lib/omdrop/owl-profiles'];
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const NO_NAME = new Set(['', '(no response)', '(anonymous)']);

const codeError = (code, message = code) => Object.assign(new Error(message), { code });

// ───────────── parsing (pure, unit-tested against sample outputs) ─────────────

// "2026-09-18 12:00:02,000 INFO send: +  2.10s ASK -> accepted (1.69s)" -> "ASK -> accepted (1.69s)"
function stripLogPrefix(line) {
  return String(line)
    .replace(/\r$/, '')
    .replace(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[,.]\d+)?\s+[A-Z]+\s+[\w.-]+:\s+/, '')
    .replace(/^\+\s*[\d.]+s\s+/, '')
    .trim();
}

// The last line of the output that parses as JSON: the CLI may print a
// warning or two before it.
function lastJson(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

// `omdrop status --json`
function parseStatus(text) {
  const o = lastJson(text);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return {
    receiving: o.receiving === true,
    visible: typeof o.visible === 'boolean' ? o.visible : null,
    remaining: Number.isInteger(o.remaining) && o.remaining >= 0 ? o.remaining : null,
    name: typeof o.name === 'string' && o.name ? o.name : null,
    dir: typeof o.dir === 'string' && o.dir.startsWith('/') ? o.dir : null,
    mode: ['off', 'timed', 'once', 'forever'].includes(o.mode) ? o.mode : 'off',
    reason: typeof o.reason === 'string' && o.reason ? o.reason : null,
    audience: o.visibility === 'contacts' ? 'contacts' : 'everyone',
  };
}

// `omdrop doctor --json`. "service" is installed by the first `omdrop on`,
// so it does not block.
const NON_BLOCKING = new Set(['service']);
function parseDoctor(text) {
  const o = lastJson(text);
  if (!o || typeof o !== 'object' || !Array.isArray(o.missing)) return null;
  const missing = o.missing
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({ id: m.id, say: typeof m.say === 'string' ? m.say : '' }));
  return { ready: o.ready === true, missing, blocking: missing.filter((m) => !NON_BLOCKING.has(m.id)) };
}

const DOCTOR_IT = {
  hardware: 'La scheda Wi-Fi di questo PC non è tra quelle che omdrop-owl sa usare.',
  backend: 'Il backend radio (omdrop-owl) va installato o aggiornato.',
  radio: 'La radio AirDrop non è pronta: Wi-Fi non connesso o su un canale che AirDrop non può condividere.',
  library: 'Mancano i pacchetti del ricevitore omdrop: esegui «omdrop install-driver» in un terminale.',
  driver: 'Manca il driver Wi-Fi che rende il PC visibile ai dispositivi Apple.',
};
function doctorMessage(item) {
  if (!item) return '';
  // "backend-<id>": the radio backend's own item, renamed so the plugin's button skips it.
  if (item.id.startsWith('backend-')) return DOCTOR_IT.backend;
  return DOCTOR_IT[item.id] || 'omdrop non è pronto: esegui «omdrop doctor» in un terminale per i dettagli.';
}

// One peer from `omdrop peers --json [--stream]` ({"mac","rssi","name"}) or
// from send-to-peer's table ("e2:9d:03:6c:58:23   -47 dBm  [fe80::…%awdl0]:8770  Name").
function parsePeerLine(line) {
  const s = String(line).trim();
  if (!s) return null;
  let mac;
  let rssi;
  let name;
  if (s.startsWith('{')) {
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      return null;
    }
    mac = typeof o.mac === 'string' ? o.mac.toLowerCase() : '';
    rssi = Number.isInteger(o.rssi) ? o.rssi : null;
    name = typeof o.name === 'string' ? o.name.trim() : '';
  } else {
    const m = s.match(/^((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+(-?\d+|\?) dBm\s+\S+\s*(.*)$/i);
    if (!m) return null;
    mac = m[1].toLowerCase();
    rssi = m[2] === '?' ? null : Number(m[2]);
    name = m[3].trim();
  }
  if (!MAC.test(mac)) return null;
  return { mac, rssi, name: NO_NAME.has(name) ? null : name.slice(0, 64) };
}

// A whole `omdrop peers` answer: a JSON array, JSON lines, or the table.
function parsePeers(text) {
  const s = String(text || '').trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s).map((p) => parsePeerLine(JSON.stringify(p))).filter(Boolean);
    } catch {}
  }
  return s.split('\n').map(parsePeerLine).filter(Boolean);
}

// One line of `omdrop send` (narrated, or the sender's raw log with
// --verbose) or of `opendrop send`, as an event.
function parseSendLine(line) {
  const s = stripLogPrefix(line);
  if (!s) return null;
  let m;
  // omdrop, narrated by its CLI
  if (s === 'Asking them to accept it...' || /; asking$/.test(s) || s === 'Asking receiver to accept ...') return { type: 'asking' };
  if (s === 'They accepted. Sending...' || /^ASK -> accepted\b/.test(s) || s === 'Receiver accepted') return { type: 'accepted' };
  if (s === 'They declined it.' || /^ASK -> declined\b/.test(s) || s === 'Receiver declined') return { type: 'declined' };
  if ((m = s.match(/^They never answered: (.*)$/)) || (m = s.match(/^ASK failed: (.*)$/))) return { type: 'unanswered', detail: m[1] };
  if ((m = s.match(/^UPLOAD (.+) -> ok \((.*)\)$/)) || (m = s.match(/^Sent (.+?) \(([^()]*)\)$/))) return { type: 'sent', name: m[1], detail: m[2] };
  if ((m = s.match(/^LINK (.+) -> ok$/)) || (m = s.match(/^Sent (https?:\/\/\S+)$/i))) return { type: 'sent', name: m[1], link: true };
  if (s === 'Uploading has been successful') return { type: 'sent', name: null };
  if (/^The transfer failed\b/.test(s) || /^UPLOAD failed: /.test(s) || /^UPLOAD .+ -> FAILED/.test(s) || s === 'Uploading has failed') {
    return { type: 'failed', detail: s.replace(/^The transfer failed:?\s*/, '') };
  }
  if (/Peers must be in "Everyone" mode/.test(s)) return { type: 'everyone-only' };
  if (/never opened \d+/.test(s) || /^It is not accepting files right now/.test(s)) return { type: 'unreachable' };
  if (s === 'Cancelled.') return { type: 'cancelled' };
  if (/^No (?:device (?:called|matching)|nearby Apple device)/.test(s) || /^Receiver does not exist/.test(s) || /^No discovery report exists/.test(s)) {
    return { type: 'not-found' };
  }
  if (/^Omdrop is off\b/.test(s) || /radio is not running/.test(s) || /radio is not up yet/.test(s)) return { type: 'radio-off' };
  if (/a folder cannot be sent/.test(s)) return { type: 'folder' };
  return null;
}

const FAILURE_REASON = {
  'everyone-only': 'AIRDROP_EVERYONE',
  unreachable: 'AIRDROP_UNREACHABLE',
  unanswered: 'AIRDROP_UNREACHABLE',
  'not-found': 'AIRDROP_NOT_FOUND',
  'radio-off': 'AIRDROP_OFF',
  folder: 'AIRDROP_FOLDER',
  failed: 'AIRDROP_FAILED',
};

// What a finished send amounts to, from its exit status and its events.
// omdrop exits 0 only when the device accepted; OpenDrop exits 0 either way,
// so a success also needs a line that says so.
function sendOutcome(code, events) {
  const has = (type) => events.some((e) => e.type === type);
  if (has('declined')) return { status: 'declined', reason: 'declined' };
  if (has('cancelled') || code === 130) return { status: 'cancelled', reason: null };
  for (const type of ['everyone-only', 'folder', 'radio-off', 'not-found', 'unreachable', 'unanswered', 'failed']) {
    if (has(type)) return { status: 'failed', reason: FAILURE_REASON[type] };
  }
  if (code === 0 && (has('sent') || has('accepted'))) return { status: 'done', reason: null };
  return { status: 'failed', reason: 'AIRDROP_FAILED' };
}

// One line of the omdrop receiver's log (journalctl -o cat).
function parseReceiverLine(line) {
  const s = stripLogPrefix(line);
  let m;
  if ((m = s.match(/^ask from (.*) \(([^()]*)\): type (.*?), (\d+) item\(s\)/))) {
    const unset = (v) => (v === 'None' || v === '' ? null : v);
    return { type: 'ask', sender: unset(m[1]), model: unset(m[2]), kind: m[3], count: Number(m[4]) };
  }
  if (/^ask REFUSED\b/.test(s)) return { type: 'refused' };
  if ((m = s.match(/^upload (\S+): stored (.+)$/))) return { type: 'stored', id: m[1], names: m[2].split(', ') };
  if ((m = s.match(/^link stored as (.+?) -> (https?:\/\/\S+)$/i))) return { type: 'link', name: m[1], url: m[2] };
  return null;
}

// The receiver joins stored names with ", ", and a name may hold one too:
// put the pieces back together where the joined name is the file on disk.
function resolveStored(dir, names, exists) {
  const out = [];
  let i = 0;
  while (i < names.length) {
    let found = false;
    for (let j = names.length; j > i; j--) {
      const candidate = path.posix.join(dir, names.slice(i, j).join(', '));
      if (exists(candidate)) {
        out.push(candidate);
        i = j;
        found = true;
        break;
      }
    }
    if (!found) i++;
  }
  return out;
}

// `opendrop find`: "Found  index 0  ID eccb2f2dcfe7  name John’s iPhone"
function parseOpenDropFind(line) {
  const m = stripLogPrefix(line).match(/^Found\s+index (\d+)\s+ID ([0-9a-f]{12})\s+name (.+)$/i);
  return m ? { index: Number(m[1]), id: m[2].toLowerCase(), name: m[3].trim().slice(0, 64) } : null;
}

// `opendrop receive`
function parseOpenDropReceive(line) {
  const s = stripLogPrefix(line);
  let m;
  if (/^Starting HTTPS server/.test(s)) return { type: 'listening' };
  if (/^Receiving file\(s\)/.test(s)) return { type: 'receiving' };
  if ((m = s.match(/^File\(s\) received \(size ([\d.]+) MB/))) return { type: 'received', size: Math.round(Number(m[1]) * 1024 * 1024) };
  return null;
}

// Names in `after` that are new or changed since `before` (name -> "size:mtime").
function newEntries(before, after) {
  return [...after.keys()].filter((name) => before.get(name) !== after.get(name)).sort();
}

// omdrop-owl's owl-profiles: "driver status mode mon_mac reconnect mt76_pm notes…"
function parseOwlProfiles(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    if (f.length < 6) continue;
    rows.push({ driver: f[0], status: f[1], mode: f[2] });
  }
  return rows;
}

// The profile omdrop-owl would pick for a driver: the first table that lists
// it, else the first "*" line (as omdrop-discoverable's load_profile does).
function owlProfileFor(driver, tables) {
  const all = tables.map(parseOwlProfiles);
  for (const rows of all) {
    const hit = rows.find((r) => r.driver === driver);
    if (hit) return hit;
  }
  for (const rows of all) {
    const any = rows.find((r) => r.driver === '*');
    if (any) return any;
  }
  return null;
}

const isWebUrl = (s) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(String(s).trim());

// ───────────── system helpers ─────────────

function which(name, env, home) {
  const dirs = [...String(env.PATH || '').split(':'), path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

// The Wi-Fi station's kernel driver, as omdrop-discoverable finds it.
function stationDriver() {
  let names = [];
  try {
    names = fs.readdirSync(SYS_NET);
  } catch {
    return null;
  }
  for (const name of names) {
    if (AWDL_IFACES.has(name) || !fs.existsSync(path.join(SYS_NET, name, 'phy80211'))) continue;
    try {
      return path.basename(fs.realpathSync(path.join(SYS_NET, name, 'device', 'driver')));
    } catch {}
  }
  return null;
}

function readTables(extraDir) {
  const files = [...PROFILE_TABLES];
  if (extraDir) files.push(path.join(extraDir, 'owl-profiles'));
  return files.map((f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  });
}

function listDir(dir) {
  const map = new Map();
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        map.set(name, `${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  } catch {}
  return map;
}

// Runs a command and hands each output line to onLine.
function runLines(bin, args, { env, cwd, timeout = 0, onLine, spawnImpl = spawn } = {}) {
  let child = null;
  const promise = new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    };
    try {
      child = spawnImpl(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      err = e.message;
      return finish(-1, null);
    }
    const follow = (stream, which) => {
      let buf = '';
      stream.on('data', (d) => {
        const s = d.toString('utf8');
        if (which === 'out') out = (out + s).slice(-MAX_CAPTURE);
        else err = (err + s).slice(-MAX_CAPTURE);
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (onLine) onLine(line, which);
        }
      });
      stream.on('end', () => {
        if (buf && onLine) onLine(buf, which);
        buf = '';
      });
    };
    follow(child.stdout, 'out');
    follow(child.stderr, 'err');
    child.on('error', (e) => {
      err += e.message;
      finish(-1, null);
    });
    child.on('close', finish);
    if (timeout) timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  });
  return {
    promise,
    kill(signal = 'SIGTERM') {
      try {
        child?.kill(signal);
      } catch {}
    },
  };
}

// Why `omdrop on` failed, in Italian; the CLI's own sentence goes to the log.
function onFailure(text) {
  const s = String(text || '');
  if (/not authori[sz]ed|polkit|pkexec|dismissed/i.test(s)) return 'Autorizzazione negata: serve il permesso di amministratore per accendere la radio AirDrop.';
  if (/Wi-Fi isn't connected|channel 6, 44 or 149/i.test(s)) return 'In modalità condivisa il Wi-Fi deve essere connesso a una rete sui canali 6, 44 o 149.';
  if (/receiver would not start/i.test(s)) return 'Il ricevitore AirDrop di omdrop non si è avviato: esegui «omdrop on» in un terminale per il motivo.';
  if (/still set up for the last window|Restarting the computer/i.test(s)) return 'Il Wi-Fi è rimasto configurato dalla finestra precedente: riavvia il PC.';
  return 'Non è stato possibile attivare AirDrop: esegui «omdrop on» in un terminale per il motivo.';
}

// ───────────── the bridge ─────────────

class AirDropBridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => string} o.inbox          WaveDrop's folder for received files
   * @param {() => string} o.name           the name Apple devices see (OpenDrop)
   * @param {{get: () => string, set: (v: string) => void}} [o.remember]
   *        where to keep the receiver's own folder while WaveDrop borrows it
   */
  constructor({ inbox, name, remember, platform = process.platform, env = process.env, home = os.homedir(), spawnImpl = spawn } = {}) {
    super();
    this.inbox = inbox;
    this.name = name || (() => os.hostname());
    this.remember = remember || { get: () => '', set: () => {} };
    this.platform = platform;
    this.home = home;
    this.env = { ...env, PATH: [env.PATH, path.join(home, '.local', 'bin')].filter(Boolean).join(':') };
    this.spawnImpl = spawnImpl;
    this.state = platform === 'linux' ? 'unknown' : 'unsupported'; // until refresh()
    this.detail = '';
    this.backend = null;
    this.bin = null;
    this.wifi = { driver: null, mode: null, owl: false };
    this.visibleUntil = null;
    this.shownName = null;
    this.dir = null;
    this.ownWindow = false;
    this.peers = new Map(); // id -> { id, name, rssi, target, seenAt }
    this.discovering = false;
    this.discoverProc = null;
    this.follower = null;
    this.receiver = null; // OpenDrop's `receive`
    this.sending = 0;
    this.lastAsk = null;
  }

  get available() {
    return !!this.backend;
  }

  view() {
    return {
      state: this.state,
      detail: this.detail,
      backend: this.backend,
      backendLabel: this.backend === 'opendrop' ? 'OpenDrop' : this.wifi.owl ? 'omdrop-owl' : this.backend ? 'omdrop' : null,
      name: this.shownName,
      visibleUntil: this.visibleUntil,
      driver: this.wifi.driver,
      exclusive: this.wifi.mode ? EXCLUSIVE_MODES.has(this.wifi.mode) : null,
      discovering: !!this.discoverProc,
    };
  }

  _set(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.emit('state', this.view());
  }

  _run(args, timeout = 15_000, extra = {}) {
    return runLines(this.bin, args, { env: this.env, timeout, spawnImpl: this.spawnImpl, ...extra });
  }

  // Finds a backend and reads its state. Cheap enough to call whenever the UI opens.
  refresh() {
    if (this.platform !== 'linux') {
      this._set('unsupported');
      return Promise.resolve(this.view());
    }
    if (['starting', 'stopping'].includes(this.state)) return Promise.resolve(this.view());
    if (!this._refreshing) this._refreshing = this._refresh().finally(() => (this._refreshing = null));
    return this._refreshing;
  }

  async _refresh() {
    const wanted = this.env.WAVEDROP_AIRDROP_BACKEND;
    const omdrop = wanted === 'opendrop' ? null : which('omdrop', this.env, this.home);
    const opendrop = wanted === 'omdrop' ? null : which('opendrop', this.env, this.home);
    this.backend = omdrop ? 'omdrop' : opendrop ? 'opendrop' : null;
    this.bin = omdrop || opendrop;
    this._readWifi();
    if (!this.backend) {
      this._set('missing', 'omdrop-owl non è installato: vedi il README di WaveDrop.');
      return this.view();
    }
    if (this.backend === 'opendrop') {
      if (this.receiver) this._set('visible');
      else if (!fs.existsSync(path.join(SYS_NET, 'awdl0'))) this._set('blocked', 'OpenDrop ha bisogno di OWL già avviato: l\'interfaccia awdl0 non c\'è.');
      else this._set('ready');
      return this.view();
    }
    const [doc, st] = await Promise.all([this._run(['doctor', '--json'], 20_000).promise, this._run(['status', '--json']).promise]);
    const doctor = parseDoctor(doc.out);
    if (!this._applyStatus(parseStatus(st.out))) {
      if (doctor && doctor.blocking.length) this._set('blocked', doctorMessage(doctor.blocking[0]));
      else this._set('ready');
      // Left borrowed by a run that never got to put it back (a crash).
      if (this.remember.get()) await this._restoreDir();
    }
    return this.view();
  }

  _readWifi() {
    const driver = stationDriver();
    const discoverable = which('omdrop-discoverable', this.env, this.home);
    const tables = readTables(discoverable && path.dirname(fs.realpathSync(discoverable))).filter((t) => t != null);
    const profile = driver && tables.length ? owlProfileFor(driver, tables) : null;
    this.wifi = { driver, mode: profile ? profile.mode : null, owl: tables.length > 0 };
  }

  // Returns true when the window is open.
  _applyStatus(st) {
    if (!st) return false;
    this.shownName = st.name;
    if (st.dir) this.dir = st.dir;
    if (st.visible && st.receiving) {
      this.visibleUntil = st.remaining != null ? Date.now() + st.remaining * 1000 : null;
      if (this.state !== 'visible') {
        this._set('visible');
        this._windowOpened();
      } else {
        this.emit('state', this.view());
      }
      return true;
    }
    if (this.state === 'visible') this._windowClosed();
    return false;
  }

  // ───── visibility ─────

  async setVisible(on, minutes = DEFAULT_WINDOW_MIN) {
    // Turned off while still coming up: finish starting, then stop.
    if (!on && this.state === 'starting') return (this.stopAfterStart = true);
    if (!this.backend || ['starting', 'stopping'].includes(this.state)) return false;
    if (on && this.state === 'visible') return true;
    if (!on && this.state !== 'visible') return true;
    if (on) {
      this._set('starting', 'Accensione della radio AirDrop…');
      this.stopAfterStart = false;
      this.ownWindow = true; // ours to close, even if the app quits mid-start
      try {
        if (this.backend === 'omdrop') await this._omdropOn(minutes);
        else await this._openDropOn(minutes);
      } catch (err) {
        console.warn('[airdrop] on:', err.raw || err.message);
        this.ownWindow = false;
        this.follower?.kill();
        this.follower = null;
        await this._restoreDir();
        this._set('error', err.message);
        return false;
      }
      if (this.stopAfterStart) return this.setVisible(false);
      return true;
    }
    this._set('stopping', 'Spegnimento della radio AirDrop…');
    this._stopDiscovery();
    if (this.backend === 'omdrop') {
      const r = await this._run(['off', '--force'], 60_000).promise;
      if (r.code !== 0) console.warn('[airdrop] off:', r.err.trim());
    } else {
      this.receiver?.kill('SIGINT');
    }
    this.state = 'ready';
    this._windowClosed();
    return true;
  }

  async _omdropOn(minutes) {
    const inbox = this.inbox();
    await fsp.mkdir(inbox, { recursive: true });
    await this._borrowDir(fs.realpathSync(inbox));
    this._followReceiver();
    const r = await this._run(['on', `${Math.max(1, Math.round(minutes))}m`], 180_000).promise;
    if (r.code !== 0) throw Object.assign(new Error(onFailure(`${r.err}\n${r.out}`)), { raw: r.err.trim() || r.out.trim() });
    const st = parseStatus((await this._run(['status', '--json']).promise).out);
    this.state = 'starting';
    if (!this._applyStatus(st)) throw new Error('omdrop si è acceso, ma la radio AirDrop non trasmette.');
  }

  // Points the receiver at WaveDrop's inbox, remembering where it pointed.
  async _borrowDir(inbox) {
    const cur = (await this._run(['dir']).promise).out.trim().split('\n').pop() || '';
    if (!cur || cur === inbox) return;
    const r = await this._run(['dir', inbox], 30_000).promise;
    if (r.code !== 0) {
      console.warn('[airdrop] dir:', r.err.trim());
      return; // files then land in omdrop's own folder, which is still reported
    }
    if (!this.remember.get()) this.remember.set(cur);
    this.dir = inbox;
  }

  async _restoreDir() {
    const prev = this.remember.get();
    if (!prev || this.backend !== 'omdrop') return;
    const r = await this._run(['dir', prev], 30_000).promise;
    if (r.code === 0) this.remember.set('');
    else console.warn('[airdrop] dir restore:', r.err.trim());
  }

  // The inbox moved while the window is open: follow it.
  async retarget() {
    if (this.backend === 'omdrop' && this.state === 'visible' && this.ownWindow) {
      const inbox = this.inbox();
      await fsp.mkdir(inbox, { recursive: true }).catch(() => {});
      await this._borrowDir(fs.realpathSync(inbox)).catch(() => {});
    }
  }

  async _openDropOn(minutes) {
    const inbox = this.inbox();
    await fsp.mkdir(inbox, { recursive: true });
    let snapshot = new Map();
    let listening;
    const ready = new Promise((resolve) => (listening = resolve));
    const run = runLines(this.bin, ['receive', '-n', this.name()], {
      env: this.env,
      cwd: inbox,
      spawnImpl: this.spawnImpl,
      onLine: (line) => {
        const ev = parseOpenDropReceive(line);
        if (!ev) return;
        if (ev.type === 'listening') listening(true);
        else if (ev.type === 'receiving') snapshot = listDir(inbox);
        else if (ev.type === 'received') {
          const names = newEntries(snapshot, listDir(inbox));
          if (names.length) this.emit('received', { sender: null, model: null, paths: names.map((n) => path.join(inbox, n)), links: [] });
        }
      },
    });
    this.receiver = run;
    run.promise.then((r) => {
      listening(false);
      this.receiver = null;
      if (r.code && r.code !== 130) console.warn('[airdrop] opendrop receive:', r.err.trim().split('\n').pop());
      if (this.state === 'visible') this._windowClosed();
    });
    const ok = await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 20_000, false))]);
    if (!ok) {
      run.kill('SIGTERM');
      throw new Error('OpenDrop non è partito: controlla che OWL sia avviato e che awdl0 esista.');
    }
    this.dir = inbox;
    this.visibleUntil = Date.now() + minutes * 60_000;
    clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => this.setVisible(false), minutes * 60_000);
    this._set('visible');
    this._windowOpened();
  }

  _windowOpened() {
    if (this.backend === 'omdrop') {
      this._followReceiver();
      clearInterval(this.poll);
      this.poll = setInterval(() => this._poll(), STATUS_POLL_MS);
    }
    this._discoverLoop();
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      this._applyStatus(parseStatus((await this._run(['status', '--json']).promise).out));
    } finally {
      this._polling = false;
    }
  }

  _windowClosed() {
    clearInterval(this.poll);
    clearTimeout(this.windowTimer);
    this.poll = null;
    this.visibleUntil = null;
    this._stopDiscovery();
    // A last log line may still be on its way.
    const follower = this.follower;
    this.follower = null;
    if (follower) setTimeout(() => follower.kill(), 3000).unref?.();
    if (this.peers.size) {
      this.peers.clear();
      this.emit('peers');
    }
    const own = this.ownWindow;
    this.ownWindow = false;
    if (own) this._restoreDir();
    if (['visible', 'stopping'].includes(this.state)) this._set('ready');
    else this.emit('state', this.view());
  }

  // ───── receiving ─────

  _followReceiver() {
    if (this.follower || this.backend !== 'omdrop') return;
    const run = runLines('journalctl', ['--user', '-u', RECEIVER_UNIT, '-f', '-n', '0', '-o', 'cat'], {
      env: this.env,
      spawnImpl: this.spawnImpl,
      onLine: (line, which) => which === 'out' && this._receiverLine(line),
    });
    this.follower = run;
    run.promise.then(() => {
      if (this.follower === run) this.follower = null;
    });
  }

  _receiverLine(line) {
    const ev = parseReceiverLine(line);
    if (!ev) return;
    const dir = this.dir || this.inbox();
    const asked = this.lastAsk && Date.now() - this.lastAsk.at < ASK_MEMORY_MS ? this.lastAsk : {};
    if (ev.type === 'ask') {
      this.lastAsk = { sender: ev.sender, model: ev.model, at: Date.now() };
    } else if (ev.type === 'stored') {
      const paths = resolveStored(dir, ev.names, (p) => fs.existsSync(p));
      if (paths.length) this.emit('received', { sender: asked.sender || null, model: asked.model || null, paths, links: [] });
    } else if (ev.type === 'link') {
      this.emit('received', { sender: asked.sender || null, model: asked.model || null, paths: [path.posix.join(dir, ev.name)], links: [ev.url] });
    }
  }

  // ───── discovery: only while someone is looking (the overlay is open) ─────

  setDiscovering(on) {
    this.discovering = !!on;
    if (this.discovering) this._discoverLoop();
    else this._stopDiscovery();
  }

  _discoverLoop() {
    clearTimeout(this.discoverTimer);
    if (this.discoverProc || !this.discovering || this.state !== 'visible' || this.sending) return;
    const opendrop = this.backend === 'opendrop';
    const run = this._run(opendrop ? ['find'] : ['peers', '--json', '-n', '--stream'], 0, {
      onLine: (line) => this._peerLine(line),
    });
    this.discoverProc = run;
    // `opendrop find` runs until Ctrl+C, and writes the list `send` reads only then.
    const stopFind = opendrop ? setTimeout(() => run.kill('SIGINT'), OPENDROP_FIND_MS) : null;
    this.emit('state', this.view());
    run.promise.then(() => {
      clearTimeout(stopFind);
      if (this.discoverProc === run) this.discoverProc = null;
      this._prunePeers();
      this.emit('state', this.view());
      if (this.discovering && this.state === 'visible') this.discoverTimer = setTimeout(() => this._discoverLoop(), DISCOVER_PAUSE_MS);
    });
  }

  _stopDiscovery() {
    clearTimeout(this.discoverTimer);
    // SIGINT lets `opendrop find` save its list; omdrop stops its probes on either.
    this.discoverProc?.kill(this.backend === 'opendrop' ? 'SIGINT' : 'SIGTERM');
  }

  _peerLine(line) {
    let peer = null;
    if (this.backend === 'opendrop') {
      const p = parseOpenDropFind(line);
      if (p) peer = { id: `airdrop:${p.id}`, name: p.name, rssi: null, target: p.id };
    } else {
      const p = parsePeerLine(line);
      if (p && p.name) peer = { id: `airdrop:${p.mac}`, name: p.name, rssi: p.rssi, target: p.mac };
    }
    if (!peer) return;
    const known = this.peers.get(peer.id);
    this.peers.set(peer.id, { ...peer, seenAt: Date.now() });
    if (!known || known.name !== peer.name || known.rssi !== peer.rssi) this.emit('peers');
  }

  _prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.seenAt > PEER_TTL_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('peers');
  }

  list() {
    return [...this.peers.values()].map(({ id, name, rssi }) => ({ id, name, rssi }));
  }

  get(id) {
    return this.peers.get(id) || null;
  }

  // ───── sending ─────

  /**
   * @param {{id: string, target: string}} peer   one of list()/get()
   * @param {{files: {abs: string, name: string}[], text?: string|null, signal?: AbortSignal, onEvent?: (ev: object) => void}} o
   * @returns {Promise<{status: 'done'|'declined'|'cancelled'|'failed', reason: string|null}>}
   */
  async send(peer, { files = [], text = null, signal, onEvent = () => {} } = {}) {
    const known = peer && this.peers.get(peer.id);
    if (!this.backend || !known) return { status: 'failed', reason: known ? 'AIRDROP_OFF' : 'AIRDROP_NOT_FOUND' };
    if (files.some((f) => f.name.includes('/'))) return { status: 'failed', reason: 'AIRDROP_FOLDER' };
    let paths = files.map((f) => f.abs);
    let urls = [];
    let tmp = null;
    if (!files.length && text) {
      if (isWebUrl(text)) urls = [text.trim()];
      else {
        // Plain text has no AirDrop form: it goes as a small text file.
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wavedrop-airdrop-'));
        const file = path.join(tmp, 'Testo da WaveDrop.txt');
        await fsp.writeFile(file, text);
        paths = [file];
      }
    }
    this.sending++;
    this._stopDiscovery();
    try {
      if (this.backend === 'omdrop') {
        return await this._sendOnce(['send', '--to', known.target, '--wait', String(SEND_WAIT_S), '--', ...urls, ...paths], signal, onEvent);
      }
      // OpenDrop sends one file or link per Ask.
      let result = { status: 'failed', reason: 'AIRDROP_FAILED' };
      for (const item of [...urls, ...paths]) {
        const isUrl = urls.includes(item);
        const args = ['send', '-r', known.target, '-f', item, ...(isUrl ? ['--url'] : [])];
        result = await this._sendOnce(args, signal, (ev) => onEvent(ev.type === 'sent' && !ev.name ? { ...ev, name: path.basename(item) } : ev));
        if (result.status !== 'done') break;
      }
      return result;
    } finally {
      this.sending--;
      if (tmp) fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (!this.sending) this._discoverLoop();
    }
  }

  async _sendOnce(args, signal, onEvent) {
    if (signal?.aborted) return { status: 'cancelled', reason: null };
    const events = [];
    const run = this._run(args, 0, {
      onLine: (line) => {
        const ev = parseSendLine(line);
        if (!ev) return;
        events.push(ev);
        onEvent(ev);
      },
    });
    const abort = () => run.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const r = await run.promise;
      if (signal?.aborted) return { status: 'cancelled', reason: null };
      const outcome = sendOutcome(r.code, events);
      if (outcome.status === 'failed') console.warn('[airdrop] send:', (r.err || r.out).trim().split('\n').pop());
      return outcome;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  // App quit: close what we opened, without waiting for it.
  shutdown() {
    clearInterval(this.poll);
    clearTimeout(this.windowTimer);
    clearTimeout(this.discoverTimer);
    this.discovering = false;
    this.discoverProc?.kill('SIGTERM');
    this.follower?.kill();
    this.receiver?.kill('SIGINT');
    if (this.backend !== 'omdrop' || !this.bin) return;
    const prev = this.remember.get();
    const off = this.ownWindow && ['visible', 'starting'].includes(this.state);
    if (!off && !prev) return;
    const script = `${off ? '"$0" off --force >/dev/null 2>&1; ' : ''}[ -z "$1" ] || "$0" dir "$1" >/dev/null 2>&1`;
    try {
      const child = this.spawnImpl('sh', ['-c', script, this.bin, prev || ''], { env: this.env, detached: true, stdio: 'ignore' });
      child.unref();
      if (prev) this.remember.set('');
    } catch {}
  }
}

module.exports = {
  AirDropBridge,
  DEFAULT_WINDOW_MIN,
  stripLogPrefix,
  parseStatus,
  parseDoctor,
  doctorMessage,
  parsePeerLine,
  parsePeers,
  parseSendLine,
  sendOutcome,
  parseReceiverLine,
  resolveStored,
  parseOpenDropFind,
  parseOpenDropReceive,
  newEntries,
  parseOwlProfiles,
  owlProfileFor,
  isWebUrl,
  onFailure,
  runLines,
  codeError,
};
