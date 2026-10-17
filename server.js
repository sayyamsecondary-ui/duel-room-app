'use strict';
// Duel Room server. No dependencies: serves ./public and relays room messages over a WebSocket at /ws.
// All game logic runs on the host player's phone; this server only forwards messages inside a room.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const ID_RE = /^[a-z0-9_-]{4,24}$/i;
const MAX_ROOM = 8;
const MAX_ROOMS_PER_CLIENT = 4;
const MAX_FRAME = 8192;

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p === '/sw.js' || p === '/index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
});

/* ---- minimal WebSocket (RFC 6455) text-frame implementation ---- */
class Conn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.readyState = 1; this.parts = null;
    this.alive = true; this.onmessage = null; this.onclose = null;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose(); });
    socket.on('error', () => {});
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 4 * MAX_FRAME) return this.terminate();
    for (;;) { const f = this.parse(); if (!f) break; this.handle(f); if (this.readyState !== 1) break; }
  }
  parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; if (b.readUInt32BE(2) !== 0) { this.terminate(); return null; } len = b.readUInt32BE(6); off = 10; }
    if (len > MAX_FRAME || !masked) { this.terminate(); return null; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, op, payload };
  }
  handle(f) {
    if (f.op === 0x8) return this.close();
    if (f.op === 0x9) return this.frame(0xA, f.payload);
    if (f.op === 0xA) { this.alive = true; return; }
    if (f.op === 0x1 || f.op === 0x2) this.parts = [f.payload];
    else if (f.op === 0x0 && this.parts) this.parts.push(f.payload);
    else return;
    if (f.fin) {
      const msg = Buffer.concat(this.parts); this.parts = null;
      if (this.onmessage) this.onmessage(msg.toString('utf8'));
    }
  }
  frame(op, payload) {
    if (this.readyState !== 1) return;
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  close() { if (this.readyState === 1) { this.frame(0x8, Buffer.alloc(0)); this.readyState = 2; this.socket.end(); } }
  terminate() { this.readyState = 3; this.socket.destroy(); }
}

const conns = new Set();
const clients = new Map(); // id -> Conn
const rooms = new Map();   // room name -> Set of ids

function sendTo(c, obj) { if (c && c.readyState === 1) c.send(JSON.stringify(obj)); }
function broadcastPeers(name) {
  const members = rooms.get(name);
  if (!members) return;
  const ids = Array.from(members);
  ids.forEach((id) => sendTo(clients.get(id), { t: 'peers', room: name, peers: ids }));
}
function leaveRoom(c, name) {
  c.rooms.delete(name);
  const members = rooms.get(name);
  if (!members) return;
  members.delete(c.id);
  if (members.size === 0) rooms.delete(name); else broadcastPeers(name);
}

server.on('upgrade', (req, socket) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return socket.destroy(); }
  const key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const c = new Conn(socket);
  let id = u.searchParams.get('id');
  if (!id || !ID_RE.test(id)) id = 'p' + Math.random().toString(36).slice(2, 10);
  const old = clients.get(id);
  if (old) { old.replaced = true; old.terminate(); conns.delete(old); }
  c.id = id; c.rooms = new Set(); c.tokens = 120; c.last = Date.now();
  clients.set(id, c); conns.add(c);
  sendTo(c, { t: 'hello', id });

  c.onmessage = (raw) => {
    const now = Date.now();
    c.tokens = Math.min(120, c.tokens + (now - c.last) / 1000 * 80); c.last = now;
    if (c.tokens < 1) return;
    c.tokens -= 1;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return;
    if (m.t === 'join') {
      if (!c.rooms.has(m.room) && c.rooms.size >= MAX_ROOMS_PER_CLIENT) return;
      let members = rooms.get(m.room);
      if (!members) { members = new Set(); rooms.set(m.room, members); }
      if (!members.has(c.id) && members.size >= MAX_ROOM) return sendTo(c, { t: 'full', room: m.room });
      members.add(c.id); c.rooms.add(m.room);
      broadcastPeers(m.room);
    } else if (m.t === 'leave') {
      leaveRoom(c, m.room);
    } else if (m.t === 'emit') {
      if (typeof m.topic !== 'string' || !TOPIC_RE.test(m.topic) || !c.rooms.has(m.room)) return;
      const members = rooms.get(m.room);
      if (!members) return;
      const out = JSON.stringify({ t: 'msg', room: m.room, topic: m.topic, data: m.data === undefined ? null : m.data, peer: c.id });
      members.forEach((pid) => { const t = clients.get(pid); if (t && t.readyState === 1) t.send(out); });
    }
  };
  c.onclose = () => {
    conns.delete(c);
    if (c.replaced || clients.get(c.id) !== c) return;
    clients.delete(c.id);
    Array.from(c.rooms).forEach((name) => leaveRoom(c, name));
  };
});

setInterval(() => {
  conns.forEach((c) => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); });
}, 30000).unref();

if (require.main === module) server.listen(PORT, () => console.log('Duel Room listening on port ' + PORT));
module.exports = server;
