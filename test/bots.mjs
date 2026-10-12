// Headless multiplayer test: N websocket clients join one room by code and play a full match.
// usage: node test/bots.mjs [baseUrl] [clients] [halfLenSeconds]
import WebSocket from 'ws';
import { ST, PLAYERS_PER_TEAM, BTN_PASS, BTN_SHOOT, BTN_SPRINT, BTN_TACKLE, BTN_MARK, BTN_CALL, HALF_W, markTarget } from '../public/shared/sim.js';
const base = process.argv[2] || 'http://localhost:8080';
const N = +(process.argv[3] || 3), HALF = +(process.argv[4] || 30);
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseSnap(buf) {
  let o = 0; const s = {}; if (buf.readUInt8(o++) !== 1) return null;
  s.tick = buf.readUInt32LE(o); o += 4; s.state = buf[o++]; s.half = buf[o++]; s.clock = buf.readUInt16LE(o) / 10; o += 2;
  s.score = [buf[o++], buf[o++]]; const ow = buf[o++]; s.owner = ow === 255 ? -1 : ow;
  const i16 = () => { const v = buf.readInt16LE(o) / 100; o += 2; return v; };
  s.ball = { x: i16(), y: i16(), z: i16(), vx: i16(), vy: i16() };
  const n = buf[o++]; s.players = [];
  for (let i = 0; i < n; i++) { const x = i16(), y = i16(); o += 2; const vx = i16(), vy = i16(); s.players.push({ x, y, vx, vy, human: !!(buf[o - 5] & 32) }); }
  s.ack = buf.readUInt16LE(o); o += 2; const me = buf[o++]; s.me = me === 255 ? -1 : me;
  return s;
}

class Bot {
  constructor(name) { this.name = name; this.snaps = 0; this.events = []; this.room = null; this.match = null; this.last = null; this.seq = 0; this.pings = []; this.firstSnapAt = 0; this.moveTest = null; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => { this.send({ t: 'hello', name: this.name, token: this.token, region: { tz: 'Africa/Lagos', cc: 'NG' } }); });
      this.ws.on('message', (d, bin) => {
        if (bin) { const s = parseSnap(d); if (s) { this.last = s; this.snaps++; if (!this.firstSnapAt) this.firstSnapAt = Date.now(); } return; }
        const m = JSON.parse(d.toString());
        if (m.t === 'welcome') { this.id = m.id; if (m.token) this.token = m.token; this.rejoined = m.rejoined; res(); }
        else if (m.t === 'room') this.room = m;
        else if (m.t === 'match') this.match = m;
        else if (m.t === 'ev') this.events.push(m);
        else if (m.t === 'pong') this.pings.push(Date.now() - m.c);
        else if (m.t === 'error') log(this.name, 'ERROR', m.msg);
      });
      this.ws.on('error', rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  input(mx, my, b) { const buf = Buffer.alloc(6); buf[0] = 2; this.seq = (this.seq + 1) & 0xffff; buf.writeUInt16LE(this.seq, 1); buf.writeInt8(Math.round(mx * 127), 3); buf.writeInt8(Math.round(my * 127), 4); buf[5] = b; this.ws.send(buf); }
  play() {
    // simple brain: run at the ball, pass sometimes, shoot near goal
    this.timer = setInterval(() => {
      const s = this.last; if (!s || s.me < 0) return;
      const me = s.players[s.me], team = Math.floor(s.me / PLAYERS_PER_TEAM);
      const dir = (team === 0) === (s.half === 1) ? 1 : -1;
      let tx = s.ball.x, ty = s.ball.y, b = 0;
      if (s.owner === s.me) { tx = dir * HALF_W; ty = 0; const d = Math.abs(dir * HALF_W - me.x); if (d < 14) b = (this.seq % 20 < 12) ? BTN_SHOOT : 0; else if (Math.random() < 0.03) b = BTN_PASS; }
      else if (Math.random() < 0.02) b = BTN_TACKLE;
      if (this.moveTest) { tx = me.x + 10; ty = me.y; b = 0; }
      if (this.override) { const o = this.override(s, me); if (o) { this.input(o.mx, o.my, o.b); return; } }
      const dx = tx - me.x, dy = ty - me.y, L = Math.hypot(dx, dy) || 1;
      this.input(dx / L, dy / L, b);
    }, 1000 / 30);
    this.pingT = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 1000);
  }
  stop() { clearInterval(this.timer); clearInterval(this.pingT); }
}

