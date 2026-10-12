import { Match, ST, TICK_HZ } from '../public/shared/sim.js';
let tot = { goals: 0, shots: 0, saves: 0 }; const R = 8;
for (let r = 0; r < R; r++) {
  const m = new Match({ halfLen: 180 });
  while (m.state !== ST.FULLTIME) { m.step(); for (const e of m.events) { if (e.k === 'goal') tot.goals++; if (e.k === 'save') tot.saves++; if (e.k === 'shot') tot.shots++; } m.events.length = 0; }
}
console.log('per 6-min match:', { goals: tot.goals / R, shots: tot.shots / R, saves: tot.saves / R });
