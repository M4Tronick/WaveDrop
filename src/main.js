'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
  nativeImage,
  nativeTheme,
  shell,
  dialog,
  clipboard,
  safeStorage,
  Notification,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const P = require('./shared/protocol');
const { Settings } = require('./core/settings');
const { loadIdentity, resetIdentity, Contacts, History } = require('./core/store');
const { Discovery } = require('./core/discovery');
const { TransferService, ACTIVE, call, describe } = require('./core/transfer');
const { MobileHub, lanAddress } = require('./core/mobile');
const { Ble, beaconHex } = require('./core/ble');
const { AirDropBridge } = require('./core/airdrop');
const { isInside, sanitizeRelPath } = require('./core/files');
const { Updater } = require('./core/updater');

// `--instance=2` runs a second, independent copy (own settings and identity)
// so two "devices" can be tried on one PC.
const instance = (process.argv.find((a) => a.startsWith('--instance=')) || '').split('=')[1];
if (instance) app.setPath('userData', `${app.getPath('userData')}-${instance}`);

const ASSETS = path.join(__dirname, '..', 'assets');
const BLE_EXE = path.join(ASSETS, 'ble-helper.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// A stable port keeps the phone's bookmarked web app working across restarts.
const AUTHOR = 'Matteo Davanzo';
const REPO_URL = repoUrl(require('../package.json').repository);
const PORT = 47480 + (instance ? Math.max(0, Number(instance) - 1) : 0);
const HOTKEYS =
  process.platform === 'darwin'
    ? ['Command+Shift+Option+D', 'Command+Control+D', 'Command+Shift+Option+Space']
    : ['Control+Alt+D', 'Control+Shift+Space', 'Alt+Shift+D', 'Control+Alt+W'];
const VISIBILITIES = ['everyone', 'contacts', 'off'];
const TOAST_WIDTH = 400;
const ISLAND_SIZES = {
  idle: { width: 170, height: 16 },
  hover: { width: 230, height: 40 },
  open: { width: 680, height: 250 },
};

let settings;
let identity;
let contacts;
let history;
let discovery;
let transfers;
let mobile;
let ble;
let airdrop = null; // Linux only: the bridge to Apple's AirDrop (core/airdrop.js)
let updater = null; // new versions from the GitHub releases (core/updater.js)
let tray;
let overlay;
let toast;
let island;
let settingsWin;
let overlayReady;
let dialogOpen = false;
let islandMode = 'idle';
let registeredHotkey = null;
const toasts = new Map(); // id -> { kind: 'incoming'|'outgoing'|'pairing'|'phone', timer, data }
const avatarCache = new Map(); // avatar hash -> data URL
const avatarFetching = new Set();
const proximity = new Map(); // "ip:port" -> { rssi, at } from Bluetooth
const probed = new Map(); // "ip:port" -> last /Hello probe
const airdropPaths = new Set(); // files the AirDrop bridge received

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => openOverlay(fileArgs(argv, cwd)));
  app.whenReady().then(init);
}

// ───────────── startup ─────────────

// package.json "repository" (string or { url }) as a browsable https URL.
function repoUrl(repo) {
  const url = String((repo && repo.url) || repo || '').replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\//.test(url) ? url : null;
}

