// SHAKARA shared rules: the pitch, the players, the ball, the bots.
// The SERVER runs this file for real (it is the referee). Your phone also uses movePlayer()
// from here so it can move your own player instantly while waiting for the server.
// Distances are in metres, speeds in metres per second, time in seconds.
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 2;            // snapshots at 15 Hz
export const HALF_W = 28, HALF_H = 17;  // EASY EDIT: half the pitch size, so the pitch is 56m x 34m inside the walls
export const GOAL_HALF = 2.5;           // goal mouth 5m wide
export const GOAL_DEPTH = 1.6;
export const GOAL_HEIGHT = 2.0;
export const CHAMFER = 2.2;
export const PLAYER_R = 0.55;
export const BALL_R = 0.15;
export const RUN = 6.2, SPRINT = 8.4, ACCEL = 9; // EASY EDIT: jog speed, sprint speed, how snappy turning feels
export const CONTROL_R = 0.95, GK_CONTROL_R = 1.05;
export const BOX_DEPTH = 7, BOX_HALF = 7;
export const PLAYERS_PER_TEAM = 5;      // slot 0 = keeper
export const MAX_HUMANS_PER_TEAM = 4;
export const BTN_PASS = 1, BTN_SHOOT = 2, BTN_SPRINT = 4, BTN_TACKLE = 8, BTN_MARK = 16, BTN_CALL = 32;
export const MARK_SPEED = 0.9;   // marking moves you at 90% speed
export const CALL_COOLDOWN = 2.5; // seconds between "pass it to me!" calls
export const CALL_WINDOW = 2.2;   // how long a call stays active
export const ST = { LOBBY: 0, KICKOFF: 1, PLAY: 2, GOAL: 3, HALFTIME: 4, FULLTIME: 5 };

