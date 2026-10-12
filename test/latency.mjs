// Latency test: local server with SIM_LAG_MS each way; a real headless browser plays and we measure feel.
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:8093';
const out = process.argv[3] || new URL('../screenshots/', import.meta.url).pathname;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 800, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(String(e)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await p.goto(base); await sleep(500);
await p.click('#bCreate'); await p.waitForFunction(() => window.__n5.room);
await p.click('#bStart'); await p.waitForFunction(() => window.__n5.snap && window.__n5.snap.state === 2, null, { timeout: 15000 });
await sleep(1500);
const rtt = await p.evaluate(() => window.__n5.rtt);
// press right and see how fast the predicted player responds vs the server copy
const x0 = await p.evaluate(() => window.__n5.pred.x);
await p.keyboard.down('KeyD');
const t0 = Date.now(); let predMovedAt = 0, serverMovedAt = 0;
while (Date.now() - t0 < 1500) {
  const [px, sx] = await p.evaluate(() => [window.__n5.pred.x, window.__n5.snap.players[window.__n5.snap.me].x]);
  if (!predMovedAt && px - x0 > 0.15) predMovedAt = Date.now() - t0;
  if (!serverMovedAt && sx - x0 > 0.15) serverMovedAt = Date.now() - t0;
  await sleep(10);
}
await p.keyboard.up('KeyD');
// run around for a few seconds sampling the correction error
const errs = [];
const dirs = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
for (let i = 0; i < 16; i++) { const k = dirs[i % 4]; await p.keyboard.down(k); for (let j = 0; j < 5; j++) { await sleep(100); errs.push(await p.evaluate(() => window.__n5.err)); } await p.keyboard.up(k); }
await p.screenshot({ path: out + '07_match_at_' + Math.round(rtt) + 'ms_ping.png' });
errs.sort((a, b) => a - b);
console.log(JSON.stringify({ rtt: Math.round(rtt), predictedPlayerMovesAfterMs: predMovedAt, serverConfirmsAfterMs: serverMovedAt, correctionErrMedian_m: +errs[errs.length >> 1].toFixed(3), correctionErrP95_m: +errs[Math.floor(errs.length * 0.95)].toFixed(3), errors }));
await b.close();