async function init() {
  if (process.platform === 'win32') app.setAppUserModelId('app.wavedrop.desktop');
  app.setAboutPanelOptions({
    applicationName: 'WaveDrop',
    applicationVersion: app.getVersion(),
    copyright: `© 2026 ${AUTHOR} · Licenza MIT`,
    authors: [AUTHOR],
    ...(REPO_URL && { website: REPO_URL }),
    iconPath: path.join(ASSETS, 'icon.png'),
  });
  app.on('window-all-closed', () => {}); // lives in the tray

  const userData = app.getPath('userData');
  settings = new Settings(userData, instance ? { name: `${defaultDisplayName()} (${instance})` } : {});
  nativeTheme.themeSource = settings.get('theme');

  const keyProtection = safeStorage.isEncryptionAvailable()
    ? {
        protect: (buf) => safeStorage.encryptString(buf.toString('base64')),
        unprotect: (buf) => Buffer.from(safeStorage.decryptString(buf), 'base64'),
      }
    : {};
  identity = loadIdentity(userData, keyProtection);
  contacts = new Contacts(userData, identity);
  history = new History(userData);

  discovery = new Discovery(
    () => ({
      id: identity.id,
      pk: P.b64(identity.pk),
      name: settings.get('name'),
      platform: process.platform,
      port: transfers.port,
      visibility: settings.get('visibility'),
      avatar: settings.get('avatar'),
      color: settings.get('color'),
    }),
    contacts,
  );

  transfers = new TransferService({
    identity,
    contacts,
    profile: () => ({ name: settings.get('name'), platform: process.platform, color: settings.get('color') }),
    visibility: () => settings.get('visibility'),
    hello: () => discovery.hello(),
    avatarFile: () => (settings.get('avatar') ? avatarFile() : null),
    thumbnail: makeThumbnail,
    autoAccept: (contact) => settings.get('autoAcceptTrusted') && !!contact.trusted,
    defaultSaveDir: (entry) => saveDirFor(entry, settings.get('saveDir')),
    onFinished: (record) => {
      if (record.summary.pairOnly) return;
      history.add(record);
      broadcast('history', history.items);
    },
  });
  mobile = new MobileHub({
    service: transfers,
    identity,
    contacts,
    profile: () => ({ name: settings.get('name'), platform: process.platform }),
    webDir: path.join(__dirname, 'web'),
    iconFile: path.join(ASSETS, 'icon.png'),
  });
  await transfers.start(PORT);

  discovery.on('change', refreshPeers);
  discovery.on('error', (err) => console.error('[discovery]', err.message));
  discovery.start();
  mobile.on('change', refreshPeers);
  mobile.on('paired', (contact) => {
    showToast(`phone:${contact.id}`, 'phone', { name: contact.name }, 6000);
    broadcast('phone:paired', { id: contact.id, name: contact.name });
    contactsChanged();
  });

  transfers.on('pairing', onPairing);
  transfers.on('contacts', contactsChanged);
  transfers.on('incoming:new', (entry) => {
    toasts.set(entry.id, { kind: 'incoming' });
    pushToasts();
  });
  transfers.on('incoming:update', onIncomingUpdate);
  transfers.on('outgoing:update', onOutgoingUpdate);

  ble = new Ble(BLE_EXE);
  ble.on('state', () => {
    broadcast('settings', publicSettings());
    updateBeacon();
  });
  ble.on('seen', onBeacon);
  if (settings.get('bluetooth')) ble.start();
  updateBeacon();

  if (process.platform === 'linux') {
    airdrop = new AirDropBridge({
      inbox: () => settings.get('saveDir'),
      name: () => settings.get('name'),
      remember: { get: () => settings.get('airdropPrevDir') || '', set: (v) => settings.set({ airdropPrevDir: v }) },
    });
    transfers.airdrop = airdrop;
    airdrop.on('state', () => broadcast('settings', publicSettings()));
    airdrop.on('peers', refreshPeers);
    airdrop.on('received', (r) => onAirDropReceived(r).catch((err) => console.error('[airdrop]', err.message)));
    // Only detection here: becoming visible may take Wi-Fi down, so it waits for the user.
    if (airdropOn()) airdrop.refresh();
  }

  startUpdater();

  createOverlay();
  createToast();
  createIsland();
  createTray();
  registerHotkey(settings.get('hotkey'));

  const files = fileArgs(process.argv, process.cwd());
  if (!process.argv.includes('--hidden') || files.length) openOverlay(files);
}

app.on('before-quit', () => {
  updater?.stop();
  transfers?.stop();
  discovery?.stop();
  ble?.stop();
  airdrop?.shutdown();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

// ───────────── updates ─────────────

function startUpdater() {
  const repo = REPO_URL && REPO_URL.replace(/^https:\/\/github\.com\//, '');
  if (!repo) return;
  updater = new Updater({
    repo,
    // WAVEDROP_PRETEND_VERSION lets a test build believe it is older.
    version: process.env.WAVEDROP_PRETEND_VERSION || app.getVersion(),
    packaged: app.isPackaged,
    enabled: () => settings.get('autoUpdate'),
    openUrl: (url) => shell.openExternal(url),
    quit: () => app.quit(),
  });
  updater.on('change', (v) => {
    broadcast('update', v);
    refreshTrayMenu();
  });
  updater.on('available', notifyUpdate);
  updater.start();
}

// One system notification per new version; the tray and Settings keep offering it.
function notifyUpdate(v) {
  if (settings.get('notifiedUpdate') === v.latest || !Notification.isSupported()) return;
  settings.set({ notifiedUpdate: v.latest });
  const n = new Notification({
    title: `WaveDrop ${v.latest} è disponibile`,
    body: 'Clicca per vedere le novità e aggiornare.',
    icon: path.join(ASSETS, 'icon.png'),
  });
  n.on('click', () => openSettings('informazioni'));
  n.show();
}

function defaultDisplayName() {
  const user = (os.userInfo().username || 'Utente').replace(/[._-]+/g, ' ').trim();
  return user.charAt(0).toUpperCase() + user.slice(1);
}

function fileArgs(argv, cwd) {
  const appPath = path.resolve(app.getAppPath());
  return argv
    .slice(1)
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => path.resolve(cwd, a))
    .filter((p) => p !== appPath && fs.existsSync(p));
}

async function makeThumbnail(file) {
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500, null));
  const img = await Promise.race([nativeImage.createThumbnailFromPath(file, { width: 192, height: 192 }), timeout]);
  if (!img || img.isEmpty()) return null;
  return `data:image/png;base64,${img.toPNG().toString('base64')}`;
}

function saveDirFor(entry, base) {
  if (!settings.get('senderFolders')) return base;
  return path.join(base, sanitizeRelPath(entry.contact.name).replace(/\//g, ' '));
}

// ───────────── avatar ─────────────

const avatarFile = () => path.join(app.getPath('userData'), 'avatar.jpg');

function selfAvatarUrl() {
  if (!settings.get('avatar')) return null;
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(avatarFile()).toString('base64')}`;
  } catch {
    return null;
  }
}

function setAvatarFrom(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error('Immagine non leggibile');
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const jpeg = square.resize({ width: 256, height: 256, quality: 'best' }).toJPEG(85);
  fs.writeFileSync(avatarFile(), jpeg);
  applySettings({ avatar: crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 12) });
}

async function fetchAvatar(peer) {
  if (!peer.avatar || avatarCache.has(peer.avatar) || avatarFetching.has(peer.avatar) || peer.transport === 'mobile') return;
  avatarFetching.add(peer.avatar);
  try {
    const res = await call(peer, 'GET', '/Avatar', { timeout: 4000 });
    if (res.status === 200 && res.raw.length < 300_000) {
      const url = `data:image/jpeg;base64,${res.raw.toString('base64')}`;
      avatarCache.set(peer.avatar, url);
      if (contacts.get(peer.id)) contacts.touch(peer.id, { avatarHash: peer.avatar, avatarData: url });
      refreshPeers();
    }
  } catch {
    // Offline or no avatar: the monogram stays.
  } finally {
    avatarFetching.delete(peer.avatar);
  }
}

// ───────────── peers ─────────────

const airdropOn = () => !!airdrop && settings.get('airdrop') === true;

function findPeer(id) {
  const lan = discovery.get(id);
  if (lan) return lan;
  const phone = mobile.list().find((p) => p.id === id);
  if (phone) return { ...phone, transport: 'mobile' };
  const apple = airdropOn() ? airdrop.get(id) : null;
  return apple ? { ...apple, transport: 'airdrop' } : null;
}

// What an Apple device's name suggests it is; AirDrop tells us nothing else.
function appleKind(name) {
  return /iphone|ipad|ipod/i.test(name || '') ? { platform: 'ios', kind: 'phone' } : { platform: 'darwin', kind: 'pc' };
}

function nameColor(name) {
  return crypto.createHash('sha256').update(String(name)).digest()[0] % 8;
}

function airdropViews() {
  if (!airdropOn()) return [];
  return airdrop.list().map((p) => ({
    id: p.id,
    name: p.name,
    ...appleKind(p.name),
    transport: 'airdrop',
    contact: false,
    trusted: false,
    color: nameColor(p.name),
    avatarUrl: null,
    rssi: p.rssi,
  }));
}

function peerViews() {
  const views = [...discovery.list(), ...mobile.list()].map((p) => {
    const c = contacts.get(p.id);
    const near = p.address ? proximity.get(`${p.address}:${p.port}`) : null;
    return {
      id: p.id,
      name: (c && c.nickname) || p.name,
      platform: p.platform,
      kind: p.kind || 'pc',
      transport: p.transport || 'lan',
      contact: !!c,
      trusted: !!(c && c.trusted),
      color: Number.isInteger(p.color) ? p.color : (c && c.color) || 0,
      avatarUrl: (p.avatar && avatarCache.get(p.avatar)) || (c && c.avatarData) || null,
      rssi: near && Date.now() - near.at < 15000 ? near.rssi : null,
    };
  });
  views.push(...airdropViews());
  // Closest first when Bluetooth knows, then contacts, then by name.
  return views.sort(
    (a, b) =>
      (b.rssi ?? -999) - (a.rssi ?? -999) || Number(b.contact) - Number(a.contact) || a.name.localeCompare(b.name),
  );
}

function refreshPeers() {
  for (const p of discovery.list()) fetchAvatar(p);
  broadcast('peers', peerViews());
}

function contactsChanged() {
  broadcast('contacts', contactViews());
  refreshPeers();
}

function contactViews() {
  return contacts.list().map((c) => ({
    id: c.id,
    name: c.name,
    nickname: c.nickname || '',
    platform: c.platform,
    kind: c.kind,
    trusted: !!c.trusted,
    color: c.color || 0,
    avatarUrl: c.avatarData || null,
    pairedAt: c.pairedAt,
    lastSeen: c.lastSeen,
    safety: P.safetyCode(P.unb64(c.pk)),
    online: !!findPeer(c.id),
  }));
}

// ───────────── Bluetooth ─────────────

function updateBeacon() {
  if (!ble || !transfers?.port) return;
  const vis = settings.get('visibility');
  ble.setAdvert(vis === 'off' ? null : beaconHex(lanAddress(), transfers.port, vis === 'contacts' ? 1 : 0));
}

async function onBeacon({ ip, port, rssi }) {
  const key = `${ip}:${port}`;
  if (port === transfers.port && lanAddress() === ip) return; // ourselves
  proximity.set(key, { rssi, at: Date.now() });
  if (Date.now() - (probed.get(key) || 0) < 4000) return;
  probed.set(key, Date.now());
  try {
    const res = await call({ address: ip, port }, 'GET', '/Hello', { timeout: 2500 });
    if (res.status === 200) discovery.ingest(res.body, ip);
  } catch {
    // Not reachable over the network: nothing we can send to.
  }
}

// ───────────── windows ─────────────

function makeWindow(file, options = {}) {
  const { webPreferences, ...rest } = options;
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(ASSETS, 'icon.png'),
    ...rest,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      ...webPreferences,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  guardNavigation(win);
  win.loadFile(path.join(__dirname, 'renderer', file));
  return win;
}

function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createOverlay() {
  overlay = makeWindow('overlay.html', { movable: false });
  overlayReady = new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
  overlay.on('blur', () => {
    if (!dialogOpen && overlay.isVisible()) overlay.webContents.send('overlay:close');
  });
}

function createToast() {
  toast = makeWindow('toast.html', {
    width: TOAST_WIDTH,
    height: 120,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required' },
  });
}

function createIsland() {
  island = makeWindow('island.html', { ...ISLAND_SIZES.idle, focusable: false });
  island.webContents.once('did-finish-load', () => {
    placeIsland('idle');
    if (settings.get('island')) island.showInactive();
  });
}

function openSettings(section = 'profilo') {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:section', section);
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 780,
    minHeight: 520,
    title: 'Impostazioni di WaveDrop',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  settingsWin.removeMenu();
  guardNavigation(settingsWin);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { hash: section });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function placeIsland(mode) {
  islandMode = mode;
  const { width, height } = ISLAND_SIZES[mode];
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.round(wa.x + (wa.width - width) / 2);
  island.setBounds({ x, y: wa.y, width, height });
  // Windows enforces a minimum window height (~38px) that is taller than the
  // idle pill. Push the surplus above the screen edge so that only the pill
  // itself covers (and catches clicks on) the top of the screen.
  const actual = island.getBounds();
  const lift = Math.max(0, actual.height - height);
  if (lift) island.setBounds({ x, y: wa.y - lift, width, height: actual.height });
  island.webContents.send('island:mode', { mode, lift });
}

async function captureBackdrop(display) {
  try {
    const { width, height } = display.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width / 2), height: Math.round(height / 2) },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return `data:image/jpeg;base64,${src.thumbnail.toJPEG(80).toString('base64')}`;
  } catch {
    return null;
  }
}

async function openOverlay(files = []) {
  await overlayReady;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = overlay.isVisible();
  if (!wasVisible) {
    island.hide();
    overlay.setBounds(display.bounds);
  }
  const backdrop = wasVisible ? null : await captureBackdrop(display);
  overlay.webContents.send('overlay:open', { backdrop, files, ...snapshot() });
  if (!wasVisible) {
    overlay.show();
    overlay.setBounds(display.bounds); // re-apply: Windows may rescale on show across mixed-DPI monitors
  }
  overlay.focus();
  overlay.moveTop();
  discovery.query();
  if (airdropOn()) {
    airdrop.setDiscovering(true);
    airdrop.refresh();
  }
  // Results of sends started in the overlay belong to the overlay while it is up.
  for (const [id, t] of toasts) if (t.kind === 'outgoing') dropToast(id);
}

function toggleOverlay() {
  if (overlay.isVisible()) overlay.webContents.send('overlay:close');
  else openOverlay();
}

function hideOverlay() {
  overlay.hide();
  airdrop?.setDiscovering(false);
  if (settings.get('island')) island.showInactive();
}

// ───────────── state fan-out ─────────────

function selfView() {
  return {
    id: identity.id,
    name: settings.get('name'),
    color: settings.get('color'),
    avatarUrl: selfAvatarUrl(),
    platform: process.platform,
    safety: P.safetyCode(identity.pk),
  };
}

function loginOptions() {
  return app.isPackaged ? { args: ['--hidden'] } : { path: process.execPath, args: [app.getAppPath(), '--hidden'] };
}

const sendToLink = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'WaveDrop.lnk');

function publicSettings() {
  return {
    ...settings.data,
    self: selfView(),
    hotkeys: HOTKEYS,
    hotkeyOk: registeredHotkey === settings.get('hotkey'),
    loginItem: app.getLoginItemSettings(loginOptions()).openAtLogin,
    sendTo: process.platform === 'win32' ? fs.existsSync(sendToLink()) : null,
    bluetoothState: ble ? ble.state : 'off',
    bluetoothDetail: ble ? ble.detail : '',
    address: `${lanAddress()}:${transfers.port}`,
    platform: process.platform,
    instance: instance || null,
    airdrop: airdropOn(),
    airdropBridge: airdrop ? airdrop.view() : null, // null: not Linux, the UI hides it
  };
}

function snapshot() {
  return { peers: peerViews(), outgoing: transfers.listOutgoing(), settings: publicSettings() };
}

function broadcast(channel, data) {
  for (const win of [overlay, toast, island, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }
}

// ───────────── toasts ─────────────

function onPairing(p) {
  if (p.status === 'waiting') toasts.set(p.id, { kind: 'pairing' });
  else if (toasts.has(p.id)) scheduleDrop(p.id, p.status === 'done' ? 2500 : 5000);
  if (p.status === 'done') contactsChanged();
  pushToasts();
}

function onIncomingUpdate(entry) {
  pushIslandActivity(ACTIVE.has(entry.status) ? null : entry.status);
  if (entry.status === 'done' && !entry.afterDone) {
    entry.afterDone = true;
    afterReceive(entry);
  }
  if (!toasts.has(entry.id)) return;
  if (!ACTIVE.has(entry.status)) {
    const linger = { done: entry.text ? 60000 : 15000, declined: 1500, 'cancelled-local': 2500 }[entry.status] || 6000;
    scheduleDrop(entry.id, linger);
  }
  pushToasts();
}

function afterReceive(entry) {
  afterReceiveView(transfers.viewIncoming(entry));
}

function afterReceiveView(view) {
  if (!view.paths.length) return;
  const action = settings.get('afterReceive');
  if (action === 'reveal') shell.showItemInFolder(view.reveal);
  if (action === 'open') {
    if (view.items === 1 && !view.isFolder) shell.openPath(view.paths[0]);
    else shell.showItemInFolder(view.reveal);
  }
}

// The bridge's receiver has already accepted and stored it (AirDrop's
// Everyone mode asks nothing on this side): report it like any arrival.
async function onAirDropReceived({ sender, paths, links }) {
  const name = sender || 'Dispositivo Apple';
  const link = links[0] || null;
  const files = paths.map((p) => {
    airdropPaths.add(path.resolve(p));
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    return { name: path.basename(p), size };
  });
  const summary = link ? describe([], link) : describe(files, null);
  const totalSize = link ? 0 : files.reduce((n, f) => n + f.size, 0);
  const { platform, kind } = appleKind(name);
  const thumbnail = !link && files.length === 1 ? await makeThumbnail(paths[0]).catch(() => null) : null;
  const view = {
    id: `airdrop:${crypto.randomUUID()}`,
    status: 'done',
    via: 'airdrop',
    sender: { id: null, name, platform, kind, trusted: false, color: nameColor(name), avatarUrl: null },
    ...summary,
    text: link,
    totalSize,
    received: totalSize,
    progress: 1,
    thumbnail,
    paths,
    reveal: paths[0] || null,
    auto: true,
    error: null,
  };
  history.add({ direction: 'in', peer: name, platform, via: 'airdrop', summary, size: totalSize, status: 'done', text: link, reveal: view.reveal });
  broadcast('history', history.items);
  showToast(view.id, 'incoming', view, link ? 60000 : 15000);
  if (!link) afterReceiveView(view);
}

// What the idle island shows: a thin progress line while files move, and a
// short flash when a transfer ends (green done, red failed; nothing for a
// decline or a cancel, which the user already knows about).
function pushIslandActivity(ended) {
  if (!island || island.isDestroyed()) return;
  let done = 0;
  let total = 0;
  let count = 0;
  for (const t of transfers.outgoing.values()) {
    if (t.status === 'sending') {
      count++;
      done += t.sent || 0;
      total += t.total || 0;
    }
  }
  for (const e of transfers.incoming.values()) {
    if (e.status === 'receiving') {
      count++;
      done += e.received || 0;
      total += e.totalSize || 0;
    }
  }
  const flash = ended === 'done' ? 'ok' : ended && !/declined|cancel/.test(ended) ? 'bad' : null;
  island.webContents.send('island:activity', { active: count > 0, progress: total ? done / total : 0, flash });
}

function onOutgoingUpdate(t) {
  broadcast('outgoing', transfers.listOutgoing());
  pushIslandActivity(ACTIVE.has(t.status) ? null : t.status);
  // The code has to be typed somewhere: bring the overlay up for it.
  if (t.status === 'pairing' && !overlay.isVisible()) openOverlay();
  // While the overlay is hidden, sends (e.g. dropped on the island) report through toasts.
  if (!overlay.isVisible() && !toasts.has(t.id) && t.status !== 'pairing') toasts.set(t.id, { kind: 'outgoing' });
  if (toasts.has(t.id)) {
    if (!ACTIVE.has(t.status)) scheduleDrop(t.id, t.status === 'done' ? 5000 : 7000);
    pushToasts();
  }
}

function showToast(id, kind, data, ms) {
  toasts.set(id, { kind, data });
  scheduleDrop(id, ms);
  pushToasts();
}

function scheduleDrop(id, ms) {
  const t = toasts.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => dropToast(id), ms);
}

function dropToast(id) {
  const t = toasts.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  toasts.delete(id);
  pushToasts();
}

function pushToasts() {
  const items = [];
  for (const [id, { kind, data }] of toasts) {
    if (kind === 'incoming') {
      const e = transfers.incoming.get(id);
      if (e) items.push({ kind, ...transfers.viewIncoming(e) });
      else if (data) items.push({ kind, ...data }); // AirDrop: already stored, nothing to track
    } else if (kind === 'outgoing') {
      const o = transfers.outgoing.get(id);
      if (o) items.push({ kind, ...transfers.viewOutgoing(o) });
    } else if (kind === 'pairing') {
      const p = transfers.pairings.get(id);
      if (p) items.push({ kind, ...transfers.viewPairing(p) });
    } else {
      items.push({ kind, id, ...data });
    }
  }
  toast.webContents.send('toasts', { items, sound: settings.get('sound') });
}

// ───────────── settings ─────────────

function registerHotkey(accelerator) {
  if (instance) return; // extra test instances leave the shortcut to the main one
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
  try {
    if (globalShortcut.register(accelerator, toggleOverlay)) registeredHotkey = accelerator;
  } catch {}
  if (!registeredHotkey) console.warn(`[hotkey] ${accelerator} non disponibile`);
}

function setSendTo(on) {
  if (process.platform !== 'win32') return;
  if (on) {
    shell.writeShortcutLink(sendToLink(), 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      description: 'Invia con WaveDrop',
      icon: process.execPath,
      iconIndex: 0,
    });
  } else {
    fs.rmSync(sendToLink(), { force: true });
  }
}

function cleanPatch(patch = {}) {
  const out = {};
  const bool = (k) => {
    if (typeof patch[k] === 'boolean') out[k] = patch[k];
  };
  if (typeof patch.name === 'string' && patch.name.trim()) out.name = patch.name.trim().slice(0, 40);
  if (VISIBILITIES.includes(patch.visibility)) out.visibility = patch.visibility;
  if (['none', 'reveal', 'open'].includes(patch.afterReceive)) out.afterReceive = patch.afterReceive;
  if (['system', 'light', 'dark'].includes(patch.theme)) out.theme = patch.theme;
  if (HOTKEYS.includes(patch.hotkey)) out.hotkey = patch.hotkey;
  if (Number.isInteger(patch.color) && patch.color >= 0 && patch.color < 8) out.color = patch.color;
  ['askWhere', 'senderFolders', 'autoAcceptTrusted', 'sound', 'island', 'bluetooth', 'loginItem', 'sendTo', 'autoUpdate'].forEach(bool);
  if (airdrop) bool('airdrop');
  return out;
}

async function setAirDrop(on) {
  if (on) {
    await airdrop.refresh();
    airdrop.setDiscovering(overlay.isVisible());
    // Turning the bridge on is asking to be seen: open a window now.
    if (airdrop.state === 'ready') airdrop.setVisible(true);
  } else {
    for (const t of transfers.outgoing.values()) if (t.transport === 'airdrop') transfers.cancelOutgoing(t.id);
    airdrop.setDiscovering(false);
    await airdrop.setVisible(false);
  }
  refreshPeers();
}

function applySettings(patch) {
  const before = { ...settings.data };
  const { loginItem, sendTo, ...stored } = patch;
  settings.set(stored);
  if (loginItem !== undefined) app.setLoginItemSettings({ openAtLogin: loginItem, ...loginOptions() });
  if (sendTo !== undefined) setSendTo(sendTo);

  if (stored.visibility && stored.visibility !== before.visibility) {
    if (before.visibility === 'everyone') discovery.bye();
    discovery.announce();
    updateBeacon();
  } else if (['name', 'color', 'avatar'].some((k) => k in stored)) {
    discovery.announce();
  }
  if ('island' in stored) {
    if (stored.island && !overlay.isVisible()) island.showInactive();
    else island.hide();
  }
  if ('bluetooth' in stored) {
    if (stored.bluetooth) ble.start();
    else ble.stop();
  }
  if ('airdrop' in stored && stored.airdrop !== !!before.airdrop) setAirDrop(stored.airdrop).catch((err) => console.error('[airdrop]', err.message));
  if (stored.saveDir && airdropOn()) airdrop.retarget();
  if (stored.theme) nativeTheme.themeSource = stored.theme;
  if (stored.hotkey && stored.hotkey !== before.hotkey) registerHotkey(stored.hotkey);
  broadcast('settings', publicSettings());
  refreshTrayMenu();
}

async function withDialog(fn) {
  dialogOpen = true;
  try {
    return await fn();
  } finally {
    dialogOpen = false;
  }
}

async function chooseSaveDir(parent) {
  const r = await withDialog(() =>
    dialog.showOpenDialog(parent, {
      title: 'Cartella per i file ricevuti',
      defaultPath: settings.get('saveDir'),
      properties: ['openDirectory', 'createDirectory'],
    }),
  );
  if (!r.canceled && r.filePaths[0]) applySettings({ saveDir: r.filePaths[0] });
}

function openSaveDir() {
  fs.mkdirSync(settings.get('saveDir'), { recursive: true });
  shell.openPath(settings.get('saveDir'));
}

async function pickFilesThenOpen() {
  const r = await withDialog(() => dialog.showOpenDialog({ title: 'Scegli cosa inviare', properties: ['openFile', 'multiSelections'] }));
  if (!r.canceled && r.filePaths.length) openOverlay(r.filePaths);
}

async function phoneLink() {
  const { url, expires } = mobile.newPairingLink();
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { url, expires, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
}

// ───────────── tray ─────────────

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('WaveDrop');
  tray.on('click', toggleOverlay);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const visibility = settings.get('visibility');
  const vis = (value, label) => ({
    label,
    type: 'radio',
    checked: visibility === value,
    click: () => applySettings({ visibility: value }),
  });
  tray.setToolTip(`WaveDrop — ${settings.get('hotkey').replace('Control', 'Ctrl')}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Apri WaveDrop', accelerator: registeredHotkey || undefined, click: () => openOverlay() },
      { label: 'Invia file…', click: pickFilesThenOpen },
      { label: 'Collega un telefono…', click: () => openSettings('telefono') },
      { type: 'separator' },
      { label: 'Rilevabile da', submenu: [vis('everyone', 'Tutti'), vis('contacts', 'Solo contatti'), vis('off', 'Ricezione disattivata')] },
      { label: 'Apri cartella ricevuti', click: openSaveDir },
      { label: 'Impostazioni…', click: () => openSettings() },
      { label: 'Informazioni su WaveDrop', click: () => openSettings('informazioni') },
      ...(updater && ['available', 'downloading', 'installing'].includes(updater.state.status)
        ? [{ label: `Aggiorna a WaveDrop ${updater.state.latest}…`, click: () => openSettings('informazioni') }]
        : []),
      { type: 'separator' },
      { label: 'Esci', click: () => app.quit() },
    ]),
  );
}