const results = { url: base, clients: N };
const ok = (k, v, cond) => { results[k] = v; log((cond ? 'PASS' : 'FAIL'), k, JSON.stringify(v)); if (!cond) results.failed = (results.failed || []).concat(k); };

const host = new Bot('HostTunde'); await host.open();
host.send({ t: 'create', public: false });
await sleep(800);
const code = host.room && host.room.code;
ok('room_created', code, /^[A-Z]{5}$/.test(code || ''));
const others = [];
for (let i = 1; i < N; i++) { const b = new Bot(['Chioma', 'Emeka', 'Zainab'][i - 1] || 'Bot' + i); await b.open(); b.send({ t: 'join', code }); others.push(b); }
await sleep(1000);
const all = [host, ...others];
ok('all_in_lobby', all.map(b => b.room && b.room.code === code && b.room.players.length), all.every(b => b.room && b.room.players.length === N));
if (others[0]) { others[0].send({ t: 'team', team: 1 }); await sleep(500); }
ok('teams', host.room.players.map(p => p.name + ':' + (p.team ? 'B' : 'A')), new Set(host.room.players.map(p => p.team)).size === 2 || N === 1);
const t0 = Date.now();
host.send({ t: 'start', halfLen: HALF });
await sleep(1200);
ok('match_seats', all.map(b => b.match && b.match.me), all.every(b => b.match && b.match.me >= 0) && new Set(all.map(b => b.match.me)).size === N);
// state sync: every client sees the same tick/score/positions
await sleep(1500);
const ticks = all.map(b => b.last.tick); ok('snapshots_flowing', { snaps: all.map(b => b.snaps), ticks }, all.every(b => b.snaps > 10));
// input -> movement: host runs right for 1s
const meIdx = host.last.me; const x0 = host.last.players[meIdx].x;
host.moveTest = true; all.forEach(b => b.play()); await sleep(1200); host.moveTest = false;
const x1 = host.last.players[meIdx].x;
const seenByOther = others[0] ? others[0].last.players[meIdx].x : x1;
ok('input_moves_player', { from: x0.toFixed(2), to: x1.toFixed(2), otherClientSees: seenByOther.toFixed(2) }, x1 - x0 > 3 && Math.abs(seenByOther - x1) < 1.5);
// MARK: a client whose team is defending holds MARK and should end up tight on its man, goal-side
{
  let tries = 0, done = false;
  while (!done && tries++ < 40) {
    await sleep(500);
    const d = all.find(x => { const s = x.last; return s && s.owner >= 0 && Math.floor(s.owner / PLAYERS_PER_TEAM) !== Math.floor(s.me / PLAYERS_PER_TEAM) && s.owner % PLAYERS_PER_TEAM !== 0; });
    if (!d) continue;
    d.override = () => ({ mx: 0, my: 0, b: BTN_MARK });
    const dists = [];
    for (let k = 0; k < 16; k++) { await sleep(150); const s = d.last; const t = markTarget(s.players, s.me, s.ball, s.owner); if (t >= 0) dists.push(+Math.hypot(s.players[t].x - s.players[s.me].x, s.players[t].y - s.players[s.me].y).toFixed(2)); }
    d.override = null;
    ok('mark_shadows_opponent', { who: d.name, distances_m: dists.filter((_, i) => i % 3 === 0 || i === dists.length - 1) }, dists.length > 5 && dists.slice(-6).sort((a, b) => a - b)[2] < 3.0);
    done = true;
  }
  if (!done) ok('mark_shadows_opponent', 'no defending moment found', false);
}
// CALL: when a teammate (bot) has the ball, tapping CALL should make them pass to you
{
  let tries = 0, done = false;
  while (!done && tries++ < 60) {
    await sleep(300);
    const c = all.find(x => { const s = x.last; return s && s.owner >= 0 && s.owner !== s.me && Math.floor(s.owner / PLAYERS_PER_TEAM) === Math.floor(s.me / PLAYERS_PER_TEAM) && !s.players[s.owner].human && s.owner % PLAYERS_PER_TEAM !== 0; });
    if (!c) continue;
    const carrier = c.last.owner, nEv = c.events.length;
    let pressed = 0; c.override = () => (pressed++ < 2 ? { mx: 0, my: 0, b: BTN_CALL } : { mx: 0, my: 0, b: 0 });
    let got = null; const t0c = Date.now();
    while (Date.now() - t0c < 3000 && !got) {
      await sleep(50); const s = c.last;
      if (s.owner === s.me) got = 'received';
      else if (s.owner !== carrier) { const dx = s.players[s.me].x - s.ball.x, dy = s.players[s.me].y - s.ball.y, L = Math.hypot(dx, dy) || 1, sp = Math.hypot(s.ball.vx, s.ball.vy) || 1; if ((dx * s.ball.vx + dy * s.ball.vy) / (L * sp) > 0.8 && sp > 4) got = 'ball travelling to caller'; }
    }
    c.override = null;
    const ev = c.events.slice(nEv).find(e => e.k === 'call');
    ok('call_for_pass', { caller: c.name, carrierWasBot: carrier, event: !!ev, result: got, ms: Date.now() - t0c }, !!ev && !!got);
    done = true;
  }
  if (!done) ok('call_for_pass', 'no moment where a teammate bot had the ball', false);
}
const syncCheck = () => { const sts = all.map(b => b.last); const tickSpread = Math.max(...sts.map(s => s.tick)) - Math.min(...sts.map(s => s.tick)); return { tickSpread, scores: sts.map(s => s.score.join('-')), ballSpread: Math.max(...sts.map(s => Math.hypot(s.ball.x - sts[0].ball.x, s.ball.y - sts[0].ball.y))).toFixed(2) }; };
// play until full time
let fullAt = 0, maxWait = (HALF * 2 + 30) * 1000;
const syncs = [];
while (Date.now() - t0 < maxWait) { await sleep(2000); syncs.push(syncCheck()); if (host.events.some(e => e.k === 'full')) { fullAt = Date.now(); break; } }
const goals = host.events.filter(e => e.k === 'goal');
ok('sync_during_match', syncs.slice(-3), syncs.every(s => s.tickSpread <= 6 && new Set(s.scores).size <= 2));
ok('goals_scored', goals.map(g => ({ team: g.team, by: g.name || ('bot#' + g.p), line: g.line, score: g.score.join('-') })), goals.length > 0);
ok('halftime_seen', host.events.some(e => e.k === 'half'), host.events.some(e => e.k === 'half'));
const full = host.events.find(e => e.k === 'full');
ok('full_time', full ? { score: full.score.join('-'), afterSec: ((fullAt - t0) / 1000).toFixed(0) } : null, !!full && all.every(b => b.events.some(e => e.k === 'full')));
ok('final_score_agrees', all.map(b => b.last.score.join('-')), new Set(all.map(b => b.last.score.join('-'))).size === 1 && full && full.score.join('-') === host.last.score.join('-'));
// rematch: a non-host votes, then the host
if (others[0]) { others[0].send({ t: 'rematch' }); await sleep(600); ok('rematch_vote_recorded', host.room.rematch.length, host.room.rematch.length === 1); }
host.send({ t: 'rematch' }); await sleep(2000);
ok('rematch_restarts', { state: host.last.state, score: host.last.score.join('-'), clock: host.last.clock }, host.last.state !== ST.FULLTIME && host.last.score[0] + host.last.score[1] === 0);
// late join mid-match takes over a bot
const late = new Bot('LateSeyi'); await late.open(); late.send({ t: 'join', code }); await sleep(1500);
ok('late_join_takes_bot_slot', late.match && late.match.me, late.match && late.match.me >= 0);
// a dropped connection keeps the seat: close one client's socket, reconnect with its token
if (others[0]) {
  const o = others[0], seat = o.match.me; o.stop(); o.ws.terminate(); await sleep(1500);
  o.match = null; await o.open(); await sleep(1500);
  ok('reconnect_keeps_seat', { before: seat, after: o.match && o.match.me, rejoined: o.rejoined }, !!o.rejoined && o.match && o.match.me === seat);
}
const pingAvg = all.map(b => b.pings.length ? Math.round(b.pings.reduce((a, c) => a + c, 0) / b.pings.length) : null);
results.ping_ms_avg = pingAvg;
const secs = (Date.now() - t0) / 1000; results.snapshot_rate_hz = all.map(b => (b.snaps / ((Date.now() - b.firstSnapAt) / 1000)).toFixed(1));
log('ping avg ms', pingAvg, 'snap Hz', results.snapshot_rate_hz);
[...all, late].forEach(b => { b.stop(); b.ws.close(); });
console.log('RESULT ' + JSON.stringify(results));
process.exit(results.failed ? 1 : 0);
