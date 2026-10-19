'use strict';

// Bluetooth LE presence (Windows only), like AirDrop's BLE beacons: each PC
// advertises a tiny beacon with its LAN address and port; a PC that hears one
// asks that address for /Hello directly. This finds devices even on networks
// that drop multicast/broadcast (guest Wi-Fi, some mesh routers), and gives a
// signal strength to sort nearby devices first.
//
// Beacon (manufacturer data, company 0xFFFF): "WD" | version | IPv4 (4) | port (2) | flags (1)

const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

const MAX_RESTARTS = 3;

function beaconHex(ip, port, flags = 0) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return null;
  const buf = Buffer.from([0x57, 0x44, 2, ...parts, (port >> 8) & 255, port & 255, flags]);
  return buf.toString('hex').toUpperCase();
}

function parseBeacon(hex) {
  const b = Buffer.from(hex, 'hex');
  if (b.length < 10 || b[0] !== 0x57 || b[1] !== 0x44 || b[2] !== 2) return null;
  return { ip: `${b[3]}.${b[4]}.${b[5]}.${b[6]}`, port: (b[7] << 8) | b[8], flags: b[9] };
}

class Ble extends EventEmitter {
  constructor(exePath) {
    super();
    this.exePath = exePath;
    this.state = process.platform === 'win32' && fs.existsSync(exePath) ? 'off' : 'unsupported';
    this.detail = '';
    this.advert = null;
    this.restarts = 0;
  }

  start() {
    if (this.state === 'unsupported' || this.proc) return;
    this._setState('starting');
    const proc = (this.proc = spawn(this.exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }));
    let buffer = '';
    proc.stdout.on('data', (data) => {
      buffer += data.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        this._line(buffer.slice(0, i).trim());
        buffer = buffer.slice(i + 1);
      }
    });
    proc.on('error', (err) => this._setState('error', err.message));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return this._setState('off');
      if (code === 2) return this._setState('unsupported', 'Nessun adattatore Bluetooth LE');
      if (this.restarts++ < MAX_RESTARTS) setTimeout(() => this.start(), 2000);
      else this._setState('error', `Il servizio Bluetooth si è chiuso (${code})`);
    });
  }

  stop() {
    if (!this.proc) return this._setState(this.state === 'unsupported' ? 'unsupported' : 'off');
    this.stopping = true;
    this._write('quit');
    const proc = this.proc;
    setTimeout(() => proc.kill(), 1000).unref();
  }

  // hex beacon or null to stop advertising
  setAdvert(hex) {
    if (hex === this.advert) return;
    this.advert = hex;
    if (this.state === 'on') this._write(hex ? `advertise ${hex}` : 'unadvertise');
  }

  _write(line) {
    try {
      this.proc?.stdin.write(`${line}\n`);
    } catch {}
  }

  _line(line) {
    if (line.startsWith('status ready')) {
      this.stopping = false;
      this.restarts = 0;
      this._setState('on', /peripheral=0/.test(line) ? 'Solo ricerca: questo adattatore non può trasmettere' : '');
      this._write('scan on');
      if (this.advert) this._write(`advertise ${this.advert}`);
    } else if (line.startsWith('status unsupported')) {
      this._setState('unsupported', 'Nessun adattatore Bluetooth LE');
    } else if (line.startsWith('status error')) {
      this.detail = line.slice('status error '.length);
      this.emit('state');
    } else if (line.startsWith('seen ')) {
      const [, address, rssi, hex] = line.split(' ');
      const beacon = parseBeacon(hex || '');
      if (beacon) this.emit('seen', { ...beacon, rssi: Number(rssi), address });
    }
  }

  _setState(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.emit('state');
  }
}

module.exports = { Ble, beaconHex, parseBeacon };