// ───────────── IPC: sending ─────────────

function validPaths(paths) {
  // Only absolute paths that exist: an empty or relative one would resolve
  // against the working directory and share it by accident.
  return Array.isArray(paths) ? paths.map(String).filter((p) => path.isAbsolute(p) && fs.existsSync(p)) : [];
}

ipcMain.handle('snapshot', () => snapshot());

ipcMain.handle('send', (_e, peerId, paths) => {
  const peer = findPeer(peerId);
  const files = validPaths(paths);
  if (!peer || !files.length) return false;
  transfers.send(peer, { paths: files });
  return true;
});

ipcMain.handle('send-text', (_e, peerId, text) => {
  const peer = findPeer(peerId);
  const value = typeof text === 'string' ? text : clipboard.readText();
  if (!peer || !value.trim()) return false;
  transfers.send(peer, { text: value.slice(0, 100_000) });
  return true;
});

async function pickAndSend(win, peerId, folder = false) {
  const r = await withDialog(() =>
    dialog.showOpenDialog(win, {
      title: folder ? 'Scegli una cartella da inviare' : 'Scegli cosa inviare',
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    }),
  );
  if (overlay.isVisible()) overlay.focus();
  const peer = findPeer(peerId);
  if (!r.canceled && r.filePaths.length && peer) transfers.send(peer, { paths: r.filePaths });
}

