// Browser smoke test for the whole app. Needs Playwright with Chromium.
// Usage: node tests/ui.smoke.js            (tests the served app and dist/ single file)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, () => resolve(server));
  });
}

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failures++;
}

async function setInput(page, id, v) {
  await page.evaluate(([id, v]) => {
    const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change'));
  }, [id, v]);
}
const scrubTo = (page, v) => page.evaluate(v => {
  const s = document.getElementById('raceSlider'); s.value = v === 'max' ? s.max : v; s.dispatchEvent(new Event('input'));
}, v);

async function exercise(page, label) {
  console.log(`\n${label}`);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
  await page.waitForFunction(() => typeof grades !== 'undefined' && grades.length === 5);

  check(await page.evaluate(() => document.fonts.check('600 14px Inter')), 'bundled Inter font loads');

  // Regression: the review's worked example.
  await setInput(page, 'g0_start', '09:04'); await setInput(page, 'g0_spd', '44'); await setInput(page, 'g0_laps', '20');
  await setInput(page, 'g4_start', '09:00'); await setInput(page, 'g4_spd', '34'); await setInput(page, 'g4_laps', '20');
  const ae = await page.evaluate(() => catchEvents.filter(e => e.c1 === 'A' && e.c2 === 'E').map(e => e.time));
  check(JSON.stringify(ae) === JSON.stringify(['09:06', '09:18', '09:30', '09:42', '09:54']), `A catches E at all five meetings (${ae.join(', ')})`);

  await scrubTo(page, 'max');
  await page.waitForFunction(() => catches.length > 0 && catches.every(c => c.snapshot), null, { timeout: 10000 }).catch(() => {});
  const snaps = await page.evaluate(() => [catches.length, catches.filter(c => c.snapshot).length]);
  check(snaps[0] > 0 && snaps[0] === snaps[1], `every catch has a snapshot (${snaps[1]}/${snaps[0]})`);

  // After-catch rules
  const counts = {};
  for (const mode of ['continue', 'neutralise', 'merge']) {
    await setInput(page, 'after-catch', mode);
    counts[mode] = await page.evaluate(() => catchEvents.length);
  }
  check(counts.neutralise < counts.continue, `neutralising reduces catches (${counts.continue} → ${counts.neutralise})`);
  check(counts.merge <= counts.continue, `merging never adds catches (${counts.merge})`);
  await setInput(page, 'after-catch', 'neutralise');
  await scrubTo(page, 'max');
  const out = await page.evaluate(() => document.querySelectorAll('#finish-section .pill.out').length);
  check(out > 0, `standings show neutralised grades (${out})`);
  await setInput(page, 'after-catch', 'continue');

  // Catch risk (default ±1 km/h ranges)
  await page.evaluate(() => { showTab('risk'); updateRisk(); });
  const riskRows = await page.locator('#risk-result tbody tr').count();
  check(riskRows > 0, `catch risk table has ${riskRows} rows`);

  // Planner: no catches, then apply
  await page.evaluate(() => { showTab('planner'); document.getElementById('plan-rule').value = 'none'; updatePlannerForm(); runPlanner(); });
  const planOk = await page.evaluate(() => currentPlan.plan.feasible && currentPlan.sim.events.length === 0);
  check(planOk, 'planner finds a no-catch schedule');
  await page.click('#plan-apply');
  check(await page.evaluate(() => catchEvents.length) === 0, 'applying the plan leaves no catches');

  // Final-laps rule
  await page.evaluate(() => {
    document.getElementById('plan-rule').value = 'final'; document.getElementById('plan-n').value = 2;
    document.getElementById('plan-objective').value = 'together'; updatePlannerForm(); runPlanner();
  });
  check(await page.evaluate(() => currentPlan.plan.feasible), 'planner handles "final 2 laps, finish together"');

  // Race sheet
  await page.evaluate(() => { document.getElementById('print-sheet').innerHTML = buildRaceSheet(); });
  const sheet = await page.evaluate(() => [...document.querySelectorAll('#print-sheet h2')].map(h => h.textContent));
  check(sheet.some(t => t.startsWith('Start list')) && sheet.some(t => t.startsWith('Lap-by-lap')) && !sheet.some(t => /notes/i.test(t)), `race sheet sections: ${sheet.join(' | ')}`);

  // Save / load round trip keeps the new settings
  await setInput(page, 'after-catch', 'merge');
  await setInput(page, 'g1_range', '2.5');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => saveRace())]);
  const file = path.join(os.tmpdir(), `race-${Date.now()}.json`);
  await dl.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(saved.version === '11.3' && saved.afterCatch === 'merge' && saved.grades[1].range === 2.5, 'saved file has version, rule and ranges');
  await page.evaluate(() => { document.getElementById('after-catch').value = 'continue'; handleAfterCatchChange(); });
  await page.setInputFiles('#loadFileInput', file);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => afterCatch === 'merge' && grades[1].range === 2.5), 'loading restores rule and ranges');

  // A v10 file (no ranges, no rule) still loads
  const v10 = { raceName: 'Old', raceType: 'point', raceStartMinutes: 540, lapLength: 15, version: '10.0',
    grades: [{ name: 'X', color: '#ff0000', start: 540, laps: 1, spd: 30 }, { name: 'Y', color: '#00ff00', start: 545, spd: 40, laps: 1 }] };
  fs.writeFileSync(file, JSON.stringify(v10));
  await page.setInputFiles('#loadFileInput', file);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => raceType === 'point' && afterCatch === 'continue' && grades.length === 2 && catchEvents.length === 1), 'v10 save file loads');

  // Direction of travel mirrors the circuit about the start/finish line
  await page.evaluate(() => { setRaceType('circuit'); });
  const dirX = await page.evaluate(() => {
    const xs = [];
    const orig = drawGradeMarker;
    window.drawGradeMarker = function (ctx, x, y, g) { if (g === grades[0] && ctx.canvas.id === 'raceCanvas') xs.push(x); return orig.apply(this, arguments); };
    const s = document.getElementById('raceSlider'); s.value = 300; s.dispatchEvent(new Event('input'));
    setDirection('clockwise'); setDirection('anticlockwise');
    window.drawGradeMarker = orig;
    return [xs[0], xs[xs.length - 2], document.getElementById('track-sub').textContent];
  });
  check(Math.abs(dirX[0] + dirX[1] - 960) < 0.01 && dirX[0] !== dirX[1], `clockwise mirrors the circuit (x ${dirX[0].toFixed(1)} ↔ ${dirX[1].toFixed(1)})`);
  check(/anticlockwise/.test(dirX[2]), 'direction shown under the track title');
  await page.evaluate(() => setRaceType('point'));
  check(await page.evaluate(() => document.getElementById('direction-field').style.display === 'none'), 'direction hidden for point-to-point');
  await page.evaluate(() => { setRaceType('outback'); setDirection('anticlockwise'); });
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => saveRace())]);
  const file2 = path.join(os.tmpdir(), `race-dir-${Date.now()}.json`);
  await dl2.saveAs(file2);
  await page.evaluate(() => { setDirection('clockwise'); });
  await page.setInputFiles('#loadFileInput', file2);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => raceType === 'outback' && directionByType.outback === 'anticlockwise'), 'direction saved and loaded');

  // ---- v11.3 features ----
  await page.evaluate(() => { resetAllSetup(); document.getElementById('race-name').value = 'Library test'; handleRaceNameChange(); });
  // Race library
  await page.evaluate(() => { openLibrary(); document.getElementById('lib-name').value = 'Club crit'; saveToLibrary(); });
  check(await page.evaluate(() => readLibrary().some(e => e.name === 'Club crit')), 'race saved to the library');
  await page.evaluate(() => { const e = readLibrary().find(x => x.name === 'Club crit'); duplicateInLibrary(e.id); });
  check(await page.evaluate(() => readLibrary().some(e => e.name === 'Club crit (copy)')), 'library duplicate');
  await page.evaluate(() => { document.getElementById('race-name').value = 'Changed'; handleRaceNameChange(); openFromLibrary(readLibrary().find(e => e.name === 'Club crit').id); });
  check(await page.evaluate(() => raceName === 'Library test'), 'opening from the library restores the race');
  // Autosave
  await page.waitForTimeout(600);
  check(await page.evaluate(() => storageGet(AUTOSAVE_KEY, null)?.raceName === 'Library test'), 'current race autosaved');

  // Share link round trip
  const link = await page.evaluate(async () => { await shareRace(); return document.getElementById('share-url').value; });
  check(/#race=z[A-Za-z0-9_-]+$/.test(link), `share link created (${link.length} chars)`);
  const hash = link.slice(link.indexOf('#'));
  const decoded = await page.evaluate(async h => (await SimCore.decodeShare(h.slice(6))).raceName, hash);
  check(decoded === 'Library test', 'share link decodes to the race');
  await page.evaluate(() => closeDialog());

  // Results import
  await page.setInputFiles('#resultsFileInput', path.join(root, 'docs', 'sample-results.csv'));
  await page.waitForFunction(() => document.getElementById('dialog').classList.contains('active'));
  const mapped = await page.evaluate(() => importState.map.filter(i => i >= 0).length);
  check(mapped === 5, `results grades matched automatically (${mapped}/5)`);
  await page.evaluate(() => applyImport());
  const spdA = await page.evaluate(() => grades[0].spd);
  check(Math.abs(spdA - 42) < 1.5, `grade A speed calibrated from results (${spdA})`);

  // Planner: lock, deadline, fixed-gap laps
  await page.evaluate(() => { showTab('planner'); document.getElementById('plan-method').value = 'starts'; document.getElementById('plan-rule').value = 'none'; plannerLocks = new Set([2]); updatePlannerForm(); renderPlannerLocks(); runPlanner(); });
  check(await page.evaluate(() => currentPlan.plan.starts[2] === grades[2].start), 'locked grade keeps its start');
  await page.evaluate(() => { plannerLocks = new Set(); document.getElementById('plan-deadline-on').checked = true; document.getElementById('plan-deadline').value = '09:20'; updatePlannerForm(); runPlanner(); });
  check(await page.evaluate(() => currentPlan.plan.finishBy && currentPlan.plan.finishBy.met && currentPlan.plan.laps.some((l, i) => l < grades[i].laps)), 'deadline met by cutting laps');
  await page.evaluate(() => { document.getElementById('plan-deadline-on').checked = false; document.getElementById('plan-method').value = 'laps'; document.getElementById('plan-gap').value = 2; document.getElementById('plan-ranges').checked = false; updatePlannerForm(); runPlanner(); });
  check(await page.evaluate(() => currentPlan.plan.laps.every((l, i) => l >= 1 && l <= grades[i].laps)), 'fixed-gap plan keeps laps within the current number');
  await page.evaluate(() => { document.getElementById('plan-gap').value = 5; runPlanner(); });
  check(await page.evaluate(() => currentPlan.plan.feasible), 'a 5-minute fixed gap is achievable');
  await page.click('#plan-apply');
  check(await page.evaluate(() => catchEvents.length === 0 && grades.every((g, i) => i === 0 || Math.abs(g.start - grades[0].start) % 5 === 0)), "fixed-gap plan applied with no catches");

  // GPX course map with hills
  await page.evaluate(() => setRaceType('circuit'));
  const before = await page.evaluate(() => catchEvents.map(e => e.catchTime.toFixed(6)).join());
  await page.setInputFiles('#gpxFileInput', path.join(root, 'docs', 'sample-circuit.gpx'));
  await page.waitForFunction(() => course !== null);
  check(await page.evaluate(() => course.hasElevation && !warp.identity), 'GPX course loaded with hills');
  const after = await page.evaluate(() => catchEvents.map(e => e.catchTime.toFixed(6)).join());
  check(before === after, 'hills leave catch times unchanged');
  await scrubTo(page, 400);
  const moved = await page.evaluate(() => grades.some((g, i) => Math.abs(g.position - SimCore.stateAt(simResult.tracks[i], raceStartMinutes + raceElapsed).position) > 1e-3));
  check(moved, 'hills move riders along the course');
  await page.evaluate(() => { setDirection('clockwise'); setDirection('anticlockwise'); useCourseLength(); });
  check(await page.evaluate(() => Math.abs(lapLength - Math.round(course.lengthKm * 100) / 100) < 1e-9), 'lap length set from the map');
  for (const t of ['point', 'outback', 'circuit']) await page.evaluate(t => { setRaceType(t); const s = document.getElementById('raceSlider'); s.value = Math.floor(s.max / 2); s.dispatchEvent(new Event('input')); }, t);
  await page.evaluate(() => { document.getElementById('print-sheet').innerHTML = buildRaceSheet(); });
  check(await page.evaluate(() => /map: Sample park circuit/.test(document.getElementById('print-sheet').textContent)), 'race sheet names the course map');
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => saveRace())]);
  const file3 = path.join(os.tmpdir(), `race-map-${Date.now()}.json`);
  await dl3.saveAs(file3);
  await page.evaluate(() => clearCourse());
  await page.setInputFiles('#loadFileInput', file3);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => course && course.name === 'Sample park circuit'), 'course map saved and loaded');
  await page.evaluate(() => { clearCourse(); resetAllSetup(); });

  // Playback: animation frames, smooth and course-aware
  await page.evaluate(() => { resetRace(); setSpeed(1); playRace(); });
  await page.waitForTimeout(1500);
  const play = await page.evaluate(() => { const r = [raceRunning, raceElapsed, baseRaceMinutesPerSecond()]; pauseRace(); return r; });
  check(play[0] && Math.abs(play[1] - play[2] * 1.5) < play[2] * 0.25, `1× plays at the course-aware rate (${play[1].toFixed(2)} race-min in 1.5 s)`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();

  // 1. Served app (installable web app)
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(url);
  await exercise(page, 'Served app (index.html over http)');
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  check(sw, 'service worker installed');
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  check(manifest.display === 'standalone' && manifest.icons.length === 3, 'manifest is installable (standalone, icons)');
  await page.reload(); await page.waitForTimeout(300);
  await ctx.setOffline(true);
  await page.reload();
  check(await page.evaluate(() => !!window.SimCore && grades.length > 0), 'app reloads while offline');
  await ctx.close();

  // 2. Single-file build opened from disk
  const dist = path.join(root, 'dist', 'Professional_Cycling_Race_Simulator_v11.html');
  if (fs.existsSync(dist)) {
    const ctx2 = await browser.newContext({ acceptDownloads: true });
    const p2 = await ctx2.newPage();
    await p2.goto('file://' + dist);
    await exercise(p2, 'Single-file build (file://)');
    await ctx2.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();
