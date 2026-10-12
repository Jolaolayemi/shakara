// Mobile screenshots against the live URL with headless Chromium (playwright-core).
import { chromium, devices } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2] || 'https://naija5-proto.sites.tab.bot';
const out = process.argv[3] || new URL('../screenshots/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const phone = { viewport: { width: 800, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices['Pixel 5'].userAgent };
const errors = [];
const mk = async (opts = phone) => { const c = await browser.newContext(opts); const p = await c.newPage(); p.on('pageerror', e => errors.push(String(e))); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); return p; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const host = await mk();
const t0 = Date.now();
await host.goto(base, { waitUntil: 'load' });
const loadMs = Date.now() - t0;
await sleep(800);
await host.screenshot({ path: out + '01_home_landscape.png' });
await host.fill('#nick', 'Olayemi');
await host.click('#bCreate');
await host.waitForFunction(() => window.__n5 && window.__n5.room && window.__n5.room.code);
const code = await host.evaluate(() => window.__n5.room.code);
// friend opens the WhatsApp link in portrait
const friend = await mk({ ...phone, viewport: { width: 390, height: 844 } });
await friend.goto(base + '/?room=' + code, { waitUntil: 'load' });
await friend.waitForFunction(() => window.__n5 && window.__n5.screen === 'lobby', null, { timeout: 10000 });
await friend.evaluate(() => { document.querySelector('#nick2').value = 'Tobi'; document.querySelector('#nick2').dispatchEvent(new Event('change')); });
if (await friend.isVisible('.join[data-team="1"]')) await friend.click('.join[data-team="1"]');
await sleep(800);
await host.screenshot({ path: out + '02_lobby_landscape.png' });
await friend.screenshot({ path: out + '03_lobby_portrait_from_link.png' });
await host.click('#bStart');
await host.waitForFunction(() => window.__n5.screen === 'game', null, { timeout: 10000 });
// rotate the friend to landscape like a real player
await friend.setViewportSize({ width: 800, height: 360 });
await sleep(2500);
// hold the joystick-ish keys to move the host toward the ball for a bit
await host.keyboard.down('KeyD'); await sleep(900); await host.keyboard.up('KeyD');
await sleep(600);
await host.screenshot({ path: out + '04_match_host.png' });
await friend.screenshot({ path: out + '05_match_friend.png' });
// MARK moment: when the other team has the ball, hold X (same as the MARK button) and grab the frame
const ctxOf = (pg) => pg.evaluate(() => { const s = window.__n5.snap; if (!s || s.me < 0 || s.owner < 0) return 'none'; const mt = Math.floor(s.me / 5), ot = Math.floor(s.owner / 5); return s.owner === s.me ? 'ball' : (mt === ot ? (s.players[s.owner].fl & 32 ? 'attack-human' : 'attack') : 'defend'); });
let marked = false;
for (let i = 0; i < 80 && !marked; i++) {
  if ((await ctxOf(host)) === 'defend') { await host.keyboard.down('KeyX'); await sleep(1300); marked = (await host.evaluate(() => window.__n5.markIdx)) >= 0; if (marked) await host.screenshot({ path: out + '07_mark.png' }); await host.keyboard.up('KeyX'); }
  else await sleep(250);
}
// CALL moment: when a teammate bot has the ball, press C (same as CALL) and grab the bouncing PASS! bubble
let called = false;
for (let i = 0; i < 120 && !called; i++) {
  if ((await ctxOf(host)) === 'attack') { await host.keyboard.down('KeyC'); await sleep(120); await host.keyboard.up('KeyC'); await sleep(450); called = !!(await host.evaluate(() => window.__n5.callIcon)); if (called) await host.screenshot({ path: out + '08_call.png' }); }
  else await sleep(250);
}
// wait for a goal banner (bots score within a minute or two)
let goal = false;
for (let i = 0; i < 120 && !goal; i++) {
  await sleep(1000);
  goal = await host.evaluate(() => !document.getElementById('banner').classList.contains('hidden') && /GOAL|Na wa|send|enter|tear|finish|where|score|Gbas|dem|sleep/i.test(document.getElementById('bnBig').textContent));
}
if (goal) { await sleep(250); await host.screenshot({ path: out + '06_goal_banner.png' }); }
const state = await host.evaluate(() => ({ screen: window.__n5.screen, snap: window.__n5.snap && { tick: window.__n5.snap.tick, score: window.__n5.snap.score, me: window.__n5.snap.me } }));
const fstate = await friend.evaluate(() => ({ screen: window.__n5.screen, snap: window.__n5.snap && { tick: window.__n5.snap.tick, score: window.__n5.snap.score, me: window.__n5.snap.me } }));
const perf = await host.evaluate(() => new Promise(res => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
const transfer = await host.evaluate(() => performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation')).reduce((a, e) => a + (e.transferSize || 0), 0));
console.log(JSON.stringify({ code, loadMs, marked, called, goal, state, fstate, fps_headless: perf, firstLoadBytes: transfer, errors }, null, 1));
await browser.close();