ipcMain.handle('pick-and-send', (e, peerId) => pickAndSend(BrowserWindow.fromWebContents(e.sender), peerId));

ipcMain.handle('peer:menu', (e, peerId) => {
  const peer = findPeer(peerId);
  if (!peer) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  const contact = contacts.get(peerId);
  const clip = clipboard.readText().trim();
  const preview = clip.length > 32 ? `${clip.slice(0, 32)}…` : clip;
  if (peer.transport === 'airdrop') {
    // AirDrop via omdrop takes files and web links; no folders, no contacts.
    const template = [
      { label: 'Invia file…', click: () => pickAndSend(win, peerId) },
      {
        label: clip ? `Invia appunti: «${preview}»` : 'Invia appunti (vuoti)',
        enabled: !!clip,
        click: () => transfers.send(peer, { text: clip }),
      },
      { type: 'separator' },
      { label: 'Dispositivo Apple via AirDrop', enabled: false },
      { label: 'Le cartelle non si possono inviare via AirDrop', enabled: false },
    ];
    dialogOpen = true;
    return Menu.buildFromTemplate(template).popup({ window: win, callback: () => (dialogOpen = false) });
  }
  const template = [
    { label: 'Invia file…', click: () => pickAndSend(win, peerId) },
    { label: 'Invia una cartella…', click: () => pickAndSend(win, peerId, true) },
    { label: clip ? `Invia appunti: «${preview}»` : 'Invia appunti (vuoti)', enabled: !!clip, click: () => transfers.send(peer, { text: clip }) },
    { type: 'separator' },
  ];
  if (contact) {
    template.push(
      {
        label: 'Contatto attendibile (accetta sempre)',
        type: 'checkbox',
        checked: !!contact.trusted,
        click: (item) => {
          contacts.update(peerId, { trusted: item.checked });
          contactsChanged();
        },
      },
      { label: 'Codice di sicurezza: ' + P.safetyCode(P.unb64(contact.pk)), enabled: false },
      {
        label: 'Dimentica questo dispositivo',
        click: () => {
          contacts.remove(peerId);
          contactsChanged();
        },
      },
    );
  } else if (peer.transport !== 'mobile') {
    template.push({ label: 'Abbina senza inviare…', click: () => transfers.send(peer, { pairOnly: true }) });
  }
  dialogOpen = true;
  Menu.buildFromTemplate(template).popup({ window: win, callback: () => (dialogOpen = false) });
});

ipcMain.handle('cancel', (_e, id) => transfers.cancelOutgoing(id));
ipcMain.handle('pair:code', (_e, transferId, code) => transfers.submitCode(transferId, code));
ipcMain.handle('pair:peer', (_e, peerId) => {
  const peer = findPeer(peerId);
  if (peer) transfers.send(peer, { pairOnly: true });
});

// ───────────── IPC: receiving ─────────────

ipcMain.handle('respond', async (_e, id, accept, opts = {}) => {
  const entry = transfers.incoming.get(id);
  if (!entry) return;
  if (entry.status === 'receiving') return transfers.cancelIncoming(id);
  if (!accept) return transfers.respond(id, false);
  if (opts.trust) {
    contacts.update(entry.contact.id, { trusted: true });
    contactsChanged();
  }
  let base = settings.get('saveDir');
  if (settings.get('askWhere') && entry.files.length) {
    const r = await withDialog(() =>
      dialog.showOpenDialog({ title: 'Dove salvare i file ricevuti?', defaultPath: base, properties: ['openDirectory', 'createDirectory'] }),
    );
    if (r.canceled || !r.filePaths[0]) return; // still pending: the card stays up
    base = r.filePaths[0];
  }
  transfers.respond(id, true, saveDirFor(entry, base));
});

