import { Match, ST, TICK_HZ } from '../public/shared/sim.js';
const m = new Match({ halfLen: 180 });
let goals = [], saves = 0, shots = 0, passes = 0, ownerChanges = 0, lastOwner = -1, stuckBall = 0;
let t0 = Date.now(), ticks = 0;
while (m.state !== ST.FULLTIME && ticks < TICK_HZ * 600) {
  m.step(); ticks++;
  for (const e of m.events) { if (e.k === 'goal') goals.push(e); if (e.k === 'save') saves++; if (e.k === 'shot') shots++; }
  m.events.length = 0;
  if (m.ball.owner !== lastOwner) { ownerChanges++; lastOwner = m.ball.owner; }
  if (!isFinite(m.ball.x) || !isFinite(m.ball.y)) { console.log('NaN ball'); process.exit(1); }
}
console.log({ ticks, secs: ticks / TICK_HZ, ms: Date.now() - t0, score: m.score, goals: goals.length, shots, saves, ownerChanges });
