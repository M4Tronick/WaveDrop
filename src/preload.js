'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'overlay:open',
  'overlay:close',
  'peers',
  'outgoing',
  'settings',
  'toasts',
  'island:mode',
  'island:activity',
  'contacts',
  'history',
  'phone:paired',
  'settings:section',
  'update',
]);
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('wave', {
  platform: process.platform,
  on(channel, fn) {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  pathFor: (file) => webUtils.getPathForFile(file),

  // sending
  snapshot: invoke('snapshot'),
  send: invoke('send'),
  sendText: invoke('send-text'),
  pickAndSend: invoke('pick-and-send'),
  peerMenu: invoke('peer:menu'),
  cancel: invoke('cancel'),
  pairCode: invoke('pair:code'),
  pairPeer: invoke('pair:peer'),

  // receiving
  respond: invoke('respond'),
  cancelPairing: invoke('pairing:cancel'),
  copy: invoke('clipboard:write'),
  openUrl: invoke('open-url'),
  openPath: invoke('open-path'),
  showInFolder: invoke('show-in-folder'),
  openSaveDir: invoke('open-save-dir'),

  // settings
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  chooseAvatar: invoke('avatar:choose'),
  removeAvatar: invoke('avatar:remove'),
  chooseSaveDir: invoke('savedir:choose'),
  updateContact: invoke('contacts:update'),
  removeContact: invoke('contacts:remove'),
  clearHistory: invoke('history:clear'),
  phoneLink: invoke('phone:link'),
  airdropVisible: invoke('airdrop:visible'),
  airdropRefresh: invoke('airdrop:refresh'),
  resetIdentity: invoke('identity:reset'),
  openSettings: invoke('open-settings'),
  checkUpdate: invoke('update:check'),
  installUpdate: invoke('update:install'),

  // windows
  openOverlay: () => ipcRenderer.send('overlay:open'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  dismissToast: (id) => ipcRenderer.send('toast:dismiss', id),
  resizeToast: (height) => ipcRenderer.send('toast:resize', height),
  islandMode: (mode) => ipcRenderer.send('island:mode', mode),
});
