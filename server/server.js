// SHAKARA server. One small Node program does three jobs:
//  1. serves the game files (html, js, css, fonts) to browsers,
//  2. keeps the rooms: codes, who is in which team, who is host, quick match,
//  3. runs every match 30 times a second (the "tick") and sends each player a snapshot 15 times a second.
// Players never decide what happened; they only send "I am pressing these buttons". That is what stops cheating.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Match, ST, TICK_HZ, SNAP_EVERY, MAX_HUMANS_PER_TEAM, PLAYERS_PER_TEAM, LINES } from '../public/shared/sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const PORT = +process.env.PORT || 8080;
const LAG = +process.env.SIM_LAG_MS || 0; // test only: adds this many ms each way
const MAX_ROOMS = 300;
const GRACE_MS = 25000;           // keep a dropped player's seat for reconnects
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O

// ---------- static files (precompressed in memory) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const cache = new Map();
// BUILD = a short hash of everything in public/. Pages ask for main.js?v=BUILD etc., so a redeploy
// always gets fresh code even though the CDN in front tells browsers to cache files for hours.
function hashDir(dir, h = crypto.createHash('sha1')) {
  for (const n of fs.readdirSync(dir).sort()) { const p = path.join(dir, n); const st = fs.statSync(p); if (st.isDirectory()) hashDir(p, h); else h.update(n).update(fs.readFileSync(p)); }
  return h;
}
const BUILD = hashDir(PUB).digest('hex').slice(0, 10);
function loadStatic(rel) {
  const fp = path.join(PUB, rel);
  if (!fp.startsWith(PUB)) return null;
  let st; try { st = fs.statSync(fp); } catch { return null; }
  if (st.isDirectory()) return loadStatic(path.join(rel, 'index.html'));
  const hit = cache.get(fp);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  let raw = fs.readFileSync(fp); const ext = path.extname(fp);
  if (/\.(html|js|css)$/.test(ext)) raw = Buffer.from(raw.toString('utf8').replaceAll('__V__', BUILD));
  const type = TYPES[ext] || 'application/octet-stream';
  const comp = /text|javascript|json|svg|manifest/.test(type) ? zlib.gzipSync(raw, { level: 9 }) : null;
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 16) + '"';
  const e = { raw, gz: comp, type, etag, mtime: st.mtimeMs, ext };
  cache.set(fp, e); return e;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, build: BUILD, rooms: rooms.size, clients: clients.size, uptime: process.uptime() | 0 })); }
  if (u.pathname === '/api/where') {
    // which coarse location headers the hosting edge passes through (no IP is returned or stored)
    const h = req.headers; res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ cfCountry: h['cf-ipcountry'] || null, cfRegion: h['cf-region'] || null, cfCity: h['cf-ipcity'] || null, lang: h['accept-language'] || null, hasXff: !!h['x-forwarded-for'] }));
  }
  if (u.pathname === '/api/rooms') {
    const list = [...rooms.values()].filter(r => r.isPublic).map(r => ({ code: r.code, humans: r.humans().length, state: r.match ? r.match.state : 0, region: r.region.cc || '' }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ rooms: list }));
  }
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const f = loadStatic(rel);
  if (!f) { res.writeHead(404); return res.end('not found'); }
  const headers = { 'content-type': f.type, etag: f.etag,
    // code + html revalidate every load (cheap 304s) so a redeploy is seen at once; fonts/images cache for a week
    'cache-control': /\.(woff2|png|jpg|webp|svg|ico)$/.test(f.ext) ? 'public, max-age=604800' : 'no-cache' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding'; res.writeHead(200, headers); return res.end(f.gz); }
  res.writeHead(200, headers); res.end(f.raw);
});

// ---------- rooms ----------
const rooms = new Map();
const clients = new Map(); // id -> client
let nextId = 1;

function makeCode() {
  for (let n = 0; n < 1000; n++) {
    let c = ''; for (let i = 0; i < 5; i++) c += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no codes');
}
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, 14) || 'Baller' + (100 + crypto.randomInt(900));

class Room {
  constructor(code, isPublic, region) {
    this.code = code; this.isPublic = !!isPublic; this.region = region || {};
    this.members = new Map(); // clientId -> {client, team, slot(player index) , name, gone}
    this.hostId = null; this.match = null; this.rematchVotes = new Set();
    this.halfLen = 180; // EASY EDIT: default half length in seconds
    this.created = Date.now(); this.emptySince = Date.now(); this.eventSeq = 0;
  }
  humans() { return [...this.members.values()]; }
  teamCount(t) { return this.humans().filter(m => m.team === t).length; }
  add(client) {
    const t = this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
    const team = this.teamCount(t) < MAX_HUMANS_PER_TEAM ? t : 1 - t;
    if (this.teamCount(team) >= MAX_HUMANS_PER_TEAM) return false;
    const m = { client, team, name: client.name, idx: -1, gone: 0 };
    this.members.set(client.id, m);
    client.room = this;
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = client.id;
    if (this.match) this.seat(m);
    this.emptySince = 0;
    this.sendLobby();
    if (this.match) { this.sendMatchInfo(); }
    return true;
  }
  seat(m) {
    // take over a bot outfield slot on the member's team
    const used = new Set(this.humans().filter(x => x !== m && x.idx >= 0).map(x => x.idx));
    for (let s = 1; s < PLAYERS_PER_TEAM; s++) {
      const idx = m.team * PLAYERS_PER_TEAM + s;
      if (!used.has(idx)) { m.idx = idx; this.match.human[idx] = true; this.match.inputs[idx] = { mx: 0, my: 0, b: 0 }; m.queue = []; m.ack = 0; return; }
    }
    m.idx = -1;
  }
  unseat(m) { if (this.match && m.idx >= 0) { this.match.human[m.idx] = false; } m.idx = -1; }
  remove(clientId) {
    const m = this.members.get(clientId); if (!m) return;
    this.unseat(m); this.members.delete(clientId); this.rematchVotes.delete(clientId);
    if (this.hostId === clientId) this.hostId = this.members.size ? this.members.keys().next().value : null;
    if (!this.members.size) this.emptySince = Date.now();
    this.sendLobby(); if (this.match) this.sendMatchInfo();
  }
  lobbyState() {
    return { t: 'room', code: this.code, host: this.hostId, public: this.isPublic, halfLen: this.halfLen,
      inMatch: !!this.match, state: this.match ? this.match.state : ST.LOBBY,
      players: this.humans().map(m => ({ id: m.client.id, name: m.name, team: m.team, idx: m.idx, away: !!m.gone })),
      rematch: [...this.rematchVotes] };
  }
  sendLobby() { this.broadcast(JSON.stringify(this.lobbyState())); }
  sendMatchInfo() {
    if (!this.match) return;
    const names = this.match.players.map(p => null);
    for (const m of this.humans()) if (m.idx >= 0) names[m.idx] = m.name;
    for (const m of this.humans()) m.client.send(JSON.stringify({ t: 'match', me: m.idx, names, halfLen: this.match.halfLen, human: this.match.human }));
  }
  broadcast(s) { for (const m of this.members.values()) if (!m.gone) m.client.send(s); }
  start(halfLen) {
    this.halfLen = halfLen || this.halfLen;
    this.match = new Match({ halfLen: this.halfLen });
    this.rematchVotes.clear();
    for (const m of this.humans()) { m.idx = -1; }
    for (const m of this.humans()) this.seat(m);
    this.sendLobby(); this.sendMatchInfo();
  }
  toLobby() { this.match = null; for (const m of this.humans()) m.idx = -1; this.rematchVotes.clear(); this.sendLobby(); }
  tick() {
    const M = this.match; if (!M) return;
    for (const m of this.members.values()) {
      if (m.idx < 0) continue;
      const q = m.queue;
      if (q.length > 6) q.splice(0, q.length - 2);
      if (q.length) { const inp = q.shift(); M.inputs[m.idx] = inp; m.ack = inp.seq; }
      if (m.gone) M.inputs[m.idx] = { mx: 0, my: 0, b: 0 };
    }
    M.step();
    if (M.events.length) {
      for (const e of M.events) {
        if (e.k === 'tackle' || e.k === 'shot') continue;
        const ev = { t: 'ev', ...e, n: ++this.eventSeq };
        if (e.p !== undefined && e.p >= 0) { const who = this.humans().find(m => m.idx === e.p); ev.name = who ? who.name : null; }
        this.broadcast(JSON.stringify(ev));
        if (e.k === 'full') this.sendLobby();
      }
      M.events.length = 0;
    }
    if (M.tick % SNAP_EVERY === 0) this.snapshot();
  }
  snapshot() {
    const M = this.match, P = M.players, b = M.ball;
    const n = P.length, size = 1 + 4 + 1 + 1 + 2 + 2 + 1 + 10 + 1 + n * 10 + 8;
    const buf = Buffer.alloc(size); let o = 0;
    const i16 = (v) => { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), o); o += 2; };
    buf.writeUInt8(1, o++); buf.writeUInt32LE(M.tick, o); o += 4;
    buf.writeUInt8(M.state, o++); buf.writeUInt8(M.half, o++);
    buf.writeUInt16LE(Math.ceil(M.clock * 10), o); o += 2;
    buf.writeUInt8(M.score[0], o++); buf.writeUInt8(M.score[1], o++);
    buf.writeUInt8(b.owner < 0 ? 255 : b.owner, o++);
    i16(b.x * 100); i16(b.y * 100); i16(b.z * 100); i16(b.vx * 100); i16(b.vy * 100);
    buf.writeUInt8(n, o++);
    for (const p of P) {
      i16(p.x * 100); i16(p.y * 100);
      buf.writeUInt8(Math.round(((p.face % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * 255) & 255, o++);
      const fl = (p.sprinting ? 1 : 0) | (p.tackleT > 0 ? 2 : 0) | (p.stunT > 0 ? 4 : 0) | (p.charging ? 8 : 0) | (p.kickFx > 0 ? 16 : 0) | (M.human[p.i] ? 32 : 0);
      buf.writeUInt8(fl, o++);
      i16(p.vx * 100); i16(p.vy * 100);
    }
    const tail = o;
    for (const m of this.members.values()) {
      if (m.gone) continue;
      o = tail;
      const p = m.idx >= 0 ? P[m.idx] : null;
      buf.writeUInt16LE(m.ack & 0xffff, o); o += 2;
      buf.writeUInt8(m.idx < 0 ? 255 : m.idx, o++);
      buf.writeUInt8(p ? Math.round(p.stamina * 255) : 0, o++);
      buf.writeUInt8(p ? Math.round(p.tackleT * 100) : 0, o++);
      buf.writeUInt8(p ? Math.round(p.tackleCd * 100) : 0, o++);
      buf.writeUInt8(p ? Math.round(p.stunT * 100) : 0, o++);
      buf.writeUInt8(p ? Math.round(p.charge * 255) : 0, o++);
      m.client.sendBin(buf);
    }
  }
}

// ---------- quick match scoring ----------
function regionScore(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  if (a.cc && b.cc && a.cc === b.cc) s += 3;
  if (a.tz && b.tz && a.tz === b.tz) s += 1;
  if (a.lat != null && b.lat != null) {
    const km = Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) * 111;
    if (km < 60) s += 3; else if (km < 400) s += 1.5;
  }
  return s;
}
function quickMatch(client) {
  let best = null, bs = -1;
  for (const r of rooms.values()) {
    if (!r.isPublic || r.humans().length >= MAX_HUMANS_PER_TEAM * 2) continue;
    if (r.match && r.match.state === ST.FULLTIME) continue;
    if (!r.members.size) continue;
    const s = regionScore(client.region, r.region) + (r.match ? 0 : 0.5) + r.humans().length * 0.2;
    if (s > bs) { bs = s; best = r; }
  }
  return best;
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
const tokens = new Map(); // token -> clientId (for reconnects)

function coarseRegion(r, req) {
  r = r || {};
  const reg = {};
  const cc = (req.headers['cf-ipcountry'] || r.cc || '').toString().toUpperCase().slice(0, 2);
  if (/^[A-Z]{2}$/.test(cc) && cc !== 'XX') reg.cc = cc;
  if (typeof r.tz === 'string') reg.tz = r.tz.slice(0, 40);
  if (isFinite(r.lat) && isFinite(r.lon)) { reg.lat = Math.round(r.lat * 2) / 2; reg.lon = Math.round(r.lon * 2) / 2; } // ~50 km cells
  return reg;
}

wss.on('connection', (ws, req) => {
  const client = { id: nextId++, ws, name: 'Baller', room: null, region: {}, token: null, lastMsg: Date.now(), msgs: 0 };
  client.send = (s) => { if (ws.readyState === 1) ws.send(s); };
  client.sendBin = (b) => { if (ws.readyState === 1 && ws.bufferedAmount < 64000) ws.send(b); };
  if (LAG) { // test mode: fake a slow network (each way), with a little jitter
    const s0 = client.send, b0 = client.sendBin;
    client.send = (s) => setTimeout(() => s0(s), LAG + Math.random() * LAG * 0.2);
    client.sendBin = (b) => { const c = Buffer.from(b); setTimeout(() => b0(c), LAG + Math.random() * LAG * 0.2); };
  }
  clients.set(client.id, client);
  const err = (msg) => client.send(JSON.stringify({ t: 'error', msg }));

  ws.on('message', (data, isBin) => LAG ? setTimeout(() => onMsg(data, isBin), LAG + Math.random() * LAG * 0.2) : onMsg(data, isBin));
  function onMsg(data, isBin) {
    try { handle(data, isBin); } catch (e) { console.error('message error', e); }
  }
  function handle(data, isBin) {
    client.lastMsg = Date.now();
    if (isBin) {
      // input: u8 2, u16 seq, i8 mx, i8 my, u8 buttons
      if (data.length < 6 || data[0] !== 2) return;
      const r = client.room; if (!r || !r.match) return;
      const m = r.members.get(client.id); if (!m || m.idx < 0) return;
      const seq = data.readUInt16LE(1);
      m.queue.push({ seq, mx: data.readInt8(3) / 127, my: data.readInt8(4) / 127, b: data[5] & 63 });
      return;
    }
    if (++client.msgs > 400) return; // crude flood guard per connection
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    const r = client.room;
    switch (msg.t) {
      case 'hello': {
        client.name = cleanName(msg.name); client.region = coarseRegion(msg.region, req);
        // reconnect: reclaim a seat held for this token
        if (msg.token && typeof msg.token === 'string' && tokens.has(msg.token)) {
          const oldId = tokens.get(msg.token);
          for (const room of rooms.values()) {
            const m = room.members.get(oldId);
            if (m && m.gone) {
              room.members.delete(oldId); m.client = client; m.gone = 0; m.name = client.name;
              room.members.set(client.id, m); client.room = room;
              if (room.hostId === oldId) room.hostId = client.id;
              if (room.rematchVotes.delete(oldId)) room.rematchVotes.add(client.id);
              client.send(JSON.stringify({ t: 'welcome', id: client.id, rejoined: room.code }));
              room.sendLobby(); if (room.match) room.sendMatchInfo();
              tokens.set(msg.token, client.id); client.token = msg.token;
              return;
            }
          }
        }
        client.token = (typeof msg.token === 'string' && msg.token.length < 40) ? msg.token : crypto.randomBytes(9).toString('base64url');
        tokens.set(client.token, client.id);
        client.send(JSON.stringify({ t: 'welcome', id: client.id, token: client.token }));
        break;
      }
      case 'create': {
        if (r) r.remove(client.id);
        if (rooms.size >= MAX_ROOMS) return err('Server full, try again soon');
        const room = new Room(makeCode(), msg.public !== false, client.region);
        rooms.set(room.code, room); room.add(client);
        break;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
        let room = rooms.get(code);
        // after a server restart, players coming back from a room re-open it under the same code
        if (!room && msg.recreate && code.length === 5 && rooms.size < MAX_ROOMS) { room = new Room(code, msg.public !== false, client.region); rooms.set(code, room); }
        if (!room) return err('No room with code ' + code + '. Check the code and try again.');
        if (r === room) return room.sendLobby();
        if (room.humans().length >= MAX_HUMANS_PER_TEAM * 2) return err('That room is full (8 players).');
        if (r) r.remove(client.id);
        room.add(client);
        break;
      }
      case 'quick': {
        if (r) r.remove(client.id);
        let room = quickMatch(client);
        if (room) { room.add(client); client.send(JSON.stringify({ t: 'quick', found: true, code: room.code })); }
        else {
          if (rooms.size >= MAX_ROOMS) return err('Server full, try again soon');
          room = new Room(makeCode(), true, client.region); rooms.set(room.code, room); room.add(client);
          client.send(JSON.stringify({ t: 'quick', found: false, code: room.code }));
        }
        break;
      }
      case 'region': client.region = coarseRegion(msg.region, req); break;
      case 'leave': if (r) { r.remove(client.id); client.room = null; } break;
      case 'name': {
        client.name = cleanName(msg.name);
        if (r) { const m = r.members.get(client.id); if (m) m.name = client.name; r.sendLobby(); if (r.match) r.sendMatchInfo(); }
        break;
      }
      case 'team': {
        if (!r) return; const m = r.members.get(client.id); if (!m) return;
        const t = msg.team === 1 ? 1 : 0;
        if (m.team === t) return;
        if (r.teamCount(t) >= MAX_HUMANS_PER_TEAM) return err('That team is full');
        r.unseat(m); m.team = t; if (r.match) r.seat(m);
        r.sendLobby(); if (r.match) r.sendMatchInfo();
        break;
      }
      case 'public': if (r && r.hostId === client.id) { r.isPublic = !!msg.value; r.sendLobby(); } break;
      case 'settings': if (r && r.hostId === client.id) { const h = +msg.halfLen; if ([30, 60, 120, 180, 300].includes(h)) r.halfLen = h; r.sendLobby(); } break;
      case 'start': {
        if (!r) return; if (r.hostId !== client.id) return err('Only the host can start');
        if (r.match && r.match.state !== ST.FULLTIME) return;
        r.start(+msg.halfLen && [30, 60, 120, 180, 300].includes(+msg.halfLen) ? +msg.halfLen : r.halfLen);
        break;
      }
      case 'rematch': {
        if (!r || !r.match || r.match.state !== ST.FULLTIME) return;
        r.rematchVotes.add(client.id);
        const all = r.humans().filter(m => !m.gone).every(m => r.rematchVotes.has(m.client.id));
        if (r.hostId === client.id || all) r.start(r.halfLen); else r.sendLobby();
        break;
      }
      case 'lobby': { if (r && r.hostId === client.id && r.match && r.match.state === ST.FULLTIME) r.toLobby(); break; }
      case 'ping': client.send(JSON.stringify({ t: 'pong', c: msg.c })); break;
    }
  }
  ws.on('close', () => {
    clients.delete(client.id);
    const r = client.room;
    if (r) {
      const m = r.members.get(client.id);
      if (m) { m.gone = Date.now(); r.sendLobby(); }
    }
  });
});
setInterval(() => { for (const c of clients.values()) c.msgs = 0; }, 1000);

// ---------- game loop ----------
let last = performance.now(), acc = 0;
const TICK_MS = 1000 / TICK_HZ;
function loop() {
  const now = performance.now(); acc += now - last; last = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 5) { for (const r of rooms.values()) { try { r.tick(); } catch (e) { console.error('tick error', r.code, e); } } acc -= TICK_MS; steps++; }
  if (steps === 5) acc = 0;
  setTimeout(loop, Math.max(1, TICK_MS - acc - 1));
}
loop();
// housekeeping: drop expired seats and empty rooms
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const [id, m] of r.members) if (m.gone && now - m.gone > GRACE_MS) r.remove(id);
    // a host who dropped hands the crown to someone still here
    const h = r.members.get(r.hostId);
    if (h && h.gone && now - h.gone > 8000) { const alive = [...r.members.values()].find(m => !m.gone); if (alive) { r.hostId = alive.client.id; r.sendLobby(); } }
    if (!r.members.size && r.emptySince && now - r.emptySince > 60000) rooms.delete(r.code);
  }
  for (const [tk, id] of tokens) if (!clients.has(id) && ![...rooms.values()].some(r => r.members.has(id))) tokens.delete(tk);
}, 5000);
// keepalive pings (mobile networks drop idle sockets)
setInterval(() => { for (const c of clients.values()) { if (c.ws.readyState === 1) c.ws.ping(); } }, 15000);

// never let one bad message take the whole server (and every match) down
process.on('uncaughtException', (e) => console.error('uncaught', e));
server.listen(PORT, () => console.log('naija5 server on :' + PORT));
