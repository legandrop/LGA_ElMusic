'use strict';
// Cliente del canal local de El Music. Debe calcular el mismo endpoint que src/remote-control.ts (lo verifica un test).
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function controlEndpoint(platform, username, home) {
  if (platform === 'win32') return `\\\\.\\pipe\\ElMusic-control-${String(username).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user'}`;
  const base = platform === 'darwin' ? path.posix.join(home, 'Library', 'Application Support') : path.posix.join(home, '.config');
  return path.posix.join(base, 'LGA', 'ElMusic', 'control.sock');
}

function defaultEndpoint() {
  let username = 'user';
  try { username = os.userInfo().username; } catch { /* Mismo nombre neutro que la app. */ }
  return controlEndpoint(process.platform, username, os.homedir());
}

class ControlClient extends EventEmitter {
  constructor(endpoint = defaultEndpoint()) {
    super();
    this.endpoint = endpoint;
    this.socket = undefined;
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  connect() {
    if (this.socket) return this.ready;
    this.ready = new Promise(resolve => {
      const socket = net.connect(this.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.on('connect', () => { this.connected = true; this.emit('connected'); resolve(true); });
      socket.on('data', chunk => this.receive(chunk));
      socket.on('error', () => resolve(false));
      socket.on('close', () => {
        this.connected = false; this.socket = undefined; this.buffer = '';
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('unavailable')); }
        this.pending.clear();
        this.emit('disconnected');
        resolve(false);
      });
    });
    return this.ready;
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) { this.socket?.destroy(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(message?.id);
      if (!entry) continue;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.ok === true) entry.resolve(message.data ?? {});
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'failed'));
    }
  }

  // Sin reintentos: un efecto pedido por una tecla se envía una sola vez.
  async request(action, extra = {}, timeout = 15000) {
    if (!this.connected && !(await this.connect())) throw new Error('not-running');
    const id = this.nextId++;
    if (this.nextId > 2 ** 31) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, action, ...extra })}\n`);
    });
  }

  close() { this.socket?.destroy(); }
}

module.exports = { ControlClient, controlEndpoint, defaultEndpoint };
