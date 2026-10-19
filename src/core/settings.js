'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultName() {
  const user = (os.userInfo().username || 'Utente').replace(/[._-]+/g, ' ').trim();
  return user.charAt(0).toUpperCase() + user.slice(1);
}

class Settings {
  constructor(dir, defaults = {}) {
    this.file = path.join(dir, 'settings.json');
    this.data = {
      name: defaultName(),
      color: Math.floor(Math.random() * 8), // monogram avatar colour
      avatar: '', // hash of avatar.jpg, '' for the monogram
      visibility: 'everyone', // everyone | contacts | off
      saveDir: path.join(os.homedir(), 'Downloads', 'WaveDrop'),
      askWhere: false,
      senderFolders: false,
      afterReceive: 'none', // none | reveal | open
      autoAcceptTrusted: true,
      sound: true,
      island: true,
      bluetooth: true,
      theme: 'system', // system | light | dark
      hotkey: process.platform === 'darwin' ? 'Command+Shift+Option+D' : 'Control+Alt+D',
      ...defaults,
    };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // First run or unreadable file: keep defaults.
    }
    this.save();
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings };
