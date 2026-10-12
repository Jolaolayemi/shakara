// SHAKARA client: draws the game, reads your thumbs/keys, and talks to the server.
// Big picture: the SERVER runs the real match. This file (1) sends your inputs, (2) receives
// snapshots 15 times a second, (3) smoothly animates between them, and (4) moves YOUR player
// instantly on your own screen ("prediction") so the game feels responsive on slow data.
import { TICK_HZ, DT, SNAP_EVERY, HALF_W, HALF_H, GOAL_HALF, GOAL_DEPTH, GOAL_HEIGHT, CHAMFER, PLAYERS_PER_TEAM,
  BTN_PASS, BTN_SHOOT, BTN_SPRINT, BTN_TACKLE, BTN_MARK, BTN_CALL, MARK_SPEED, markInput, markTarget, ST, LINES, makePlayer, movePlayer, len, clamp, BOX_DEPTH, BOX_HALF } from './shared/sim.js?v=__V__';

// ---------- theme (swap here when the brand pack lands) ----------
// SHAKARA palette from the brand pack (look/palette.json). Team names, kit colours and pitch colours live here.
const THEME = {
  teams: [
    { name: 'Lagos Lions', short: 'LIONS', style: 'panels', sock: '#FFC72C', shirt: '#FFC72C', trim: '#140C1C', shorts: '#140C1C', gk: '#7A4FE0', mini: '#FFC72C', goalText: '#FFC72C' },
    { name: 'Aba Warriors', short: 'WARRIORS', style: 'sash', sock: '#008751', shirt: '#008751', trim: '#FFF4E0', shorts: '#FFF4E0', gk: '#7A4FE0', mini: '#2fd07f', goalText: '#2fd07f' },
  ],
  pitch: '#D9763F', pitchLight: '#E8925A', chalk: 'rgba(255,244,224,.82)',
  wall: '#8C4A2F', wallTop: '#a85e3d', danfo: '#FFC72C', night: '#140C1C', pink: '#FF4F8B',
};
const SKIN = ['#5a3420', '#6b3e26', '#4a2a19', '#7a4a2e', '#3d2215', '#8a5636', '#5f3822', '#4f2d1b', '#734429', '#6a3b22'];
const HAIR = [0, 1, 2, 3, 1, 0, 2, 3, 4, 1];

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const TICK_MS = 1000 / TICK_HZ;
const TILT = 0.78, ZK = 0.85;

// ---------- persistent nickname ----------
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let nick = LS.get('n5_nick', '');
if (!nick) { nick = 'Baller' + (100 + Math.floor(Math.random() * 900)); }
$('nick').value = LS.get('n5_nick', '') || '';
$('nick2').value = nick;
let token = sessionStorage.getItem('n5_tok') || '';

// ---------- coarse region ----------
const TZCC = { 'Africa/Lagos': 'NG', 'Africa/Accra': 'GH', 'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Douala': 'CM', 'Africa/Kigali': 'RW', 'Europe/London': 'GB', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA' };
const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
const langCC = ((navigator.language || '').split('-')[1] || '').toUpperCase();
const region = { tz, cc: TZCC[tz] || (/^[A-Z]{2}$/.test(langCC) ? langCC : '') };

// ---------- network ----------
let ws = null, myId = 0, room = null, matchInfo = null, connected = false, wantRoom = null, retry = 0, pendingAction = null;
const snaps = [];
let offset = null, jitter = 30, rtt = 0, lastPingSent = 0;
function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
function connect() {
  ws = new WebSocket(wsUrl()); ws.binaryType = 'arraybuffer';
  ws.onopen = () => { connected = true; retry = 0; send({ t: 'hello', name: nick, token, region }); };
  ws.onmessage = (e) => { if (typeof e.data === 'string') onJson(JSON.parse(e.data)); else onSnap(e.data); };
  ws.onclose = () => {
    connected = false;
    if (room) toast('Connection lost. Reconnecting…', 4000);
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
const inBuf = new ArrayBuffer(6), inView = new DataView(inBuf);
function sendInput(seq, inp) {
  if (!ws || ws.readyState !== 1) return;
  inView.setUint8(0, 2); inView.setUint16(1, seq, true);
  inView.setInt8(3, Math.round(clamp(inp.mx, -1, 1) * 127)); inView.setInt8(4, Math.round(clamp(inp.my, -1, 1) * 127)); inView.setUint8(5, inp.b);
  ws.send(inBuf);
}
setInterval(() => { if (connected) { lastPingSent = performance.now(); send({ t: 'ping', c: lastPingSent }); } }, 2000);

function onJson(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id; if (m.token) { token = m.token; sessionStorage.setItem('n5_tok', token); }
      if (m.rejoined) { toast('Back in the game ✔', 1500); break; }
      if (room) { // seat expired or the server restarted: rejoin (or re-open) the same room code
        const code = room.code; room = null; matchInfo = null; send({ t: 'join', code, recreate: true });
      } else if (pendingAction) { send(pendingAction); pendingAction = null; }
      else if (wantRoom) { send({ t: 'join', code: wantRoom }); wantRoom = null; }
      break;
    case 'pong': rtt = performance.now() - m.c; break;
    case 'error': toast(m.msg, 3500); $('homeMsg').textContent = m.msg; if (!room) show('home'); break;
    case 'quick': if (!m.found) toast('No open rooms nearby yet. You host this one: share the code or start with bots.', 4500); break;
    case 'room': onRoom(m); break;
    case 'match': onMatch(m); break;
    case 'ev': setTimeout(() => onEvent(m), interpDelay()); break;
  }
}

// ---------- screens ----------
let screen = 'home';
function show(s) {
  screen = s;
  $('home').classList.toggle('hidden', s !== 'home');
  $('lobby').classList.toggle('hidden', s !== 'lobby');
  $('hud').classList.toggle('hidden', s !== 'game' && s !== 'ft');
  $('ft').classList.toggle('hidden', s !== 'ft');
  $('touch').classList.toggle('hidden', !(isTouch && s === 'game'));
  checkRotate();
}
function checkRotate() {
  const portrait = innerHeight > innerWidth;
  $('rotate').classList.toggle('hidden', !(isTouch && portrait && (screen === 'game')));
}
let toastT = 0;
function toast(msg, ms = 2500) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }

function shareLink() { return location.origin + '/?room=' + (room ? room.code : ''); }
function shareText() { return `Oya come play 5-a-side with me! ⚽🇳🇬 Room ${room ? room.code : ''}: ${shareLink()}`; }

function onRoom(r) {
  const first = !room || room.code !== r.code;
  room = r;
  if (first) history.replaceState(null, '', '?room=' + r.code);
  $('roomCode').textContent = r.code;
  const me = r.players.find(p => p.id === myId);
  const isHost = r.host === myId;
  for (const t of [0, 1]) {
    const ul = $(t ? 'slotsB' : 'slotsA'); ul.innerHTML = '';
    const li0 = document.createElement('li'); li0.className = 'bot'; li0.innerHTML = '<span>Keeper</span><em>GK BOT</em>'; ul.appendChild(li0);
    const ps = r.players.filter(p => p.team === t);
    for (let i = 0; i < 4; i++) {
      const p = ps[i], li = document.createElement('li');
      if (p) {
        li.className = p.id === myId ? 'me' : '';
        const s = document.createElement('span'); s.textContent = p.name; li.appendChild(s);
        const em = document.createElement('em');
        if (p.away) em.textContent = 'RECONNECTING'; else if (p.id === myId) { em.textContent = p.id === r.host ? 'YOU · HOST' : 'YOU'; em.className = 'you'; } else if (p.id === r.host) { em.textContent = 'HOST'; em.className = 'host'; }
        if (em.textContent) li.appendChild(em);
      } else { li.className = 'bot'; li.innerHTML = '<span>Bot go fill am</span><em>OPEN</em>'; }
      ul.appendChild(li);
    }
  }
  document.querySelectorAll('.join').forEach(b => { b.classList.toggle('hidden', !me || me.team === +b.dataset.team); });
  $('hostCtl').classList.toggle('hidden', !isHost);
  $('waitMsg').classList.toggle('hidden', isHost);
  $('waitMsg').textContent = r.inMatch ? 'Match in progress…' : 'Waiting for the host to start…';
  $('halfLen').value = String(r.halfLen); $('pub').checked = r.public;
  $('bStart').textContent = r.inMatch ? 'IN MATCH' : 'START ▶';
  if (!r.inMatch) { matchInfo = null; snaps.length = 0; if (screen !== 'home') show('lobby'); }
  else if (screen === 'home' || screen === 'lobby') { if (matchInfo) show('game'); }
  if (screen === 'ft') {
    const votes = r.rematch.length, n = r.players.filter(p => !p.away).length;
    $('rmMsg').textContent = votes ? `${votes}/${n} want a rematch${isHost ? '' : '. Host can start it.'}` : '';
  }
  $('bToLobby').classList.toggle('hidden', !isHost);
  if (screen === 'home') show(r.inMatch && matchInfo ? 'game' : 'lobby');
}
function onMatch(m) {
  const fresh = !matchInfo;
  matchInfo = m;
  if (fresh) { snaps.length = 0; pred = null; pending.length = 0; }
  if (screen !== 'game' && screen !== 'ft') show('game');
}

// ---------- events / banners ----------
let bannerT = 0, shake = 0, tickerT = 0;
function ticker(text, ms = 2200) { const t = $('ticker'); t.textContent = text; t.classList.remove('hidden'); clearTimeout(tickerT); tickerT = setTimeout(() => t.classList.add('hidden'), ms); }
function banner(big, small, ms = 2600, color) {
  $('bnCard').classList.add('hidden');
  $('bnBig').textContent = big; $('bnSmall').textContent = small || '';
  $('bnBig').style.color = color || '';
  const b = $('banner'); b.classList.remove('hidden'); b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.add('hidden'), ms);
}
function onEvent(e) {
  if (e.k === 'goal') {
    const tm = THEME.teams[e.team];
    banner('GOAL!', LINES.goal[e.line] || 'E don enter!', 3200, tm.goalText); // the Pidgin lines live in shared/sim.js (LINES)
    const mm = Math.floor((renderState ? renderState.clock : 0) / 60), ss = Math.floor((renderState ? renderState.clock : 0) % 60);
    $('bcName').textContent = e.own ? 'OWN GOAL' : (e.name || tm.short + ' BOT');
    $('bcSub').textContent = `${tm.name} · ${mm}:${String(ss).padStart(2, '0')} left`;
    $('bcScore').textContent = `${e.score[0]} – ${e.score[1]}`;
    $('bnCard').classList.remove('hidden');
    shake = 0.6; sfx.goal(); burst(e.team);
  } else if (e.k === 'kickoff') { ticker(LINES.kickoff[e.line]); sfx.whistle(1); }
  else if (e.k === 'call') {
    const st = renderState; const me = st ? st.me : -1;
    const myTeam = me >= 0 ? Math.floor(me / PLAYERS_PER_TEAM) : -1;
    if (Math.floor(e.p / PLAYERS_PER_TEAM) !== myTeam) return; // only your own team sees the call
    callIcon = { idx: e.p, until: performance.now() + 2200 };
    if (e.to === me) {
      localCall = { from: e.p, until: performance.now() + 2200 };
      ticker(`${e.name || 'Your teammate'} dey call for ball! Press PASS`, 2000);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      $('tPass').classList.add('flash'); setTimeout(() => $('tPass').classList.remove('flash'), 2200);
    } else if (e.p === me) ticker('You called for the ball', 1200);
  }
  else if (e.k === 'save') { ticker((e.name ? e.name + ': ' : '') + LINES.save[e.line]); }
  else if (e.k === 'half') { banner('HALF TIME', LINES.half[e.line], 3500); sfx.whistle(2); }
  else if (e.k === 'full') {
    sfx.whistle(3);
    banner('FULL TIME', '', 1500);
    setTimeout(() => {
      $('ftA').textContent = e.score[0]; $('ftB').textContent = e.score[1];
      const w = e.score[0] === e.score[1] ? 'Draw! Nobody go home happy.' : `${THEME.teams[e.score[0] > e.score[1] ? 0 : 1].short} win am!`;
      $('ftLine').textContent = `${LINES.full[e.line]} ${w}`;
      $('rmMsg').textContent = '';
      show('ft');
    }, 1500);
  }
}

// ---------- snapshots ----------
function onSnap(ab) {
  const v = new DataView(ab); let o = 0;
  if (v.getUint8(o++) !== 1) return;
  const s = { tick: v.getUint32(o, true) }; o += 4;
  s.state = v.getUint8(o++); s.half = v.getUint8(o++); s.clock = v.getUint16(o, true) / 10; o += 2;
  s.score = [v.getUint8(o++), v.getUint8(o++)]; const ow = v.getUint8(o++); s.owner = ow === 255 ? -1 : ow;
  const i16 = () => { const x = v.getInt16(o, true) / 100; o += 2; return x; };
  s.ball = { x: i16(), y: i16(), z: i16(), vx: i16(), vy: i16() };
  const n = v.getUint8(o++); s.players = [];
  for (let i = 0; i < n; i++) {
    const x = i16(), y = i16(); const face = v.getUint8(o++) / 255 * Math.PI * 2; const fl = v.getUint8(o++);
    s.players.push({ x, y, face, fl, vx: i16(), vy: i16() });
  }
  s.ack = v.getUint16(o, true); o += 2; const me = v.getUint8(o++); s.me = me === 255 ? -1 : me;
  s.stamina = v.getUint8(o++) / 255; s.tackleT = v.getUint8(o++) / 100; s.tackleCd = v.getUint8(o++) / 100; s.stunT = v.getUint8(o++) / 100; s.charge = v.getUint8(o++) / 255;
  const now = performance.now();
  const sample = now - s.tick * TICK_MS;
  if (offset === null || s.tick < (snaps.length ? snaps[snaps.length - 1].tick - 300 : 0)) { offset = sample; snaps.length = 0; }
  if (sample < offset) offset = sample; else { jitter += ((sample - offset) - jitter) * 0.05; offset += (sample - offset) * 0.003; }
  snaps.push(s); if (snaps.length > 40) snaps.shift();
  if (screen === 'ft' && s.state !== ST.FULLTIME) show('game');
  reconcile(s);
}
const interpDelay = () => clamp(SNAP_EVERY * TICK_MS * 1.6 + jitter * 1.4, 90, 320);

// ---------- local prediction ----------
let pred = null, pending = [], seq = 0, ackBtn = 0, markIdx = -1, callIcon = null, localCall = null, errX = 0, errY = 0, accum = 0;
const seqNewer = (a, b) => ((a - b) & 0xffff) < 0x8000 && a !== b;
function reconcile(s) {
  if (s.me < 0) { pred = null; return; }
  const a = s.players[s.me];
  const team = Math.floor(s.me / PLAYERS_PER_TEAM);
  const prevX = pred ? pred.x : a.x, prevY = pred ? pred.y : a.y;
  const p = makePlayer(s.me, team, s.me % PLAYERS_PER_TEAM);
  Object.assign(p, { x: a.x, y: a.y, vx: a.vx, vy: a.vy, face: a.face, stamina: s.stamina, tackleT: s.tackleT, tackleCd: s.tackleCd, stunT: s.stunT,
    charging: !!(a.fl & 8), charge: s.charge, sprinting: !!(a.fl & 1) });
  while (pending.length && !seqNewer(pending[0].seq, s.ack)) { ackBtn = pending[0].inp.b; pending.shift(); }
  p.prevBtn = ackBtn;
  const frozen = s.state !== ST.PLAY && s.state !== ST.GOAL;
  for (const q of pending) { movePlayer(p, q.sim || q.inp, DT, q.sim ? { ...q.sim.ctx, hasBall: s.owner === s.me, frozen } : { hasBall: s.owner === s.me, frozen }); pushOff(p, s); p.prevBtn = q.inp.b; }
  if (pred) {
    errX += prevX - p.x; errY += prevY - p.y;
    if (len(errX, errY) > 3) { errX = errY = 0; }
  }
  pred = p; lastSnap = s;
}
let lastSnap = null;
function pushOff(p, s) {
  for (let i = 0; i < s.players.length; i++) {
    if (i === p.i) continue; const q = s.players[i];
    const dx = p.x - q.x, dy = p.y - q.y, d = len(dx, dy);
    if (d > 0 && d < 1.1) { const k = (1.1 - d) / 2 / d; p.x += dx * k; p.y += dy * k; }
  }
}
function predictStep() {
  const inp = readInput();
  seq = (seq + 1) & 0xffff;
  sendInput(seq, inp);
  if (!pred || !lastSnap) return;
  const frozen = lastSnap.state !== ST.PLAY && lastSnap.state !== ST.GOAL;
  const hadBall = lastSnap.owner === lastSnap.me && !localKick;
  const sim = { mx: inp.mx, my: inp.my, b: inp.b, ctx: { hasBall: hadBall, frozen } };
  if ((inp.b & BTN_MARK) && !hadBall && !frozen) {
    // MARK: predict the same auto-shadowing the server does, using the newest positions we have
    const view = lastSnap.players.map((q, i) => i === pred.i ? pred : q);
    const team = Math.floor(pred.i / PLAYERS_PER_TEAM);
    const mk = markInput(view, pred.i, lastSnap.ball, lastSnap.owner, attackDir(team, lastSnap.half), markIdx);
    if (mk) { sim.mx = mk.mx; sim.my = mk.my; sim.ctx.faceTo = mk.faceTo; sim.ctx.speedMul = mk.speed; markIdx = mk.target; }
  } else markIdx = -1;
  pending.push({ seq, inp, sim }); if (pending.length > 90) pending.shift();
  const rising = movePlayer(pred, sim, DT, sim.ctx);
  pushOff(pred, lastSnap);
  // local charge mirror + kick prediction
  if (!frozen && hadBall) {
    if (inp.b & BTN_SHOOT) { pred.charging = true; pred.charge = Math.min(1, (pred.charge || 0) + DT / 0.9); }
    else if (pred.charging) { predictKick(true, pred.charge); pred.charging = false; pred.charge = 0; }
    if (rising & BTN_PASS) predictKick(false, 0, inp);
  }
  pred.prevBtn = inp.b;
}

// local kick prediction so passes/shots leave the foot instantly even at 300 ms ping
let localKick = null;
function predictKick(isShot, charge, inp) {
  const p = pred, view = renderState; if (!view) return;
  const team = Math.floor(p.i / PLAYERS_PER_TEAM);
  const dir = attackDir(team, view.half);
  let ang = (inp && len(inp.mx, inp.my) > 0.3) ? Math.atan2(inp.my, inp.mx) : p.face;
  let sp = 12, vz = 0.8;
  if (isShot) {
    const gx = dir * HALF_W; const toGoal = Math.atan2(-p.y, gx - p.x);
    let da = ang - toGoal; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) < 0.9) { const y = clamp(p.y + (Math.cos(ang) * dir > 0 ? Math.tan(ang) * (gx - p.x) : 0), -GOAL_HALF + 0.35, GOAL_HALF - 0.35); ang = Math.atan2(y - p.y, gx - p.x); }
    const c = clamp(charge, 0.15, 1); sp = 13 + c * 14; vz = 1.2 + c * 3.8;
  } else {
    let best = null, bs = -1e9;
    if (localCall && performance.now() < localCall.until) { best = view.players[localCall.from]; bs = 1e9; localCall = null; }
    if (!best) view.players.forEach((q, i) => {
      if (i === p.i || Math.floor(i / PLAYERS_PER_TEAM) !== team) return;
      const dx = q.x - p.x, dy = q.y - p.y, d = len(dx, dy); if (d < 2.5 || d > 34) return;
      const dot = (dx * Math.cos(ang) + dy * Math.sin(ang)) / d; if (dot < 0.35) return;
      let sc = dot * 3 - Math.abs(d - 12) * 0.08; if (i % PLAYERS_PER_TEAM === 0) sc -= 2.5;
      if (sc > bs) { bs = sc; best = q; }
    });
    if (best) { const tx = best.x + best.vx * 0.45, ty = best.y + best.vy * 0.45, d = len(tx - p.x, ty - p.y); sp = clamp(5.5 + d * 0.85, 8, 19); ang = Math.atan2(ty - p.y, tx - p.x); vz = d > 18 ? 3.2 : 0.6; }
  }
  const r = 0.75;
  localKick = { t: performance.now(), x: p.x + Math.cos(p.face) * r, y: p.y + Math.sin(p.face) * r, z: 0.05, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, vz, seenFree: 0 };
  p.kickFx = 0.25; sfx.kick(isShot ? 1 : 0.6);
}
function stepBallLocal(b, dt) {
  if (b.z > 0 || b.vz > 0) { b.vz -= 9.8 * dt; b.z += b.vz * dt; if (b.z <= 0) { b.z = 0; b.vz = b.vz < -1.5 ? -b.vz * 0.45 : 0; } }
  const sp = len(b.vx, b.vy); if (sp > 0) { const dec = b.z > 0.05 ? 0.15 * sp : 1.1 + 0.32 * sp; const n = Math.max(0, sp - dec * dt); b.vx *= n / sp; b.vy *= n / sp; }
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (Math.abs(b.y) > HALF_H - 0.15) { b.y = Math.sign(b.y) * (HALF_H - 0.15); b.vy *= -0.7; }
  if (Math.abs(b.x) > HALF_W - 0.15 && Math.abs(b.y) > GOAL_HALF) { b.x = Math.sign(b.x) * (HALF_W - 0.15); b.vx *= -0.7; }
}
const attackDir = (team, half) => ((team === 0) === (half === 1) ? 1 : -1);

// ---------- input ----------
const keys = new Set();
addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; keys.add(e.code); if (screen === 'game' && /Space|Arrow/.test(e.code)) e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const touch = { mx: 0, my: 0, pass: false, shoot: false, tackle: false, mark: false, call: false, id: null, cx: 0, cy: 0 };
function readInput() {
  let mx = 0, my = 0, b = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyJ') || keys.has('Space')) b |= BTN_PASS;
  if (keys.has('KeyK')) b |= BTN_SHOOT;
  if (keys.has('KeyX')) b |= BTN_MARK;
  if (keys.has('KeyC')) b |= BTN_CALL;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) b |= BTN_SPRINT;
  if (keys.has('KeyL') || keys.has('KeyE') || keys.has('KeyZ')) b |= BTN_TACKLE;
  if (touch.id !== null) { mx = touch.mx; my = touch.my; }
  if (touch.pass) b |= BTN_PASS; if (touch.shoot) b |= BTN_SHOOT; if (touch.tackle) b |= BTN_TACKLE | BTN_SPRINT; // one button: tap = tackle, hold = sprint
  if (touch.mark) b |= BTN_MARK; if (touch.call) b |= BTN_CALL;
  const m = len(mx, my); if (m > 1) { mx /= m; my /= m; }
  // screen y is squashed by the tilt: joystick up means up the pitch
  return { mx, my, b };
}
(function setupTouch() {
  const zone = $('stickZone'), base = $('stickBase'), knob = $('stickKnob'), R = 52;
  const home = () => { base.style.left = ''; base.style.top = ''; base.style.bottom = ''; knob.style.transform = ''; };
  zone.addEventListener('pointerdown', (e) => {
    if (touch.id !== null) return; touch.id = e.pointerId; zone.setPointerCapture(e.pointerId);
    const zr = zone.getBoundingClientRect();
    touch.cx = e.clientX; touch.cy = e.clientY;
    base.style.left = (e.clientX - zr.left - 65) + 'px'; base.style.top = (e.clientY - zr.top - 65) + 'px'; base.style.bottom = 'auto';
    tryFullscreen();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touch.id) return;
    let dx = e.clientX - touch.cx, dy = e.clientY - touch.cy; const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    const m = Math.min(1, d / R); const dz = m < 0.18 ? 0 : (m - 0.18) / 0.82;
    touch.mx = d ? dx / Math.min(d, R) * dz : 0; touch.my = d ? dy / Math.min(d, R) * dz : 0;
  });
  const end = (e) => { if (e.pointerId !== touch.id) return; touch.id = null; touch.mx = touch.my = 0; home(); };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  const btn = (id, key) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); touch[key] = true; el.classList.add('on'); if (navigator.vibrate) navigator.vibrate(12); });
    const up = () => { touch[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  btn('tPass', 'pass'); btn('tShoot', 'shoot'); btn('tTackle', 'tackle'); btn('tMark', 'mark'); btn('tCall', 'call');
})();
function tryFullscreen() {
  if (!isTouch || document.fullscreenElement) return;
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(() => window.screen?.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
}

// ---------- sound (synthesised, zero download) ----------
const sfx = (() => {
  let ac = null;
  const ctx = () => { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { } } if (ac && ac.state === 'suspended') ac.resume(); return ac; };
  addEventListener('pointerdown', ctx, { once: true }); addEventListener('keydown', ctx, { once: true });
  const noise = (dur, f, q, gain, attack = 0.005) => {
    const a = ac; if (!a || a.state !== 'running') return;
    const n = a.sampleRate * dur, b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const s = a.createBufferSource(); s.buffer = b; const fl = a.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = q;
    const g = a.createGain(); g.gain.setValueAtTime(0, a.currentTime); g.gain.linearRampToValueAtTime(gain, a.currentTime + attack); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    s.connect(fl).connect(g).connect(a.destination); s.start();
  };
  return {
    kick: (p = 1) => noise(0.12, 180, 1.2, 0.5 * p),
    whistle: (n = 1) => { const a = ac; if (!a || a.state !== 'running') return; for (let i = 0; i < n; i++) { const o = a.createOscillator(), g = a.createGain(); o.type = 'square'; o.frequency.value = 2900; const t = a.currentTime + i * 0.45; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.02); g.gain.setValueAtTime(0.06, t + (i === n - 1 ? 0.5 : 0.25)); g.gain.linearRampToValueAtTime(0, t + (i === n - 1 ? 0.55 : 0.3)); const lfo = a.createOscillator(), lg = a.createGain(); lfo.frequency.value = 40; lg.gain.value = 120; lfo.connect(lg).connect(o.frequency); o.connect(g).connect(a.destination); o.start(t); lfo.start(t); o.stop(t + 0.6); lfo.stop(t + 0.6); } },
    goal: () => { noise(2.6, 900, 0.4, 0.35, 0.4); noise(2.2, 2200, 0.6, 0.12, 0.3); },
  };
})();