// EASY EDIT: the Pidgin commentary. Add lines freely; one is picked at random each time.
export const LINES = {
  goal: ["GOAL! Na wa o!", "Who send you?!", "E don enter!", "Chai! Net don tear!",
         "Omo! See finishing!", "Keeper, where you dey?!", "Baba don score am!",
         "Gbas gbos! E enter!", "Na so dem dey do am!", "Ball don sleep for net!"],
  save: ["Keeper na wall!", "Mama mia, what a save!", "E no enter o!", "Hand of steel!"],
  kickoff: ["Oya, make una start!", "Ball dey roll!", "Una ready? Make we go!"],
  half: ["Half time! Make una drink water.", "Small break. Pure water time!"],
  full: ["Final whistle! Na so e be.", "E don finish! Who go buy suya?"],
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const len = (x, y) => Math.sqrt(x * x + y * y);

// --- walls: closed boundary with chamfered corners and goal openings ----------
function buildWalls() {
  const W = HALF_W, H = HALF_H, C = CHAMFER, G = GOAL_HALF, D = GOAL_DEPTH;
  const s = [];
  const seg = (ax, ay, bx, by, e = 0.72, kind = 'wall') => s.push({ ax, ay, bx, by, e, kind });
  seg(-W + C, -H, W - C, -H);           // top
  seg(W - C, -H, W, -H + C);            // corners
  seg(W, H - C, W - C, H);
  seg(W - C, H, -W + C, H);             // bottom
  seg(-W + C, H, -W, H - C);
  seg(-W, -H + C, -W + C, -H);
  // right side with goal opening
  seg(W, -H + C, W, -G); seg(W, G, W, H - C);
  seg(-W, H - C, -W, G); seg(-W, -G, -W, -H + C);
  // nets (soft)
  for (const sx of [1, -1]) {
    seg(sx * W, -G, sx * (W + D), -G, 0.25, 'net');
    seg(sx * (W + D), -G, sx * (W + D), G, 0.15, 'net');
    seg(sx * (W + D), G, sx * W, G, 0.25, 'net');
    seg(sx * W, -G, sx * W, G, 0.72, 'mouth'); // only solid when ball is above the bar
  }
  for (const w of s) { const dx = w.bx - w.ax, dy = w.by - w.ay, l = len(dx, dy); w.l2 = l * l; }
  return s;
}
export const WALLS = buildWalls();

// --- player movement (shared with client prediction) ----------------------
export function makePlayer(i, team, slot) {
  return { i, team, slot, gk: slot === 0, x: 0, y: 0, vx: 0, vy: 0, face: team === 0 ? 0 : Math.PI,
    stamina: 1, tackleT: 0, tackleCd: 0, stunT: 0, kickCd: 0, charge: 0, charging: false,
    sprinting: false, prevBtn: 0, kickFx: 0, callFrom: -1, callUntil: 0 };
}

// input: {mx, my, b}. ctx: {hasBall, frozen, speedMul}
export function movePlayer(p, inp, dt, ctx) {
  const rising = inp.b & ~p.prevBtn;
  p.tackleCd = Math.max(0, p.tackleCd - dt);
  p.kickCd = Math.max(0, p.kickCd - dt);
  p.kickFx = Math.max(0, p.kickFx - dt);
  if (ctx.frozen) { p.vx = p.vy = 0; p.sprinting = false; p.tackleT = 0; return rising; }
  let mx = inp.mx, my = inp.my;
  const m = len(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  if (p.stunT > 0) {
    p.stunT = Math.max(0, p.stunT - dt);
    p.vx *= 0.85; p.vy *= 0.85;
  } else if (p.tackleT > 0) {
    p.tackleT = Math.max(0, p.tackleT - dt);
    const sp = 10.5;
    p.vx = Math.cos(p.face) * sp; p.vy = Math.sin(p.face) * sp;
  } else {
    if ((rising & BTN_TACKLE) && !ctx.hasBall && p.tackleCd <= 0 && !p.gk) {
      p.tackleT = 0.32; p.tackleCd = 1.3;
      if (m > 0.2) p.face = Math.atan2(my, mx);
    }
    const wantSprint = (inp.b & BTN_SPRINT) && m > 0.2 && p.stamina > 0.05;
    p.sprinting = !!wantSprint;
    let sp = (wantSprint ? SPRINT : RUN) * (ctx.speedMul || 1);
    if (ctx.hasBall) sp *= 0.9;
    if (p.charging) sp *= 0.6;
    const tx = mx * sp, ty = my * sp;
    const k = Math.min(1, ACCEL * dt);
    p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;
    if (ctx.faceTo !== undefined || m > 0.2) {
      const want = ctx.faceTo !== undefined ? ctx.faceTo : Math.atan2(my, mx);
      let d = want - p.face; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      p.face += d * Math.min(1, 14 * dt);
    }
  }
  p.stamina = clamp(p.stamina + (p.sprinting ? -0.32 : 0.16) * dt, 0, 1);
  p.x += p.vx * dt; p.y += p.vy * dt;
  clampPlayer(p);
  return rising;
}

export function clampPlayer(p) {
  const r = PLAYER_R;
  p.x = clamp(p.x, -HALF_W + r, HALF_W - r);
  p.y = clamp(p.y, -HALF_H + r, HALF_H - r);
  // chamfer corners
  const lim = HALF_W + HALF_H - CHAMFER - r * 1.41;
  const s = Math.abs(p.x) + Math.abs(p.y);
  if (s > lim) {
    const ex = (s - lim) / 2;
    p.x -= Math.sign(p.x) * ex; p.y -= Math.sign(p.y) * ex;
  }
}

// --- MARK: auto-shadow an opponent (shared so the phone predicts it the same way) ---
// players: [{x,y,vx,vy}], idx = me, owner = ball carrier index (-1 none), dir = my attack direction (+1/-1)
export function markTarget(players, idx, ball, owner, prev = -1) {
  const team = idx < PLAYERS_PER_TEAM ? 0 : 1;
  if (owner >= 0 && (owner < PLAYERS_PER_TEAM ? 0 : 1) !== team) return owner;  // the ball carrier first
  let best = -1, bd = 1e9;
  for (let i = 0; i < players.length; i++) {
    if ((i < PLAYERS_PER_TEAM ? 0 : 1) === team || i % PLAYERS_PER_TEAM === 0) continue; // opponents, not their keeper
    let d = len(players[i].x - ball.x, players[i].y - ball.y);
    if (i === prev) d -= 2; // stick with the same man unless someone is clearly closer
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
export function markInput(players, idx, ball, owner, dir, prev) {
  const t = markTarget(players, idx, ball, owner, prev); if (t < 0) return null;
  const me = players[idx], o = players[t];
  const gx = -dir * HALF_W;                        // my own goal
  const ax = gx - o.x, ay = 0 - o.y, al = len(ax, ay) || 1;
  const gap = t === owner ? 1.25 : 1.6;            // tighter on the ball carrier
  const px = o.x + ax / al * gap + o.vx * 0.15, py = o.y + ay / al * gap + o.vy * 0.15; // goal-side spot
  const dx = px - me.x, dy = py - me.y, dl = len(dx, dy);
  const k = dl < 0.15 ? 0 : Math.min(1, dl / 1.2);
  // far away: full speed to get there; once close: a touch slower than free running, like jockeying
  return { target: t, mx: dl ? dx / dl * k : 0, my: dl ? dy / dl * k : 0, faceTo: Math.atan2(ball.y - me.y, ball.x - me.x), speed: dl > 2.5 ? 1 : MARK_SPEED };
}

// --- the match -------------------------------------------------------------
export class Match {
  constructor(opts = {}) {
    this.halfLen = opts.halfLen || 180; // seconds per half (the lobby picks 1, 2, 3 or 5 minutes)
    this.rand = opts.rand || Math.random;
    this.players = [];
    for (let t = 0; t < 2; t++) for (let s = 0; s < PLAYERS_PER_TEAM; s++) this.players.push(makePlayer(this.players.length, t, s));
    this.ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, owner: -1, last: -1, lastTeam: -1, ownT: 0 };
    this.inputs = this.players.map(() => ({ mx: 0, my: 0, b: 0 }));
    this.human = this.players.map(() => false);
    this.markOf = this.players.map(() => -1);    // who each human is marking (-1 = nobody)
    this.callCd = this.players.map(() => 0);     // CALL cooldown per player
    this.events = [];
    this.reset();
  }
  reset() {
    this.score = [0, 0]; this.half = 1; this.clock = this.halfLen; this.tick = 0;
    this.kickTeam = 0; this.lastScorer = -1;
    this.startKickoff(0);
  }
  // team 0 attacks +x in the first half
  dirOf(team) { return (team === 0) === (this.half === 1) ? 1 : -1; }
  startKickoff(team) {
    this.state = ST.KICKOFF; this.stateT = 1.6; this.kickTeam = team;
    const b = this.ball; Object.assign(b, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, owner: -1, ownT: 0 });
    const form = [[-26, 0], [-13, -6], [-13, 6], [-5, -9], [-5, 9]];
    for (const p of this.players) {
      const d = this.dirOf(p.team);
      let [fx, fy] = form[p.slot];
      if (p.team === team && p.slot === 4) { fx = -0.9; fy = 0.2; }
      if (p.team === team && p.slot === 3) { fx = -4; fy = -5; }
      p.x = fx * d; p.y = fy; p.vx = p.vy = 0; p.face = d > 0 ? 0 : Math.PI;
      Object.assign(p, { tackleT: 0, stunT: 0, kickCd: 0, charge: 0, charging: false, stamina: Math.max(p.stamina, 0.6) });
      p.ai = { patience: 0.5 + this.rand(), think: 0 };
    }
    this.events.push({ k: 'kickoff', line: this.pick('kickoff') });
  }
  pick(kind) { const a = LINES[kind]; return Math.floor(this.rand() * a.length); }

  step() {
    const dt = DT; this.tick++;
    const frozen = this.state === ST.KICKOFF || this.state === ST.HALFTIME || this.state === ST.FULLTIME || this.state === ST.LOBBY;
    if (this.state !== ST.FULLTIME) {
      this.stateT -= dt;
      if (this.state === ST.KICKOFF && this.stateT <= 0) this.state = ST.PLAY;
      else if (this.state === ST.GOAL && this.stateT <= 0) this.startKickoff(this.lastConceded);
      else if (this.state === ST.HALFTIME && this.stateT <= 0) { this.half = 2; this.startKickoff(1); }
      if (this.state === ST.PLAY) {
        this.clock -= dt;
        if (this.clock <= 0) {
          this.clock = 0;
          if (this.half === 1) { this.state = ST.HALFTIME; this.stateT = 4; this.clock = this.halfLen; this.events.push({ k: 'half', line: this.pick('half') }); }
          else { this.state = ST.FULLTIME; this.events.push({ k: 'full', line: this.pick('full'), score: [...this.score] }); }
        }
      }
    }
    // AI writes inputs for bot players
    if (!frozen) for (const p of this.players) if (!this.human[p.i]) this.inputs[p.i] = this.think(p);
    const b = this.ball;
    for (const p of this.players) {
      let inp = this.inputs[p.i];
      const hasBall = b.owner === p.i;
      const ctx = { hasBall, frozen, speedMul: this.human[p.i] ? 1 : 0.93 };
      // MARK held (and not on the ball): the game steers you goal-side of your man
      if ((inp.b & BTN_MARK) && !hasBall && !frozen && !p.gk) {
        const mk = markInput(this.players, p.i, b, b.owner, this.dirOf(p.team), this.markOf[p.i]);
        if (mk) { inp = { mx: mk.mx, my: mk.my, b: inp.b }; ctx.faceTo = mk.faceTo; ctx.speedMul *= mk.speed; this.markOf[p.i] = mk.target; }
      } else this.markOf[p.i] = -1;
      this.callCd[p.i] = Math.max(0, this.callCd[p.i] - dt);
      const rising = movePlayer(p, inp, dt, ctx);
      if (!frozen) this.actions(p, inp, rising, hasBall);
      p.prevBtn = inp.b;
    }
    this.separate();
    this.stepBall(dt, frozen);
  }

  actions(p, inp, rising, hasBall) {
    const b = this.ball;
    if ((rising & BTN_CALL) && !hasBall && this.callCd[p.i] <= 0 && b.owner >= 0 && b.owner !== p.i && this.players[b.owner].team === p.team) {
      const o = this.players[b.owner];
      this.callCd[p.i] = CALL_COOLDOWN;
      o.callFrom = p.i; o.callUntil = this.tick + CALL_WINDOW * TICK_HZ;  // carrier's next pass goes to the caller
      this.events.push({ k: 'call', p: p.i, to: o.i });
    }
    if (hasBall) {
      if (rising & BTN_PASS) this.pass(p, inp);
      if (inp.b & BTN_SHOOT) { p.charging = true; p.charge = Math.min(1, p.charge + DT / 0.9); }
      else if (p.charging) { this.shoot(p, inp, p.charge); }
    } else {
      if (p.charging && !(inp.b & BTN_SHOOT)) { p.charging = false; p.charge = 0; }
      if (!(inp.b & BTN_SHOOT)) { p.charging = false; p.charge = 0; }
      // tackle contact
      if (p.tackleT > 0 && b.owner >= 0 && this.players[b.owner].team !== p.team) {
        const o = this.players[b.owner];
        const d = len(o.x - p.x, o.y - p.y), db = len(b.x - p.x, b.y - p.y);
        if (d < 1.25 || db < 1.0) {
          p.tackleT = 0;
          const chance = o.gk ? 0.15 : 0.72;
          if (this.rand() < chance) {
            b.owner = -1; b.last = p.i; b.lastTeam = p.team;
            const a = p.face + (this.rand() - 0.5) * 0.8;
            b.vx = Math.cos(a) * 5.5 + p.vx * 0.2; b.vy = Math.sin(a) * 5.5 + p.vy * 0.2; b.vz = 1.2;
            o.stunT = 0.7; o.charging = false; o.charge = 0;
            this.events.push({ k: 'tackle', p: p.i });
          } else { p.stunT = 0.55; }
        }
      }
    }
  }

  kick(p, vx, vy, vz) {
    const b = this.ball;
    b.owner = -1; b.vx = vx; b.vy = vy; b.vz = vz; b.z = Math.max(b.z, 0.05);
    b.last = p.i; b.lastTeam = p.team; b.gkBeat = -1; p.kickCd = 0.28; p.kickFx = 0.25;
    p.charging = false; p.charge = 0;
  }
  aimDir(p, inp) {
    const m = len(inp.mx, inp.my);
    return m > 0.3 ? Math.atan2(inp.my, inp.mx) : p.face;
  }
  bestMate(p, ang, preferFwd = 0) {
    let best = null, bs = -1e9;
    const d = this.dirOf(p.team);
    for (const q of this.players) {
      if (q.team !== p.team || q === p) continue;
      const dx = q.x - p.x, dy = q.y - p.y, dist = len(dx, dy);
      if (dist < 2.5 || dist > 34) continue;
      const dot = (dx * Math.cos(ang) + dy * Math.sin(ang)) / dist;
      if (ang !== null && dot < 0.35) continue;
      let s = dot * 3 - Math.abs(dist - 12) * 0.08 + (dx * d) / 10 * preferFwd;
      s -= this.laneBlock(p, q) * 3;
      if (q.gk) s -= 2.5;
      if (this.human[q.i] && !this.human[p.i]) s += 0.6;
      if (s > bs) { bs = s; best = q; }
    }
    return best ? { q: best, s: bs } : null;
  }
  laneBlock(p, q) {
    let blk = 0;
    const dx = q.x - p.x, dy = q.y - p.y, L = len(dx, dy) || 1;
    for (const o of this.players) {
      if (o.team === p.team) continue;
      const t = ((o.x - p.x) * dx + (o.y - p.y) * dy) / (L * L);
      if (t < 0.05 || t > 0.95) continue;
      const px = p.x + dx * t, py = p.y + dy * t, dd = len(o.x - px, o.y - py);
      if (dd < 1.8) blk = Math.max(blk, 1 - dd / 1.8);
    }
    return blk;
  }
  pass(p, inp, target) {
    const ang = this.aimDir(p, inp);
    if (!target && p.callFrom >= 0 && this.tick <= p.callUntil) target = this.players[p.callFrom]; // someone called for it
    p.callFrom = -1;
    const m = target ? { q: target } : this.bestMate(p, ang);
    if (m) {
      const q = m.q;
      let tx = q.x + q.vx * 0.45, ty = q.y + q.vy * 0.45;
      const dist = len(tx - p.x, ty - p.y);
      const sp = clamp(5.5 + dist * 0.85, 8, 19);
      const a = Math.atan2(ty - p.y, tx - p.x);
      const lob = dist > 18 ? 3.2 : 0.6;
      this.kick(p, Math.cos(a) * sp, Math.sin(a) * sp, lob);
    } else {
      this.kick(p, Math.cos(ang) * 12, Math.sin(ang) * 12, 0.8);
    }
  }
  shoot(p, inp, charge, aimY) {
    const d = this.dirOf(p.team), gx = d * HALF_W;
    let ang = this.aimDir(p, inp);
    const toGoal = Math.atan2(0 - p.y, gx - p.x);
    let da = ang - toGoal; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    if (aimY !== undefined) ang = Math.atan2(aimY - p.y, gx - p.x);
    else if (Math.abs(da) < 0.9 && Math.abs(gx - p.x) > 1) {
      // aim assist: pick the point on the goal line the stick points at, kept inside the posts
      const t = Math.tan(ang) * (gx - p.x);
      const y = clamp(p.y + (Math.cos(ang) * d > 0 ? t : 0), -GOAL_HALF + 0.35, GOAL_HALF - 0.35);
      ang = Math.atan2(y - p.y, gx - p.x);
    }
    const c = clamp(charge, 0.15, 1);
    ang += (this.rand() - 0.5) * (0.04 + c * c * 0.1);
    const sp = 13 + c * 14;
    this.kick(p, Math.cos(ang) * sp, Math.sin(ang) * sp, 1.2 + c * 3.8);
    this.events.push({ k: 'shot', p: p.i });
  }

  separate() {
    const P = this.players, R = PLAYER_R * 2;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j], dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy);
      if (d > 0 && d < R) { const push = (R - d) / 2, nx = dx / d, ny = dy / d; a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push; }
    }
    for (const p of P) clampPlayer(p);
  }

  stepBall(dt, frozen) {
    const b = this.ball, P = this.players;
    if (b.owner >= 0) {
      const p = P[b.owner];
      const r = 0.72 + Math.min(0.25, len(p.vx, p.vy) * 0.03);
      b.x = p.x + Math.cos(p.face) * r; b.y = p.y + Math.sin(p.face) * r; b.z = 0;
      b.vx = p.vx; b.vy = p.vy; b.vz = 0; b.ownT += dt;
      // keep the dribbled ball inside the walls
      this.collideWalls(b);
      return;
    }
    if (frozen) return;
    const N = 6, h = dt / N;
    for (let s = 0; s < N; s++) {
      if (b.z > 0 || b.vz > 0) {
        b.vz -= 9.8 * h; b.z += b.vz * h;
        if (b.z <= 0) { b.z = 0; b.vz = b.vz < -1.5 ? -b.vz * 0.45 : 0; b.vx *= 0.92; b.vy *= 0.92; }
      }
      const sp = len(b.vx, b.vy);
      if (sp > 0) {
        const dec = b.z > 0.05 ? 0.15 * sp : 1.1 + 0.32 * sp;
        const nsp = Math.max(0, sp - dec * h);
        b.vx *= nsp / sp; b.vy *= nsp / sp;
      }
      b.x += b.vx * h; b.y += b.vy * h;
      this.collideWalls(b);
      if (this.state === ST.PLAY && Math.abs(b.y) < GOAL_HALF && Math.abs(b.x) > HALF_W + BALL_R && b.z < GOAL_HEIGHT) {
        this.goal(b.x > 0 ? 1 : -1);
      }
    }
    // pickups
    if (this.state === ST.PLAY || this.state === ST.GOAL) {
      if (this.state === ST.GOAL) return;
      let best = null, bd = 1e9;
      for (const p of P) {
        if (p.stunT > 0 || p.kickCd > 0 || b.gkBeat === p.i) continue;
        const r = p.gk ? GK_CONTROL_R + (p.tackleT > 0 ? 0.45 : 0) : CONTROL_R;
        const zmax = p.gk ? 2.3 : 1.0;
        const d = len(b.x - p.x, b.y - p.y);
        if (d < r && b.z < zmax && d < bd) { bd = d; best = p; }
      }
      if (best) {
        const rel = len(b.vx - best.vx, b.vy - best.vy);
        if (best.gk && rel > 12 && b.lastTeam !== best.team && b.gkBeat !== -2) {
          // a hard shot can beat the keeper: decided once per shot, harder + wider = likelier
          const beat = clamp((rel - 11) / 16, 0, 0.55) * clamp(bd / 0.7, 0.35, 1.2);
          if (this.rand() < beat) { b.gkBeat = best.i; return; }
          b.gkBeat = -2;
        }
        if (best.gk) {
          const inBox = Math.abs(best.x - this.dirOf(best.team) * -HALF_W) < BOX_DEPTH + 1;
          const catchP = rel < 12 ? 0.9 : rel < 19 ? 0.55 : 0.3;
          if (rel > 9 && b.lastTeam !== best.team && !(this.rand() < catchP && inBox)) {
            // parry
            const d = this.dirOf(best.team);
            const a = Math.atan2(b.y - best.y, 0) * 0.5 + (d > 0 ? 0 : Math.PI) + (this.rand() - 0.5) * 1.6;
            const s2 = rel * 0.45;
            b.vx = Math.cos(a) * s2; b.vy = Math.sin(a) * s2; b.vz = 2 + this.rand() * 2; b.last = best.i; b.lastTeam = best.team;
            best.kickCd = 0.35;
            this.events.push({ k: 'save', p: best.i, line: this.pick('save') });
            return;
          }
          if (rel > 9 && b.lastTeam !== best.team) this.events.push({ k: 'save', p: best.i, line: this.pick('save') });
        } else if (rel > 15 && this.rand() < 0.6) {
          // too hot to trap: deflect
          b.vx *= -0.3; b.vy *= -0.3; b.last = best.i; b.lastTeam = best.team; best.kickCd = 0.2; return;
        }
        b.owner = best.i; b.last = best.i; b.lastTeam = best.team; b.ownT = 0;
        best.ai && (best.ai.patience = 0.4 + this.rand() * 1.2);
      }
    }
  }

  collideWalls(b) {
    const r = BALL_R;
    for (const w of WALLS) {
      if (w.kind === 'mouth' && b.z < GOAL_HEIGHT) continue;
      if (w.kind === 'net' && Math.abs(b.x) < HALF_W - 0.2) continue;
      const dx = w.bx - w.ax, dy = w.by - w.ay;
      let t = ((b.x - w.ax) * dx + (b.y - w.ay) * dy) / w.l2; t = clamp(t, 0, 1);
      const cx = w.ax + dx * t, cy = w.ay + dy * t;
      let nx = b.x - cx, ny = b.y - cy; const d = len(nx, ny);
      if (d < r && d > 1e-6) {
        nx /= d; ny /= d;
        b.x = cx + nx * r; b.y = cy + ny * r;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= (1 + w.e) * vn * nx; b.vy -= (1 + w.e) * vn * ny; }
        if (b.owner >= 0) { /* dribbling into a wall: just held there */ }
      } else if (d <= 1e-6) {
        // exactly on the line: push inward toward pitch centre
        const ix = -Math.sign(cx) || 0, iy = -Math.sign(cy) || 0; b.x += ix * r; b.y += iy * r;
      }
    }
    // safety: never leave the playable area (except into the goal box)
    const inGoal = Math.abs(b.y) < GOAL_HALF && Math.abs(b.x) <= HALF_W + GOAL_DEPTH;
    if (!inGoal) { b.x = clamp(b.x, -HALF_W + r, HALF_W - r); b.y = clamp(b.y, -HALF_H + r, HALF_H - r); }
    else { b.x = clamp(b.x, -HALF_W - GOAL_DEPTH + r, HALF_W + GOAL_DEPTH - r); }
  }

  goal(side) {
    // side +1: ball in the +x goal
    const scorerTeam = this.dirOf(0) === side ? 0 : 1;
    this.score[scorerTeam]++;
    this.state = ST.GOAL; this.stateT = 3.2; this.lastConceded = 1 - scorerTeam;
    const b = this.ball, last = b.last >= 0 ? this.players[b.last] : null;
    const own = last && last.team !== scorerTeam;
    this.events.push({ k: 'goal', team: scorerTeam, p: b.last, own: !!own, line: this.pick('goal'), score: [...this.score] });
  }

  // ---------------- bots ----------------
  think(p) {
    const b = this.ball, d = this.dirOf(p.team), P = this.players;
    const inp = { mx: 0, my: 0, b: 0 };
    const goTo = (tx, ty, sprint, slow = 0.6) => {
      const dx = tx - p.x, dy = ty - p.y, dist = len(dx, dy);
      if (dist < 0.25) return;
      const s = dist < 2 ? Math.max(slow, dist / 2) : 1;
      inp.mx = dx / dist * s; inp.my = dy / dist * s;
      if (sprint && dist > 3) inp.b |= BTN_SPRINT;
    };
    const ai = p.ai || (p.ai = { patience: 1, think: 0 });
    const owner = b.owner >= 0 ? P[b.owner] : null;
    const myGoalX = -d * HALF_W, oppGoalX = d * HALF_W;

    if (p.gk) {
      if (owner === p) {
        ai.patience -= DT;
        p.face = d > 0 ? 0 : Math.PI;
        if (ai.patience <= 0) {
          const m = this.bestMate(p, null, 1);
          if (m) this.pass(p, inp, m.q); else this.kick(p, d * 15, (this.rand() - 0.5) * 8, 4);
        }
        // walk to edge of box a little
        goTo(myGoalX + d * 3, clamp(p.y, -3, 3), false, 0.3);
        return inp;
      }
      // predicted ball position on the keeper's line
      let gy = clamp(b.y * 0.35, -GOAL_HALF + 0.3, GOAL_HALF - 0.3);
      let gx = myGoalX + d * (1.0 + clamp((len(b.x - myGoalX, b.y) - 6) * 0.06, 0, 1.0));
      const towards = (b.vx * -d) > 4 && owner === null;
      if (towards) {
        const t = (p.x - b.x) / (b.vx || 1e-3);
        if (t > 0 && t < 2) gy = clamp(b.y + b.vy * t, -GOAL_HALF - 0.6, GOAL_HALF + 0.6);
      }
      const distB = len(b.x - p.x, b.y - p.y);
      const ballInBox = Math.abs(b.x - myGoalX) < BOX_DEPTH && Math.abs(b.y) < BOX_HALF;
      if (ballInBox && (owner === null || owner.team !== p.team) && b.z < 2) {
        // rush the ball when it's in the box and no teammate has it
        const mates = P.filter(q => q.team === p.team && !q.gk && len(b.x - q.x, b.y - q.y) < distB * 0.7);
        if (!mates.length || owner) { gx = b.x; gy = b.y; }
      }
      goTo(gx, gy, true, 0.4);
      // dive at fast shots
      if (towards && distB < 3.2 && len(b.vx, b.vy) > 9 && p.tackleCd <= 0) {
        p.face = Math.atan2(b.y + b.vy * 0.1 - p.y, b.x + b.vx * 0.1 - p.x); p.tackleT = 0.13; p.tackleCd = 1.1;
      }
      // stay in the box
      if (Math.abs(p.x - myGoalX) > BOX_DEPTH) inp.mx = d;
      return inp;
    }

    if (owner === p) {
      ai.patience -= DT;
      if (p.callFrom >= 0 && this.tick <= p.callUntil) {
        const q = P[p.callFrom];
        if (this.laneBlock(p, q) < 0.6 || this.tick + 3 > p.callUntil) { this.pass(p, inp, q); return inp; } // open enough (or out of time): give it
      }
      const gdx = oppGoalX - p.x, gdist = len(gdx, -p.y);
      // nearest opponent
      let near = null, nd = 1e9;
      for (const o of P) if (o.team !== p.team) { const dd = len(o.x - p.x, o.y - p.y); if (dd < nd) { nd = dd; near = o; } }
      const keeper = P.find(o => o.team !== p.team && o.gk);
      if (gdist < 17 && (gdist < 11 || this.rand() < 0.1) && Math.abs(p.y) < 12) {
        const aimY = (keeper && keeper.y > 0 ? -1 : 1) * (GOAL_HALF - 0.5) * (0.6 + this.rand() * 0.4);
        p.face = Math.atan2(aimY - p.y, oppGoalX - p.x);
        this.shoot(p, { mx: 0, my: 0 }, clamp(gdist / 16, 0.35, 0.95), aimY);
        return inp;
      }
      if ((nd < 2.2 && ai.patience <= 0.3) || ai.patience <= 0) {
        const m = this.bestMate(p, null, 1);
        if (m && (m.s > 0.5 || nd < 1.6)) { this.pass(p, inp, m.q); return inp; }
        ai.patience = 0.5 + this.rand();
      }
      // dribble toward goal, sliding away from pressure
      let tx = oppGoalX - d * 4, ty = 0;
      if (near && nd < 5) { const away = p.y - near.y; ty = p.y + Math.sign(away || 1) * 4; tx = p.x + d * 4; }
      goTo(tx, clamp(ty, -HALF_H + 2, HALF_H - 2), nd > 3 && p.stamina > 0.5);
      return inp;
    }

    // who chases?
    const teamHas = owner && owner.team === p.team;
    if (!teamHas) {
      let chaser = null, cd = 1e9, humanCloser = false, pd = len(b.x - p.x, b.y - p.y);
      for (const q of P) {
        if (q.team !== p.team || q.gk) continue;
        const dd = len(b.x - q.x, b.y - q.y);
        if (this.human[q.i]) { if (dd < pd - 1) humanCloser = true; continue; }
        if (dd < cd) { cd = dd; chaser = q; }
      }
      const second = owner && !humanCloser && chaser !== p && pd < 7 && Math.abs(b.x - myGoalX) < 18;
      if ((chaser === p && !humanCloser) || second) {
        const lead = owner ? 0.25 : clamp(pd / 12, 0, 0.6);
        goTo(b.x + b.vx * lead, b.y + b.vy * lead, pd > 4 || !!owner, 1);
        if (owner && pd < 1.9 && p.tackleCd <= 0 && this.rand() < 0.12) {
          p.face = Math.atan2(b.y - p.y, b.x - p.x);
          inp.mx = Math.cos(p.face); inp.my = Math.sin(p.face);
          if (!(p.prevBtn & BTN_TACKLE)) inp.b |= BTN_TACKLE; // a fresh press = slide tackle
        }
        return inp;
      }
    }
    // formation spot (team frame: own goal at -x)
    const base = [[0, 0], [-15, -7], [-15, 7], [-4, -8], [-4, 8]][p.slot];
    const bxT = b.x * d;
    let fx = base[0] + bxT * 0.55 + (teamHas ? 6 : -2), fy = base[1] + b.y * 0.3;
    if (p.slot >= 3 && teamHas) fx += 4;
    fx = clamp(fx, -24, 24); fy = clamp(fy, -HALF_H + 2, HALF_H - 2);
    goTo(fx * d, fy, false, 0.3);
    if (len(inp.mx, inp.my) < 0.1) p.face = Math.atan2(b.y - p.y, b.x - p.x);
    return inp;
  }
}
