'use strict';
// Cliente WebSocket mínimo (RFC 6455) para el canal local de Stream Deck: Node 20 no trae WebSocket global y el plugin no lleva dependencias.
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const maxMessage = 1024 * 1024;

function encodeFrame(content, opcode = 1) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = 0x80 | length;
  else if (length < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Devuelve los frames completos y el resto pendiente; acepta frames con o sin máscara.
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset], second = buffer[offset + 1];
    let length = second & 0x7f, cursor = offset + 2;
    if (length === 126) { if (buffer.length - cursor < 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    else if (length === 127) { if (buffer.length - cursor < 8) break; const big = buffer.readBigUInt64BE(cursor); if (big > BigInt(maxMessage)) throw new Error('FRAME_TOO_LARGE'); length = Number(big); cursor += 8; }
    if (length > maxMessage) throw new Error('FRAME_TOO_LARGE');
    const masked = (second & 0x80) !== 0;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
    if (masked) cursor += 4;
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class LocalWebSocket extends EventEmitter {
  constructor(port) {
    super();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
    this.open = false;
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let handshake = Buffer.alloc(0), pending = Buffer.alloc(0), fragments = [];
    this.socket = net.connect({ host: '127.0.0.1', port }, () => {
      this.socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.socket.on('data', chunk => {
      try {
        if (!this.open) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end < 0) { if (handshake.length > 8192) throw new Error('HANDSHAKE_TOO_LARGE'); return; }
          const head = handshake.subarray(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101 /.test(head) || !head.split('\r\n').some(line => /^sec-websocket-accept:/i.test(line) && line.split(':')[1].trim() === accept)) throw new Error('HANDSHAKE_REJECTED');
          this.open = true;
          chunk = handshake.subarray(end + 4);
          this.emit('open');
        }
        pending = Buffer.concat([pending, chunk]);
        const { frames, rest } = decodeFrames(pending);
        pending = Buffer.from(rest);
        for (const frame of frames) {
          if (frame.opcode === 8) { this.close(); return; }
          if (frame.opcode === 9) { this.socket.write(encodeFrame(frame.payload, 10)); continue; }
          if (frame.opcode === 10) continue;
          if (frame.opcode === 1 || frame.opcode === 0) {
            fragments.push(frame.payload);
            if (fragments.reduce((total, part) => total + part.length, 0) > maxMessage) throw new Error('MESSAGE_TOO_LARGE');
            if (frame.fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; this.emit('message', text); }
          }
        }
      } catch (error) { this.emit('error', error); this.close(); }
    });
    this.socket.on('error', error => this.emit('error', error));
    this.socket.on('close', () => { this.open = false; this.emit('close'); });
  }
  send(text) { if (this.open) this.socket.write(encodeFrame(text)); }
  close() { if (!this.socket.destroyed) this.socket.destroy(); }
}

module.exports = { LocalWebSocket, encodeFrame, decodeFrames };