// ---------- rendering ----------
const cv = $('cv'), g = cv.getContext('2d', { alpha: false });
const mini = $('mini'), mg = mini.getContext('2d');
let W = 0, H = 0, DPR = 1, S = 30, camX = 0, camY = 0, world = null, worldPPM = 0;
const MARGIN = 8;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2);
  W = Math.floor(innerWidth * DPR); H = Math.floor(innerHeight * DPR);
  cv.width = W; cv.height = H;
  const VW = isTouch ? 21 : 27; // EASY EDIT: camera zoom = metres of pitch across the screen (bigger = zoomed out)
  S = Math.max(W / VW, H / (13 * TILT));
  const ppm = Math.min(isTouch ? 32 : 36, Math.ceil(S));
  if (!world || Math.abs(ppm - worldPPM) > 4) buildWorld(ppm);
  checkRotate();
}
addEventListener('resize', resize); addEventListener('orientationchange', () => setTimeout(resize, 200));

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function buildWorld(ppm) {
  worldPPM = ppm;
  const WW = (HALF_W + MARGIN) * 2, WH = (HALF_H + MARGIN) * 2;
  const c = document.createElement('canvas'); c.width = Math.ceil(WW * ppm); c.height = Math.ceil(WH * ppm * TILT);
  const x = c.getContext('2d'); const R = rng(7);
  const P = (wx, wy) => [(wx + HALF_W + MARGIN) * ppm, (wy + HALF_H + MARGIN) * ppm * TILT];
  // surroundings: compound ground
  x.fillStyle = '#5b3424'; x.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 900; i++) { x.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,220,180,.06)'; const [a, b] = P(-HALF_W - MARGIN + R() * WW, -HALF_H - MARGIN + R() * WH); x.fillRect(a, b, ppm * (0.3 + R()), ppm * 0.3 * TILT); }
  // pitch
  const poly = [[-HALF_W + CHAMFER, -HALF_H], [HALF_W - CHAMFER, -HALF_H], [HALF_W, -HALF_H + CHAMFER], [HALF_W, HALF_H - CHAMFER], [HALF_W - CHAMFER, HALF_H], [-HALF_W + CHAMFER, HALF_H], [-HALF_W, HALF_H - CHAMFER], [-HALF_W, -HALF_H + CHAMFER]];
  x.beginPath(); poly.forEach(([a, b], i) => { const [px, py] = P(a, b); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.closePath();
  const [cx0, cy0] = P(0, 0);
  const gr = x.createRadialGradient(cx0, cy0, ppm * 4, cx0, cy0, ppm * 34); gr.addColorStop(0, THEME.pitchLight); gr.addColorStop(1, THEME.pitch);
  x.fillStyle = gr; x.fill();
  x.save(); x.clip();
  for (let i = 0; i < 3200; i++) { const [a, b] = P(-HALF_W + R() * 56, -HALF_H + R() * 34); x.fillStyle = R() < 0.55 ? 'rgba(110,45,15,.12)' : 'rgba(255,225,185,.12)'; const s = ppm * (0.04 + R() * 0.14); x.beginPath(); x.ellipse(a, b, s, s * TILT, 0, 0, 7); x.fill(); }
  // tyre marks / scuffs
  x.strokeStyle = 'rgba(110,50,20,.07)'; x.lineWidth = ppm * 0.18;
  for (let i = 0; i < 10; i++) { const [a, b] = P(-HALF_W + R() * 56, -HALF_H + R() * 34); const a0 = R() * 6; x.beginPath(); x.arc(a, b, ppm * (1 + R() * 2), a0, a0 + 0.7); x.stroke(); }
  // worn patches
  for (const [wx, wy, r] of [[-25, 0, 5], [25, 0, 5], [0, 0, 4], [-10, 6, 3], [12, -5, 3]]) { const [a, b] = P(wx, wy); const g2 = x.createRadialGradient(a, b, 1, a, b, r * ppm); g2.addColorStop(0, 'rgba(240,190,130,.35)'); g2.addColorStop(1, 'rgba(240,190,130,0)'); x.fillStyle = g2; x.fillRect(a - r * ppm, b - r * ppm, r * 2 * ppm, r * 2 * ppm); }
  // a few stones & a puddle-dry crack
  for (let i = 0; i < 40; i++) { const [a, b] = P(-HALF_W + R() * 56, -HALF_H + R() * 34); x.fillStyle = 'rgba(70,40,20,.35)'; x.beginPath(); x.ellipse(a, b, ppm * 0.12, ppm * 0.08, 0, 0, 7); x.fill(); }
  // chalk lines (hand drawn wobble)
  x.strokeStyle = THEME.chalk; x.lineWidth = Math.max(2, ppm * 0.12); x.lineCap = 'round';
  const line = (pts) => { x.beginPath(); pts.forEach(([a, b], i) => { const [px, py] = P(a + (R() - 0.5) * 0.08, b + (R() - 0.5) * 0.08); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); };
  line([[0, -HALF_H], [0, -6], [0, 6], [0, HALF_H]]);
  const circ = []; for (let a = 0; a <= 32; a++) circ.push([Math.cos(a / 32 * 6.283) * 4, Math.sin(a / 32 * 6.283) * 4]); line(circ);
  for (const sx of [-1, 1]) {
    line([[sx * HALF_W, -BOX_HALF], [sx * (HALF_W - BOX_DEPTH), -BOX_HALF], [sx * (HALF_W - BOX_DEPTH), BOX_HALF], [sx * HALF_W, BOX_HALF]]);
    const [a, b] = P(sx * (HALF_W - 5), 0); x.fillStyle = THEME.chalk; x.beginPath(); x.ellipse(a, b, ppm * 0.18, ppm * 0.18 * TILT, 0, 0, 7); x.fill();
  }
  { const [a, b] = P(0, 0); x.fillStyle = THEME.chalk; x.beginPath(); x.ellipse(a, b, ppm * 0.2, ppm * 0.2 * TILT, 0, 0, 7); x.fill(); }
  x.restore();
  // goals (back net on the ground + posts)
  for (const sx of [-1, 1]) {
    const [a0, b0] = P(sx * HALF_W, -GOAL_HALF), [a1, b1] = P(sx * (HALF_W + GOAL_DEPTH), GOAL_HALF);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(Math.min(a0, a1), b0, Math.abs(a1 - a0), b1 - b0);
    x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1;
    for (let k = 0; k <= 10; k++) { const yy = b0 + (b1 - b0) * k / 10; x.beginPath(); x.moveTo(a0, yy); x.lineTo(a1, yy); x.stroke(); }
    for (let k = 0; k <= 4; k++) { const xx = a0 + (a1 - a0) * k / 4; x.beginPath(); x.moveTo(xx, b0); x.lineTo(xx, b1); x.stroke(); }
  }
  // scenery top: buildings, crowd on rooftops, danfo, kiosk, generator
  const bTop = P(0, -HALF_H)[1];
  let bx = 0; const cols = ['#b8574a', '#4f7ca8', '#e0b25a', '#8b6bb0', '#5aa27a', '#c9c2b4', '#d07a3a'];
  while (bx < c.width) {
    const bw = ppm * (4 + R() * 5), bh = ppm * (2.4 + R() * 2.2);
    x.fillStyle = cols[Math.floor(R() * cols.length)]; x.fillRect(bx, bTop - ppm * 1.3 - bh, bw, bh);
    x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(bx, bTop - ppm * 1.3 - bh, bw, ppm * 0.25);
    for (let wx = bx + ppm * 0.6; wx < bx + bw - ppm * 0.8; wx += ppm * 1.4) { x.fillStyle = R() < 0.3 ? '#ffd27a' : 'rgba(20,20,30,.55)'; x.fillRect(wx, bTop - ppm * 1.3 - bh + ppm * 0.7, ppm * 0.7, ppm * 0.8); }
    // rooftop fans
    for (let k = 0; k < bw / ppm * 0.9; k++) { if (R() < 0.45) continue; const hx = bx + ppm * 0.4 + k * ppm * 1.05; const hy = bTop - ppm * 1.3 - bh - ppm * 0.25; x.fillStyle = ['#e2412d', '#f5c518', '#14874a', '#fff', '#1f6fd1', '#151515'][Math.floor(R() * 6)]; x.fillRect(hx - ppm * 0.22, hy - ppm * 0.1, ppm * 0.44, ppm * 0.5); x.fillStyle = SKIN[Math.floor(R() * SKIN.length)]; x.beginPath(); x.arc(hx, hy - ppm * 0.28, ppm * 0.2, 0, 7); x.fill(); }
    bx += bw + ppm * (0.2 + R() * 0.6);
  }
  // danfo bus + kiosk + generator in front of the buildings
  const danfo = (wx) => { const [a] = P(wx, 0); const y0 = bTop - ppm * 1.3; x.fillStyle = THEME.danfo; x.fillRect(a, y0 - ppm * 2.2, ppm * 5, ppm * 1.9); x.fillStyle = '#151515'; x.fillRect(a, y0 - ppm * 1.25, ppm * 5, ppm * 0.22); x.fillRect(a, y0 - ppm * 0.85, ppm * 5, ppm * 0.18); x.fillStyle = '#26323a'; for (let k = 0; k < 4; k++) x.fillRect(a + ppm * (0.3 + k * 1.15), y0 - ppm * 2.0, ppm * 0.9, ppm * 0.6); x.fillStyle = '#111'; x.beginPath(); x.arc(a + ppm, y0 - ppm * 0.25, ppm * 0.42, 0, 7); x.arc(a + ppm * 4, y0 - ppm * 0.25, ppm * 0.42, 0, 7); x.fill(); x.fillStyle = '#111'; x.font = `bold ${ppm * 0.42}px sans-serif`; x.fillText('OSHODI - OBALENDE', a + ppm * 0.2, y0 - ppm * 1.4); };
  danfo(-20); danfo(13);
  const kiosk = (wx, label) => { const [a] = P(wx, 0); const y0 = bTop - ppm * 1.3; x.fillStyle = '#2f6fb3'; x.fillRect(a, y0 - ppm * 2.4, ppm * 3, ppm * 2.4); x.fillStyle = '#f5c518'; x.fillRect(a - ppm * 0.2, y0 - ppm * 2.8, ppm * 3.4, ppm * 0.55); x.fillStyle = '#111'; x.font = `900 ${ppm * 0.38}px sans-serif`; x.fillText(label, a + ppm * 0.05, y0 - ppm * 2.42); x.fillStyle = '#ffe9b8'; x.fillRect(a + ppm * 0.4, y0 - ppm * 1.8, ppm * 2.2, ppm * 0.9); };
  kiosk(-6, 'MAMA T PROVISIONS'); kiosk(22, 'SUYA SPOT');
  { const [a] = P(4, 0); const y0 = bTop - ppm * 1.3; x.fillStyle = '#c0392b'; x.fillRect(a, y0 - ppm * 1.0, ppm * 1.5, ppm * 1.0); x.fillStyle = '#333'; x.fillRect(a + ppm * 0.2, y0 - ppm * 0.8, ppm * 0.6, ppm * 0.5); x.fillStyle = '#222'; x.fillRect(a + ppm * 1.2, y0 - ppm * 1.5, ppm * 0.12, ppm * 0.5); }
  // top wall face with painted ads
  const [wl] = P(-HALF_W + CHAMFER, 0), [wr] = P(HALF_W - CHAMFER, 0);
  const wallH = ppm * 1.2 * ZK;
  x.fillStyle = THEME.wall; x.fillRect(wl, bTop - wallH, wr - wl, wallH);
  x.fillStyle = THEME.wallTop; x.fillRect(wl, bTop - wallH, wr - wl, ppm * 0.14); x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(wl, bTop - ppm * 0.12, wr - wl, ppm * 0.12);
  const ads = [['SHAKARA!', '#FFC72C', '#140C1C'], ['PURE WATER ₦50', '#1f6fd1', '#fff'], ['MAMA PUT • HOT AMALA', '#E2622B', '#fff'], ['OYA BALL!', '#008751', '#FFF4E0'], ['NO PEEING HERE', '#FFF4E0', '#c00'], ['VULCANIZER 24/7', '#140C1C', '#FFC72C'], ['ANKARA PALACE', '#FF4F8B', '#140C1C']];
  let ax = wl + ppm * 1; let ai = 0;
  while (ax < wr - ppm * 6) { const [t, bg, fg] = ads[ai++ % ads.length]; const aw = ppm * (t.length * 0.5 + 1); x.fillStyle = bg; x.fillRect(ax, bTop - wallH + ppm * 0.15, aw, wallH - ppm * 0.35); x.fillStyle = fg; x.font = `${ppm * 0.5}px Bungee, 'Arial Black', sans-serif`; x.fillText(t, ax + ppm * 0.5, bTop - ppm * 0.35); ax += aw + ppm * 2.5; }
  // side + bottom wall tops
  x.strokeStyle = THEME.wallTop; x.lineWidth = ppm * 0.35;
  x.beginPath(); [[-HALF_W + CHAMFER, HALF_H], [HALF_W - CHAMFER, HALF_H]].forEach(([a, b], i) => { const [px, py] = P(a, b + 0.2); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  x.beginPath(); [[HALF_W - CHAMFER, -HALF_H], [HALF_W + 0.2, -HALF_H + CHAMFER], [HALF_W + 0.2, -GOAL_HALF]].forEach(([a, b], i) => { const [px, py] = P(a, b); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  x.beginPath(); [[HALF_W + 0.2, GOAL_HALF], [HALF_W + 0.2, HALF_H - CHAMFER], [HALF_W - CHAMFER, HALF_H + 0.2]].forEach(([a, b], i) => { const [px, py] = P(a, b); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  x.beginPath(); [[-HALF_W + CHAMFER, -HALF_H], [-HALF_W - 0.2, -HALF_H + CHAMFER], [-HALF_W - 0.2, -GOAL_HALF]].forEach(([a, b], i) => { const [px, py] = P(a, b); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  x.beginPath(); [[-HALF_W - 0.2, GOAL_HALF], [-HALF_W - 0.2, HALF_H - CHAMFER], [-HALF_W + CHAMFER, HALF_H + 0.2]].forEach(([a, b], i) => { const [px, py] = P(a, b); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  // bottom: spectators on plastic chairs + umbrellas
  const [, bb] = P(0, HALF_H + 1.2);
  for (let i = 0; i < 46; i++) { const [a] = P(-HALF_W + 1 + R() * 54, 0); const yy = bb + R() * ppm * 3 * TILT; x.fillStyle = ['#e2412d', '#1f6fd1', '#f5c518', '#fff', '#14874a'][Math.floor(R() * 5)]; x.fillRect(a - ppm * 0.25, yy, ppm * 0.5, ppm * 0.45); x.fillStyle = SKIN[Math.floor(R() * SKIN.length)]; x.beginPath(); x.arc(a, yy - ppm * 0.12, ppm * 0.2, 0, 7); x.fill(); }
  for (const ux of [-18, 2, 19]) { const [a] = P(ux, 0); x.fillStyle = '#e2412d'; x.beginPath(); x.ellipse(a, bb + ppm * 1.2, ppm * 1.6, ppm * 0.7, 0, 0, 7); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.ellipse(a, bb + ppm * 1.2, ppm * 0.6, ppm * 0.7, 0, 0, 7); x.fill(); }
  world = c;
}

function W2S(x, y, z = 0) { return [(x - camX) * S + W / 2, (y - camY) * S * TILT + H / 2 - z * S * ZK]; }

// interpolated view
let renderState = null;
function sampleState(now) {
  if (snaps.length === 0) return null;
  const t = (now - offset - interpDelay()) / TICK_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  if (t >= b.tick) { a = b; } else {
    for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].tick <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const k = a === b ? 0 : clamp((t - a.tick) / (b.tick - a.tick), 0, 1);
  const L = (u, v) => u + (v - u) * k;
  const LA = (u, v) => { let d = v - u; while (d > Math.PI) d -= 6.2832; while (d < -Math.PI) d += 6.2832; return u + d * k; };
  const players = a.players.map((p, i) => { const q = b.players[i] || p; return { x: L(p.x, q.x), y: L(p.y, q.y), vx: q.vx, vy: q.vy, face: LA(p.face, q.face), fl: (k < 0.5 ? p : q).fl }; });
  const big = len(a.ball.x - b.ball.x, a.ball.y - b.ball.y) > 6; // teleport (kickoff)
  const ball = big ? { ...b.ball } : { x: L(a.ball.x, b.ball.x), y: L(a.ball.y, b.ball.y), z: L(a.ball.z, b.ball.z), vx: b.ball.vx, vy: b.ball.vy };
  return { tick: t, state: b.state, half: b.half, clock: b.clock, score: b.score, owner: (k < 0.5 ? a : b).owner, players, ball, me: b.me, charge: b.charge, stamina: b.stamina };
}

const parts = [];
function burst(team) {
  const col = team === 0 ? ['#14874a', '#fff'] : ['#f5c518', '#151515'];
  const gx = attackDir(team, renderState ? renderState.half : 1) * HALF_W;
  for (let i = 0; i < 70; i++) parts.push({ x: gx, y: (Math.random() - 0.5) * 5, z: 1 + Math.random(), vx: -Math.sign(gx) * Math.random() * 6, vy: (Math.random() - 0.5) * 8, vz: 3 + Math.random() * 6, life: 1.6 + Math.random(), c: col[i % 2] });
}
let ballSpin = 0, lastBallX = 0, lastBallY = 0, prevKick = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - (frame.last || now)) / 1000); frame.last = now;
  // fixed-step input + prediction
  if (screen === 'game' && matchInfo) { accum += dt; let n = 0; while (accum >= DT && n < 4) { predictStep(); accum -= DT; n++; } if (n === 4) accum = 0; }
  else accum = 0;
  if (screen !== 'game' && screen !== 'ft') { drawIdle(now); return; }
  const st = sampleState(now); if (!st) { drawIdle(now); return; }
  renderState = st;
  // local player: predicted position with smoothed correction
  errX *= Math.pow(0.0005, dt); errY *= Math.pow(0.0005, dt);
  const me = st.me;
  if (pred && me >= 0) { const p = st.players[me]; p.x = pred.x + errX; p.y = pred.y + errY; p.face = pred.face; p.vx = pred.vx; p.vy = pred.vy; if (pred.tackleT > 0) p.fl |= 2; if (pred.charging) p.fl |= 8; }
  // ball: glued to my predicted feet when I own it; local kick projection right after I kick
  let ball = st.ball;
  if (localKick) {
    const lk = localKick; stepBallLocal(lk, dt);
    const age = now - lk.t;
    const latestOwner = lastSnap ? lastSnap.owner : -1;
    if (st.owner !== me) lk.seenFree += dt;
    if (lk.seenFree > 0) { const k = clamp(lk.seenFree / 0.25, 0, 1); ball = { x: lk.x + (st.ball.x - lk.x) * k, y: lk.y + (st.ball.y - lk.y) * k, z: lk.z + (st.ball.z - lk.z) * k }; if (k >= 1) localKick = null; }
    else ball = lk;
    if (age > rtt + interpDelay() + 600 && latestOwner === me) localKick = null; // server never took the kick
    if (age > 2500) localKick = null;
  } else if (me >= 0 && st.owner === me && pred) {
    const p = st.players[me], r = 0.72 + Math.min(0.25, len(p.vx, p.vy) * 0.03);
    ball = { x: p.x + Math.cos(p.face) * r, y: p.y + Math.sin(p.face) * r, z: 0 };
  }
  // camera
  const focus = me >= 0 ? st.players[me] : ball;
  // close overhead camera: aim between you and the ball, a little ahead of the ball's travel, smoothed
  let tx = me >= 0 ? (focus.x + ball.x) / 2 : ball.x, ty = me >= 0 ? (focus.y + ball.y) / 2 : ball.y;
  tx += clamp((ball.vx || 0) * 0.12, -2.5, 2.5); ty += clamp((ball.vy || 0) * 0.08, -1.5, 1.5);
  // keep the ball on screen even when you're far from it
  const hvw = W / 2 / S * 0.8, hvh = H / 2 / (S * TILT) * 0.75;
  tx = clamp(tx, ball.x - hvw, ball.x + hvw); ty = clamp(ty, ball.y - hvh, ball.y + hvh);
  camX += (tx - camX) * Math.min(1, dt * 3.5); camY += (ty - camY) * Math.min(1, dt * 3.5);
  const halfVW = W / 2 / S, halfVH = H / 2 / (S * TILT);
  camX = clamp(camX, -HALF_W - MARGIN + halfVW, HALF_W + MARGIN - halfVW); camY = clamp(camY, -HALF_H - MARGIN + halfVH + 1.5, HALF_H + MARGIN - halfVH);
  if (halfVW * 2 > (HALF_W + MARGIN) * 2) camX = 0;
  let sx = 0, sy = 0; if (shake > 0) { shake -= dt; sx = (Math.random() - 0.5) * 14 * shake * DPR; sy = (Math.random() - 0.5) * 14 * shake * DPR; }
  // world
  g.save(); g.translate(sx, sy);
  const scale = S / worldPPM;
  const wx0 = (camX + HALF_W + MARGIN) * worldPPM - W / 2 / scale, wy0 = (camY + HALF_H + MARGIN) * worldPPM * TILT - H / 2 / scale;
  g.fillStyle = '#5b3424'; g.fillRect(-20, -20, W + 40, H + 40);
  g.imageSmoothingEnabled = true;
  g.drawImage(world, wx0, wy0, W / scale, H / scale, 0, 0, W, H);
  // goal frames (posts + bar)
  for (const gx of [-HALF_W, HALF_W]) drawGoal(gx);
  // entities sorted by depth
  const ents = st.players.map((p, i) => ({ p, i, y: p.y }));
  ents.push({ ball: true, y: ball.y });
  ents.sort((a, b) => a.y - b.y);
  // shadows first
  for (const e of ents) { if (e.ball) continue; const [x, y] = W2S(e.p.x, e.p.y); g.fillStyle = 'rgba(40,15,0,.32)'; g.beginPath(); g.ellipse(x + S * 0.08, y + S * 0.04, S * 0.42, S * 0.2, 0, 0, 7); g.fill(); }
  { const [x, y] = W2S(ball.x, ball.y); g.fillStyle = 'rgba(40,15,0,.35)'; g.beginPath(); g.ellipse(x, y, S * 0.2 * (1 / (1 + ball.z * 0.3)), S * 0.1 / (1 + ball.z * 0.3), 0, 0, 7); g.fill(); }
  if (me >= 0) { const p = st.players[me]; const [x, y] = W2S(p.x, p.y); g.strokeStyle = '#FFC72C'; g.lineWidth = Math.max(2, S * 0.08); g.beginPath(); g.ellipse(x, y, S * 0.62, S * 0.62 * TILT, 0, 0, 7); g.stroke(); }
  // MARK: dashed pink ring under the opponent you're shadowing
  if (me >= 0 && markIdx >= 0 && st.players[markIdx]) { const q = st.players[markIdx]; const [x, y] = W2S(q.x, q.y); g.save(); g.setLineDash([S * 0.18, S * 0.12]); g.strokeStyle = THEME.pink; g.lineWidth = Math.max(2, S * 0.07); g.beginPath(); g.ellipse(x, y, S * 0.7, S * 0.7 * TILT, now / 400, 0, 7); g.stroke(); g.restore(); }
  const t = now / 1000;
  for (const e of ents) { if (e.ball) drawBall(ball, dt); else drawPlayer(e.p, e.i, st, t); }
  // CALL: bouncing PASS! bubble over the teammate who asked for the ball
  if (callIcon && now < callIcon.until && st.players[callIcon.idx]) {
    const q = st.players[callIcon.idx]; const bounce = Math.abs(Math.sin(now / 140)) * S * 0.35;
    const [x, y] = W2S(q.x, q.y, 3.0); const yy = y - bounce;
    g.font = `${Math.max(12, S * 0.42)}px Bungee, 'Arial Black', sans-serif`; g.textAlign = 'center';
    const w = g.measureText('PASS!').width + S * 0.4, h = S * 0.62;
    g.fillStyle = THEME.night; rr(x - w / 2 + 3, yy - h + 4, w, h, S * 0.16); g.fill();
    g.fillStyle = THEME.pink; rr(x - w / 2, yy - h, w, h, S * 0.16); g.fill();
    g.beginPath(); g.moveTo(x - S * 0.15, yy); g.lineTo(x + S * 0.15, yy); g.lineTo(x, yy + S * 0.22); g.fill();
    g.fillStyle = THEME.night; g.fillText('PASS!', x, yy - h * 0.25);
  } else if (callIcon && now >= callIcon.until) callIcon = null;
  // particles
  for (let i = parts.length - 1; i >= 0; i--) { const q = parts[i]; q.life -= dt; if (q.life <= 0) { parts.splice(i, 1); continue; } q.vz -= 9.8 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.z = Math.max(0, q.z + q.vz * dt); const [x, y] = W2S(q.x, q.y, q.z); g.fillStyle = q.c; g.fillRect(x, y, S * 0.15, S * 0.09); }
  // off-screen pointer to ball
  const [bxs, bys] = W2S(ball.x, ball.y, ball.z);
  if (bxs < 0 || bxs > W || bys < 0 || bys > H) { const ax = clamp(bxs, 24 * DPR, W - 24 * DPR), ay = clamp(bys, 60 * DPR, H - 24 * DPR); g.fillStyle = '#fff'; g.beginPath(); g.arc(ax, ay, 9 * DPR, 0, 7); g.fill(); g.strokeStyle = '#111'; g.lineWidth = 2; g.stroke(); }
  g.restore();
  hud(st);
}
function drawGoal(gx) {
  const s = Math.sign(gx), pw = Math.max(3, S * 0.12);
  const [x0, y0] = W2S(gx, -GOAL_HALF, GOAL_HEIGHT), [x1, y1] = W2S(gx, GOAL_HALF, GOAL_HEIGHT);
  const [bx0, by0] = W2S(gx + s * GOAL_DEPTH, -GOAL_HALF, GOAL_HEIGHT * 0.7), [bx1, by1] = W2S(gx + s * GOAL_DEPTH, GOAL_HALF, GOAL_HEIGHT * 0.7);
  const [f0x, f0y] = W2S(gx, -GOAL_HALF), [f1x, f1y] = W2S(gx, GOAL_HALF);
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
  for (let k = 0; k <= 8; k++) { const u = k / 8; g.beginPath(); g.moveTo(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u); g.lineTo(bx0 + (bx1 - bx0) * u, by0 + (by1 - by0) * u); g.stroke(); }
  g.beginPath(); g.moveTo(bx0, by0); g.lineTo(bx1, by1); g.stroke();
  g.strokeStyle = '#fafafa'; g.lineWidth = pw; g.lineCap = 'round';
  g.beginPath(); g.moveTo(f0x, f0y); g.lineTo(x0, y0); g.lineTo(x1, y1); g.lineTo(f1x, f1y); g.stroke();
}
function drawPlayer(p, i, st, t) {
  const team = Math.floor(i / PLAYERS_PER_TEAM), slot = i % PLAYERS_PER_TEAM, th = THEME.teams[team];
  const [x, y] = W2S(p.x, p.y);
  const spd = len(p.vx, p.vy), run = spd > 0.4 ? Math.sin(t * (8 + spd * 1.6) + i) : 0;
  const u = S * ZK; // pixels per metre of height
  const tackling = p.fl & 2, stunned = p.fl & 4;
  const cf = Math.cos(p.face), sf = Math.sin(p.face);
  g.save(); g.translate(x, y); g.scale(1.2, 1.2);
  if (tackling) { g.rotate(cf * 0.9); }
  if (stunned) { g.rotate(Math.sin(t * 20) * 0.15); }
  // legs
  g.fillStyle = SKIN[i % SKIN.length];
  const lw = S * 0.13, lh = u * 0.5;
  g.fillRect(-S * 0.16 + run * S * 0.08, -lh, lw, lh); g.fillRect(S * 0.03 - run * S * 0.08, -lh, lw, lh);
  // socks
  g.fillStyle = slot === 0 ? '#7A4FE0' : th.sock;
  g.fillRect(-S * 0.16 + run * S * 0.08, -lh * 0.55, lw, lh * 0.45); g.fillRect(S * 0.03 - run * S * 0.08, -lh * 0.55, lw, lh * 0.45);
  // boots
  g.fillStyle = slot === 0 ? '#222' : (i % 3 ? '#111' : '#f5f5f5');
  g.fillRect(-S * 0.18 + run * S * 0.08, -S * 0.06, lw + 2, S * 0.07); g.fillRect(S * 0.01 - run * S * 0.08, -S * 0.06, lw + 2, S * 0.07);
  // shorts
  g.fillStyle = slot === 0 ? '#140C1C' : th.shorts; g.fillRect(-S * 0.2, -u * 0.72, S * 0.4, u * 0.26);
  // shirt
  const shirt = slot === 0 ? th.gk : th.shirt;
  g.fillStyle = shirt; rr(-S * 0.24, -u * 1.32, S * 0.48, u * 0.64, S * 0.1); g.fill();
  if (slot === 0) { g.fillStyle = th.shirt; g.fillRect(-S * 0.24, -u * 1.08, S * 0.48, u * 0.09); }
  else if (th.style === 'sash') { g.save(); rr(-S * 0.24, -u * 1.32, S * 0.48, u * 0.64, S * 0.1); g.clip(); g.fillStyle = th.trim; g.beginPath(); g.moveTo(-S * 0.3, -u * 1.36); g.lineTo(-S * 0.08, -u * 1.36); g.lineTo(S * 0.3, -u * 0.74); g.lineTo(S * 0.08, -u * 0.66); g.closePath(); g.fill(); g.restore(); }
  else { g.fillStyle = th.trim; g.fillRect(-S * 0.24, -u * 1.3, S * 0.07, u * 0.6); g.fillRect(S * 0.17, -u * 1.3, S * 0.07, u * 0.6); g.fillRect(-S * 0.24, -u * 0.8, S * 0.48, u * 0.05); }
  g.strokeStyle = THEME.night; g.lineWidth = Math.max(1, S * 0.03); rr(-S * 0.24, -u * 1.32, S * 0.48, u * 0.64, S * 0.1); g.stroke();
  // arms swing
  g.fillStyle = SKIN[i % SKIN.length];
  g.fillRect(-S * 0.33, -u * 1.25 - run * u * 0.06, S * 0.1, u * 0.42); g.fillRect(S * 0.23, -u * 1.25 + run * u * 0.06, S * 0.1, u * 0.42);
  if (slot === 0) { g.fillStyle = '#f2f2f2'; g.fillRect(-S * 0.35, -u * 0.86 - run * u * 0.06, S * 0.14, S * 0.12); g.fillRect(S * 0.21, -u * 0.86 + run * u * 0.06, S * 0.14, S * 0.12); }
  // head (looks toward facing)
  const hx = cf * S * 0.05, hy = -u * 1.52;
  g.fillStyle = SKIN[i % SKIN.length]; g.beginPath(); g.arc(hx, hy, S * 0.19, 0, 7); g.fill();
  const hair = HAIR[i % HAIR.length];
  g.fillStyle = '#121212';
  if (hair === 0) { g.beginPath(); g.arc(hx, hy - S * 0.03, S * 0.19, Math.PI * 1.05, Math.PI * 1.95); g.fill(); }
  else if (hair === 1) { g.beginPath(); g.arc(hx, hy - S * 0.08, S * 0.17, Math.PI, 0); g.fill(); g.fillRect(hx - S * 0.05, hy - S * 0.32, S * 0.1, S * 0.12); }
  else if (hair === 2) { for (let k = -2; k <= 2; k++) { g.fillRect(hx + k * S * 0.07 - S * 0.025, hy - S * 0.27, S * 0.05, S * 0.14); } }
  else if (hair === 3) { g.fillStyle = '#e2412d'; g.beginPath(); g.arc(hx, hy - S * 0.06, S * 0.19, Math.PI, 0); g.fill(); }
  else { g.beginPath(); g.arc(hx, hy - S * 0.05, S * 0.23, Math.PI * 0.95, Math.PI * 2.05); g.fill(); }
  // eyes hint of direction
  if (sf > -0.3) { g.fillStyle = '#fff'; g.fillRect(hx + cf * S * 0.07 - S * 0.07, hy - S * 0.01, S * 0.04, S * 0.04); g.fillRect(hx + cf * S * 0.07 + S * 0.03, hy - S * 0.01, S * 0.04, S * 0.04); }
  g.restore();
  // labels for humans + charge bar
  const human = p.fl & 32;
  if (human || i === st.me) {
    const nm = i === st.me ? 'YOU' : ((matchInfo && matchInfo.names[i]) || '');
    if (nm) {
      g.font = `800 ${Math.max(10, S * 0.36)}px Rubik, system-ui, sans-serif`; g.textAlign = 'center';
      const ty = y - u * 2.3; const w = g.measureText(nm).width + S * 0.3;
      g.fillStyle = i === st.me ? '#FFC72C' : 'rgba(20,12,28,.7)'; rr(x - w / 2, ty - S * 0.36, w, S * 0.46, S * 0.12); g.fill();
      g.fillStyle = i === st.me ? '#111' : '#fff'; g.fillText(nm, x, ty);
    }
  }
  if (i === st.me && (p.fl & 8)) {
    const c = pred ? pred.charge || 0 : st.charge; const w = S * 1.1;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x - w / 2, y + S * 0.35, w, S * 0.14);
    g.fillStyle = c > 0.8 ? '#e2412d' : '#f5c518'; g.fillRect(x - w / 2, y + S * 0.35, w * c, S * 0.14);
  }
}
function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawBall(b, dt) {
  const [x, y] = W2S(b.x, b.y, b.z + 0.22);
  ballSpin += len(b.x - lastBallX, b.y - lastBallY) * 2.5; lastBallX = b.x; lastBallY = b.y;
  const r = S * 0.24;
  g.fillStyle = '#fbfbfb'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  g.fillStyle = '#1a1a1a';
  for (let k = 0; k < 3; k++) { const a = ballSpin + k * 2.094; const px = x + Math.cos(a) * r * 0.5, py = y + Math.sin(a) * r * 0.35; g.beginPath(); g.arc(px, py, r * 0.26, 0, 7); g.fill(); }
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
}
let lastHud = '';
let lastCtx = '';
function hud(st) {
  // attack / defend context: relabel and dim the buttons so the right ones stand out
  if (st.me >= 0) {
    const myTeam = Math.floor(st.me / PLAYERS_PER_TEAM);
    const ownerTeam = st.owner >= 0 ? Math.floor(st.owner / PLAYERS_PER_TEAM) : -1;
    const ctx = st.owner === st.me && !localKick ? 'ball' : ownerTeam === myTeam ? 'attack' : ownerTeam >= 0 ? 'defend' : 'loose';
    if (ctx !== lastCtx) {
      lastCtx = ctx;
      const lab = $('ctxLabel'); lab.textContent = { ball: 'YOUR BALL', attack: 'ATTACKING', defend: 'DEFENDING', loose: 'LOOSE BALL' }[ctx]; lab.className = 'ctx ' + ctx;
      $('tTackle').firstChild.textContent = ctx === 'ball' || ctx === 'attack' ? 'SPRINT' : 'TACKLE';
      $('tShoot').classList.toggle('dim', ctx !== 'ball'); $('tPass').classList.toggle('dim', ctx !== 'ball');
      $('tMark').classList.toggle('dim', ctx === 'ball' || ctx === 'attack');
      $('tCall').classList.toggle('dim', ctx !== 'attack');
      $('tMark').classList.toggle('hot', ctx === 'defend'); $('tCall').classList.toggle('hot', ctx === 'attack');
    }
  }
  const m = Math.floor(st.clock / 60), s = Math.floor(st.clock % 60);
  const key = `${st.score[0]}|${st.score[1]}|${m}:${s}|${st.half}`;
  if (key !== lastHud) {
    lastHud = key;
    $('sA').textContent = st.score[0]; $('sB').textContent = st.score[1];
    $('clock').textContent = `${m}:${String(s).padStart(2, '0')}`;
    $('half').textContent = st.half === 2 ? '2ND HALF' : '1ST HALF';
  }
  $('net').textContent = connected ? `${Math.round(rtt)} ms` : 'offline';
  const stam = pred ? pred.stamina : st.stamina; $('stamina').firstChild.style.width = (stam * 100).toFixed(0) + '%';
  // minimap
  const mw = mini.width, mh = mini.height, kx = mw / (HALF_W * 2 + 2), ky = mh / (HALF_H * 2 + 2);
  mg.fillStyle = 'rgba(20,12,28,.78)'; mg.fillRect(0, 0, mw, mh);
  mg.strokeStyle = 'rgba(255,255,255,.5)'; mg.strokeRect(kx, ky, HALF_W * 2 * kx, HALF_H * 2 * ky); mg.beginPath(); mg.moveTo(mw / 2, ky); mg.lineTo(mw / 2, mh - ky); mg.stroke();
  st.players.forEach((p, i) => { const tm = Math.floor(i / PLAYERS_PER_TEAM); mg.fillStyle = i === st.me ? '#fff' : THEME.teams[tm].mini; const r = i === st.me ? 3.2 : 2.2; mg.beginPath(); mg.arc((p.x + HALF_W + 1) * kx, (p.y + HALF_H + 1) * ky, r, 0, 7); mg.fill(); });
  mg.fillStyle = '#fff'; mg.fillRect((st.ball.x + HALF_W + 1) * kx - 1.5, (st.ball.y + HALF_H + 1) * ky - 1.5, 3, 3);
}
// idle background behind menus: slow pan over the pitch
function drawIdle(now) {
  if (!world) return;
  const t = now / 1000; camX = Math.sin(t * 0.07) * 12; camY = -2;
  const scale = S / worldPPM;
  const wx0 = (camX + HALF_W + MARGIN) * worldPPM - W / 2 / scale, wy0 = (camY + HALF_H + MARGIN) * worldPPM * TILT - H / 2 / scale;
  g.fillStyle = '#5b3424'; g.fillRect(0, 0, W, H);
  g.drawImage(world, wx0, wy0, W / scale, H / scale, 0, 0, W, H);
  for (const gx of [-HALF_W, HALF_W]) drawGoal(gx);
}

// ---------- UI wiring ----------
function saveNick(v) { nick = (v || '').trim().slice(0, 14) || nick; LS.set('n5_nick', nick); $('nick2').value = nick; }
function act(msg) {
  saveNick($('nick').value || nick); send({ t: 'name', name: nick });
  if (connected) send(msg); else { pendingAction = msg; toast('Connecting…', 1500); }
}
$('bCreate').onclick = () => act({ t: 'create', public: true });
$('bJoin').onclick = () => { const c = $('code').value.toUpperCase().replace(/[^A-Z]/g, ''); if (c.length !== 5) { $('homeMsg').textContent = 'Room codes have 5 letters.'; return; } act({ t: 'join', code: c }); };
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('bJoin').click(); });
$('bQuick').onclick = () => {
  $('homeMsg').textContent = 'Finding a game near you…';
  const go = () => { send({ t: 'region', region }); act({ t: 'quick' }); };
  if (navigator.geolocation && !region.lat) {
    let done = false; const fin = () => { if (!done) { done = true; go(); } };
    navigator.geolocation.getCurrentPosition((p) => { region.lat = Math.round(p.coords.latitude * 2) / 2; region.lon = Math.round(p.coords.longitude * 2) / 2; fin(); }, fin, { timeout: 5000, maximumAge: 3600e3, enableHighAccuracy: false });
    setTimeout(fin, 5500);
  } else go();
};
$('bLeave').onclick = () => { send({ t: 'leave' }); room = null; matchInfo = null; history.replaceState(null, '', '/'); show('home'); };
$('bMenu').onclick = () => { if (confirm('Leave this match?')) $('bLeave').onclick(); };
document.querySelectorAll('.join').forEach(b => b.onclick = () => send({ t: 'team', team: +b.dataset.team }));
$('nick2').addEventListener('change', () => { saveNick($('nick2').value); $('nick').value = nick; send({ t: 'name', name: nick }); });
$('halfLen').onchange = () => send({ t: 'settings', halfLen: +$('halfLen').value });
$('pub').onchange = () => send({ t: 'public', value: $('pub').checked });
$('bStart').onclick = () => { tryFullscreen(); send({ t: 'start', halfLen: +$('halfLen').value }); };
const waShare = () => { const u = 'https://wa.me/?text=' + encodeURIComponent(shareText()); if (navigator.share && isTouch) navigator.share({ title: 'Naija 5-a-side', text: shareText().replace(shareLink(), '').trim(), url: shareLink() }).catch(() => open(u, '_blank')); else open(u, '_blank'); };
$('bWa').onclick = waShare; $('bFtShare').onclick = waShare;
$('bCopy').onclick = () => { const l = shareLink(); (navigator.clipboard ? navigator.clipboard.writeText(l) : Promise.reject()).then(() => toast('Link copied: ' + l)).catch(() => prompt('Copy this link', l)); };
$('bRematch').onclick = () => { send({ t: 'rematch' }); $('rmMsg').textContent = 'Waiting for the others…'; };
$('bToLobby').onclick = () => send({ t: 'lobby' });

// team names everywhere on the page come from THEME above, so renaming a team is a one-line edit
(function applyTeamNames() {
  const [A, B] = THEME.teams;
  $('tAName').textContent = A.name.toUpperCase(); $('tBName').textContent = B.name.toUpperCase();
  document.querySelector('.join[data-team="0"]').textContent = 'JOIN ' + A.short; document.querySelector('.join[data-team="1"]').textContent = 'JOIN ' + B.short;
  $('hA').textContent = A.short; $('hB').textContent = B.short;
  document.querySelector('.ftScore .a').textContent = A.short; document.querySelector('.ftScore .b').textContent = B.short;
})();

// deep link ?room=CODE opens straight into the lobby
const qp = new URLSearchParams(location.search).get('room');
if (qp && /^[A-Za-z]{5}$/.test(qp)) { wantRoom = qp.toUpperCase(); $('code').value = wantRoom; $('homeMsg').textContent = 'Joining room ' + wantRoom + '…'; }
// expose for automated tests
window.__n5 = { get markIdx() { return markIdx; }, get callIcon() { return callIcon; }, get ctx() { return lastCtx; }, get err() { return Math.hypot(errX, errY); }, get pending() { return pending.length; }, get room() { return room; }, get snap() { return lastSnap; }, get pred() { return pred; }, get screen() { return screen; }, get rtt() { return rtt; } };
resize(); show('home'); connect(); requestAnimationFrame(frame);
// repaint the pitch ads once the brand font has arrived
if (document.fonts && document.fonts.load) document.fonts.load('20px Bungee').then(() => { world = null; resize(); }).catch(() => {});