ipcMain.handle('pairing:cancel', (_e, id) => transfers.cancelPairing(id));
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('open-url', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});

function allowedPath(p) {
  const resolved = path.resolve(String(p));
  return (
    transfers.isReceivedPath(resolved) ||
    airdropPaths.has(resolved) ||
    isInside(resolved, settings.get('saveDir')) ||
    history.items.some((h) => h.reveal && path.resolve(h.reveal) === resolved)
  );
}

ipcMain.handle('open-path', (_e, p) => {
  if (allowedPath(p)) return shell.openPath(String(p));
});
ipcMain.handle('show-in-folder', (_e, p) => {
  if (allowedPath(p)) shell.showItemInFolder(String(p));
});
ipcMain.handle('open-save-dir', () => openSaveDir());

// ───────────── IPC: settings window ─────────────

ipcMain.handle('settings:get', () => {
  airdrop?.refresh(); // availability is shown even before the bridge is turned on
  return settingsSnapshot();
});
const settingsSnapshot = () => ({
  settings: publicSettings(),
  contacts: contactViews(),
  history: history.items,
  peers: peerViews(),
  about: { version: app.getVersion(), author: AUTHOR, repo: REPO_URL, electron: process.versions.electron },
  update: updater ? updater.view() : null,
});
ipcMain.handle('update:check', () => updater?.check() ?? null);
ipcMain.handle('update:install', () => updater?.update() ?? null);
ipcMain.handle('settings:set', (_e, patch) => {
  const clean = cleanPatch(patch);
  if (Object.keys(clean).length) applySettings(clean);
  return publicSettings();
});
ipcMain.handle('avatar:choose', async (e) => {
  const r = await withDialog(() =>
    dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Scegli una foto profilo',
      properties: ['openFile'],
      filters: [{ name: 'Immagini', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
    }),
  );
  if (r.canceled || !r.filePaths[0]) return false;
  setAvatarFrom(r.filePaths[0]);
  return true;
});
ipcMain.handle('avatar:remove', () => {
  fs.rmSync(avatarFile(), { force: true });
  applySettings({ avatar: '' });
});
ipcMain.handle('savedir:choose', (e) => chooseSaveDir(BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('contacts:update', (_e, id, patch = {}) => {
  const clean = {};
  if (typeof patch.trusted === 'boolean') clean.trusted = patch.trusted;
  if (typeof patch.nickname === 'string') clean.nickname = patch.nickname.trim().slice(0, 40);
  contacts.update(id, clean);
  contactsChanged();
});
ipcMain.handle('contacts:remove', (_e, id) => {
  contacts.remove(id);
  contactsChanged();
});
ipcMain.handle('history:clear', () => {
  history.clear();
  broadcast('history', history.items);
});
ipcMain.handle('phone:link', () => phoneLink());
ipcMain.handle('airdrop:visible', async (_e, on) => {
  if (!airdropOn()) return false;
  if (on) await airdrop.refresh();
  return airdrop.setVisible(!!on);
});
ipcMain.handle('airdrop:refresh', () => (airdropOn() ? airdrop.refresh() : null));
ipcMain.handle('identity:reset', async (e) => {
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: 'warning',
    buttons: ['Annulla', 'Rigenera e riavvia'],
    defaultId: 0,
    cancelId: 0,
    title: 'Rigenera identità',
    message: 'Creare nuove chiavi di cifratura?',
    detail: 'Tutti i contatti e i telefoni collegati verranno dimenticati e andranno abbinati di nuovo. WaveDrop si riavvierà.',
  });
  if (response !== 1) return false;
  const dir = app.getPath('userData');
  resetIdentity(dir, safeStorage.isEncryptionAvailable() ? { protect: (b) => safeStorage.encryptString(b.toString('base64')) } : {});
  fs.rmSync(path.join(dir, 'contacts.json'), { force: true });
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('open-settings', (_e, section) => openSettings(section));

// ───────────── IPC: windows ─────────────

ipcMain.on('overlay:open', () => openOverlay());
ipcMain.on('overlay:hide', () => hideOverlay());
ipcMain.on('toast:dismiss', (_e, id) => dropToast(id));

ipcMain.on('toast:resize', (_e, height) => {
  if (!height) return toast.hide();
  const wa = screen.getPrimaryDisplay().workArea;
  toast.setBounds({ x: wa.x + wa.width - TOAST_WIDTH - 8, y: wa.y + 8, width: TOAST_WIDTH, height: Math.ceil(height) });
  if (!toast.isVisible()) toast.showInactive();
  toast.moveTop();
});

ipcMain.on('island:mode', (_e, mode) => {
  if (ISLAND_SIZES[mode] && mode !== islandMode) placeIsland(mode);
});
