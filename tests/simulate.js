#!/usr/bin/env node
/*
 * Scheduler simulation for Frame's Shuffle Court.
 *
 * Drives the real index.html in headless Chromium (Playwright) and measures how fair and varied
 * the generated rounds are. Everything is recomputed from pastRounds, not from the app's counters.
 *
 * Usage:
 *   npm i -g playwright            (or have `playwright` resolvable)
 *   NODE_PATH=$(npm root -g) node tests/simulate.js [options]
 *
 * Options:
 *   --players 4-12     player count or range           (default 6-8)
 *   --courts 1,2       court counts to test            (default 1,2)
 *   --modes bench,uneven                                (default bench,uneven)
 *   --sessions 20      sessions per combo              (default 20)
 *   --rounds 40        rounds per session              (default 40)
 *   --switch 4         play N rounds on 1 court, then switch to 2 (overrides --courts)
 *   --churn            players randomly leave / join mid-session
 *
 * Exit code is 1 if any hard rule is broken (duplicate/missing player, back-to-back solo with
 * 6+ active players, page error), so it can be used as a regression check.
 */
const path = require('path');
const { chromium } = require('playwright');
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const range = s => { const m = String(s).match(/^(\d+)-(\d+)$/); return m ? Array.from({ length: m[2] - m[1] + 1 }, (_, i) => +m[1] + i) : String(s).split(',').map(Number); };
const players = range(arg('players', '6-8'));
const courtsList = String(arg('courts', '1,2')).split(',').map(Number);
const modes = String(arg('modes', 'bench,uneven')).split(',');
const sessions = +arg('sessions', 20), rounds = +arg('rounds', 40);
const switchAt = arg('switch', false) ? +arg('switch', 4) : 0;
const churn = !!arg('churn', false);

// Runs inside the page: one whole session, returns metrics.
function runSession([n, courts, mode, rounds, switchAt, churn]) {
  document.getElementById('playerInput').value = Array.from({ length: n }, (_, i) => 'P' + i).join(' ');
  SC.addFromInput(); SC.setOddGroupMode(mode); SC.setCourtsValue(switchAt ? 1 : courts);
  const get = () => JSON.parse(localStorage.getItem('shuffle-state'));
  let late = 0, prevLone = [], b2b = 0, issues = 0, cov = { partner: 0, opp: 0, solo: 0 };
  const soloSeen = new Set(), loneSeen = {};
  for (let r = 1; r <= rounds; r++) {
    if (switchAt && r === switchAt + 1) SC.setCourtsValue(2);
    if (churn && r > 1 && Math.random() < 0.25) {
      const s = get(), act = s.players.filter(p => p.active), off = s.players.filter(p => !p.active), x = Math.random();
      if (x < 0.4 && act.length > 3) SC.toggleActive(act[Math.floor(Math.random() * act.length)].id);
      else if (x < 0.7 && off.length) SC.toggleActive(off[Math.floor(Math.random() * off.length)].id);
      else { document.getElementById('playerInput').value = 'L' + late++; SC.addFromInput(); }
    }
    const before = get().roundNumber; SC.generateRound(); const s = get();
    if (s.roundNumber === before) continue;
    const R = s.currentRound, act = s.players.filter(p => p.active).map(p => p.id);
    const all = [].concat(...R.courts.map(c => c[0].concat(c[1]))).concat(R.bonusMatch ? R.bonusMatch.teamA.concat(R.bonusMatch.teamB) : []).concat(R.resting);
    if (new Set(all).size !== all.length || act.some(i => !all.includes(i)) || all.some(i => !act.includes(i))) issues++;
    const lone = [];
    if (R.bonusMatch) {
      [R.bonusMatch.teamA, R.bonusMatch.teamB].forEach(t => { if (t.length === 1) lone.push(t[0]); });
      R.bonusMatch.teamA.forEach(a => R.bonusMatch.teamB.forEach(b => soloSeen.add([a, b].sort().join('|'))));
    }
    if (act.length >= 6) b2b += lone.filter(x => prevLone.includes(x)).length; // smaller pools can't avoid repeats
    prevLone = lone;
    const h = s.history;
    if (!cov.partner && Object.keys(h.partnerCounts).length === n * (n - 1) / 2) cov.partner = r;
    if (!cov.opp && Object.keys(h.opponentCounts).length === n * (n - 1) / 2) cov.opp = r;
    if (!cov.solo && soloSeen.size === n * (n - 1) / 2) cov.solo = r;
  }
  const s = get(), sp = a => Math.max(...a) - Math.min(...a);
  return { b2b, issues, cov, rounds: s.pastRounds.length, soloPairs: soloSeen.size, soloSpread: sp(s.players.map(p => p.singlesPlayed || 0)), restSpread: sp(s.players.map(p => p.gamesRested)), playedSpread: sp(s.players.map(p => p.gamesPlayed)) };
}

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  console.log(`# ${switchAt ? `1 court x${switchAt} then 2` : 'courts ' + courtsList.join('/')} | ${sessions} sessions x ${rounds} rounds${churn ? ' | churn' : ''}`);
  console.log('players courts mode   | partners@  opp@  solo@  | soloPairs | b2b | spread solo/rest/played | issues');
  for (const mode of modes) for (const n of players) for (const courts of (switchAt ? [2] : courtsList)) {
    const res = [], errs = [];
    for (let t = 0; t < sessions; t++) {
      const ctx = await browser.newContext(); const pg = await ctx.newPage(); // fresh context = no state leak
      pg.on('pageerror', e => errs.push(e.message));
      await pg.goto(URL);
      res.push(await pg.evaluate(runSession, [n, courts, mode, rounds, switchAt, churn]));
      await ctx.close();
    }
    const avg = f => (res.reduce((a, r) => a + f(r), 0) / res.length).toFixed(1);
    const mx = f => Math.max(...res.map(f));
    const cv = k => { const ok = res.filter(r => r.cov[k]); return ok.length ? avg0(ok, k) + (ok.length < res.length ? `(${res.length - ok.length} miss)` : '') : '-'; };
    const avg0 = (ok, k) => (ok.reduce((a, r) => a + r.cov[k], 0) / ok.length).toFixed(1);
    const b2b = res.reduce((a, r) => a + r.b2b, 0), issues = res.reduce((a, r) => a + r.issues, 0) + errs.length;
    if (b2b || issues) failed = true;
    console.log(`${String(n).padStart(7)} ${String(courts).padStart(6)} ${mode.padEnd(6)} | ${cv('partner').padStart(9)} ${cv('opp').padStart(5)} ${cv('solo').padStart(6)}  | ${String(avg(r => r.soloPairs)).padStart(9)} | ${String(b2b).padStart(3)} | ${mx(r => r.soloSpread)}/${mx(r => r.restSpread)}/${mx(r => r.playedSpread)} (max) | ${issues}`);
  }
  await browser.close();
  console.log(failed ? 'FAIL: hard rule broken (b2b solo / invalid round / page error)' : 'OK');
  process.exit(failed ? 1 : 0);
})();
