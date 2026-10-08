/* tools/_ws.js — 极简 WebSocket 客户端（CDP 用，零依赖）
 * 只实现 RFC6455 必需部分：客户端握手、文本帧收发、ping/pong、close。
 * 存在的意义：本项目坚持"零依赖"，截图/验证脚本也不该引入 ws 包污染依赖树。
 *
 * ★ 两个必须做对的地方（错过都会表现为"send 成功但永远收不到响应"）：
 *   ① 客户端发出的帧**必须带掩码**（RFC6455 §5.3）；
 *   ② 解析服务端帧时**不要**做掩码还原（服务端→客户端不带掩码）。
 */
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WS extends EventEmitter {
  constructor(sock) {
    super();
    this._sock = sock;              // ★ 必须在构造时保存，否则 _send() 拿不到 socket
    this._buf = Buffer.alloc(0);
    this._frag = null;
    this._handshaked = false;
  }
  static connect(url) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    const ws = new WS(sock);
    sock.on('connect', () => {
      sock.write(
        'GET ' + (u.pathname + u.search) + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('data', d => ws._onData(d));
    sock.on('error', e => ws.emit('error', e));
    sock.on('close', () => ws.emit('close'));
    return ws;
  }
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._handshaked) {
      const i = this._buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      this._handshaked = true;
      this._buf = this._buf.subarray(i + 4);
      this.emit('open');
    }
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this._buf = b.subarray(off + len);
      if (op === 0x8) return;                                   // close
      if (op === 0x9) { this._send(0xA, payload); continue; }   // ping → pong
      if (op === 0xA) continue;                                // pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this._frag = this._frag ? Buffer.concat([this._frag, payload]) : payload;
        if (fin) { const s = this._frag.toString('utf8'); this._frag = null; this.emit('message', s); }
      }
    }
  }
  _send(op, data) {
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let head;
    if (len < 126) { head = Buffer.alloc(6); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(8); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(14); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    mask.copy(head, head.length - 4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
    this._sock.write(Buffer.concat([head, masked]));
  }
  send(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  close() { try { this._send(0x8, Buffer.alloc(0)); } catch (e) {} try { this._sock.end(); } catch (e) {} }
}
module.exports = { WS };
