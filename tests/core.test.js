// Run with:  node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// Brute-force: step time finely and record every change of whole-lap gap (circuit)
// or sign of gap (linear) between a faster and a slower grade.
function bruteMeetings(raceType, L, f, s, dt = 0.0005) {
  const out = [];
  const t0 = Math.max(f.start, s.start), tEnd = Math.min(C.finishClockOf(f), C.finishClockOf(s));
  let prev = null;
  for (let t = t0 + dt; t <= tEnd; t += dt) {
    const gap = s.spd * (t - s.start) / 60 - f.spd * (t - f.start) / 60;
    const k = raceType === 'circuit' ? Math.floor(gap / L) : (gap >= 0 ? 0 : -1);
    if (prev !== null && k !== prev) out.push(t);
    prev = k;
  }
  return out;
}

function randomGrades(rand, n, raceType, L) {
  return Array.from({ length: n }, () => {
    const laps = 1 + Math.floor(rand() * 12);
    return {
      start: 540 + Math.floor(rand() * 15),
      spd: 26 + Math.round(rand() * 200) / 10,
      laps,
      totalDistance: raceType === 'circuit' ? laps * L : raceType === 'outback' ? 2 * L : L
    };
  });
}

test('formatting helpers', () => {
  assert.equal(C.toClock(540), '09:00');
  assert.equal(C.toClock(1450), '00:10'); // wraps past midnight
  assert.equal(C.toClockSec(540.5), '09:00:30');
  assert.equal(C.fromClock('09:30'), 570);
  assert.equal(C.formatDuration(59.7), '1h 0m');
  assert.equal(C.formatElapsed(61.5), '1:01:30');
  assert.equal(C.formatSplit(2.5), '2:30');
});

test('review example: every circuit meeting, in time order', () => {
  const A = { start: 544, spd: 44, totalDistance: 40 };
  const E = { start: 540, spd: 34, totalDistance: 40 };
  const evs = C.calculateCircuitCatches(A, E, 2);
  assert.deepEqual(evs.map(e => C.toClock(e.catchTime)), ['09:06', '09:18', '09:30', '09:42', '09:54']);
  assert.deepEqual(evs.map(e => e.lapsUp), [-1, 0, 1, 2, 3]);
});

test('review example: catch when the slower grade is less than a lap ahead', () => {
  const evs = C.calculateCircuitCatches({ start: 541, spd: 42, totalDistance: 20 }, { start: 540, spd: 34, totalDistance: 20 }, 2);
  assert.deepEqual(evs.map(e => C.toClock(e.catchTime)), ['09:05', '09:20']);
});

test('circuit catches match brute force on random races', () => {
  const rand = C.mulberry32(7);
  for (let n = 0; n < 150; n++) {
    const L = 0.5 + Math.round(rand() * 40) / 10;
    const [a, b] = randomGrades(rand, 2, 'circuit', L);
    const [f, s] = a.spd > b.spd ? [a, b] : [b, a];
    if (f.spd === s.spd) continue;
    const got = C.calculateCircuitCatches(f, s, L).map(e => e.catchTime);
    const want = bruteMeetings('circuit', L, f, s);
    assert.equal(got.length, want.length, `count for case ${n}`);
    got.forEach((t, k) => assert.ok(close(t, want[k], 0.002), `time ${t} vs ${want[k]}`));
  }
});

test('linear: same start is not a catch; faster starting first is never caught', () => {
  assert.equal(C.calculateLinearCatch({ start: 540, spd: 40, totalDistance: 10 }, { start: 540, spd: 30, totalDistance: 10 }), null);
  assert.equal(C.calculateLinearCatch({ start: 540, spd: 40, totalDistance: 10 }, { start: 545, spd: 30, totalDistance: 10 }), null);
  const r = C.calculateLinearCatch({ start: 545, spd: 40, totalDistance: 20 }, { start: 540, spd: 30, totalDistance: 20 });
  assert.ok(close(r.catchTime, 560) && close(r.fasterDistance, 10) && close(r.slowerDistance, 10));
});

test('simulateRace "continue" equals the pairwise analytic result', () => {
  const rand = C.mulberry32(11);
  for (const raceType of ['circuit', 'point', 'outback']) {
    for (let n = 0; n < 40; n++) {
      const L = 1 + Math.round(rand() * 30) / 10;
      const grades = randomGrades(rand, 2 + Math.floor(rand() * 7), raceType, L);
      const sim = C.simulateRace({ grades, raceType, lapLength: L, afterCatch: 'continue' });
      const want = [];
      grades.forEach((f, i) => grades.forEach((s, j) => {
        if (i !== j && f.spd > s.spd) C.findCatchEvents(raceType, L, f, s).forEach(e => want.push({ i, j, t: e.catchTime }));
      }));
      want.sort((a, b) => a.t - b.t);
      assert.equal(sim.events.length, want.length, `${raceType} case ${n}`);
      const norm = list => list.map(e => ({ i: e.i ?? e.c1Index, j: e.j ?? e.c2Index, t: e.t ?? e.catchTime }))
        .sort((a, b) => a.t - b.t || a.i - b.i || a.j - b.j);
      const got = norm(sim.events), exp = norm(want);
      got.forEach((e, k) => {
        assert.equal(`${e.i}-${e.j}`, `${exp[k].i}-${exp[k].j}`);
        assert.ok(close(e.t, exp[k].t), `time ${e.t} vs ${exp[k].t}`);
      });
      sim.tracks.forEach((tr, k) => assert.ok(close(tr.finishClock, C.finishClockOf(grades[k]))));
    }
  }
});

test('simulateRace "neutralise": caught grade stops and takes no further part', () => {
  const grades = [
    { start: 540, spd: 30, totalDistance: 20 },
    { start: 545, spd: 40, totalDistance: 20 },
    { start: 550, spd: 45, totalDistance: 20 }
  ];
  const sim = C.simulateRace({ grades, raceType: 'point', lapLength: 20, afterCatch: 'neutralise' });
  for (const ev of sim.events) {
    const t = sim.tracks[ev.c2Index].neutralisedAt;
    assert.ok(close(t, ev.catchTime), 'caught grade neutralised at the catch');
    assert.ok(!sim.events.some(e => e.catchTime > t + 1e-9 && (e.c1Index === ev.c2Index || e.c2Index === ev.c2Index)));
  }
  // Grade 0 is caught by grade 1 at 09:20 (10 km); with continue it would also be caught by grade 2.
  assert.equal(sim.events[0].c1Index, 1);
  assert.equal(sim.events.filter(e => e.c2Index === 0).length, 1);
  assert.equal(sim.tracks[0].finishClock, null);
  assert.equal(C.stateAt(sim.tracks[0], 600).neutralised, true);
});

test('simulateRace "merge": caught grade adopts the catcher speed, positions stay continuous', () => {
  const rand = C.mulberry32(3);
  for (let n = 0; n < 40; n++) {
    const L = 1.5;
    const grades = randomGrades(rand, 5, 'circuit', L);
    const sim = C.simulateRace({ grades, raceType: 'circuit', lapLength: L, afterCatch: 'merge' });
    for (const ev of sim.events) {
      const a = C.stateAt(sim.tracks[ev.c1Index], ev.catchTime - 1e-7);
      const b = C.stateAt(sim.tracks[ev.c2Index], ev.catchTime - 1e-7);
      const d = ((a.position - b.position) % L + L) % L;
      assert.ok(Math.min(d, L - d) < 1e-4, 'both grades at the same point on the lap');
    }
    for (const tr of sim.tracks) {
      for (let k = 1; k < tr.segments.length; k++) {
        const p = tr.segments[k - 1], s = tr.segments[k];
        assert.ok(close(p.d0 + p.v * (s.t0 - p.t0) / 60, s.d0), 'continuous position');
        assert.ok(s.v > p.v, 'merging only ever speeds a grade up');
      }
    }
  }
});

test('timeAtDistance is the inverse of stateAt', () => {
  const grades = [{ start: 540, spd: 30, totalDistance: 12 }, { start: 543, spd: 42, totalDistance: 12 }];
  const sim = C.simulateRace({ grades, raceType: 'circuit', lapLength: 2, afterCatch: 'merge' });
  for (const tr of sim.tracks) {
    for (const d of [0.5, 3, 7.25, 12]) {
      const t = C.timeAtDistance(tr, d);
      assert.ok(close(C.stateAt(tr, t).position, d, 1e-6));
    }
  }
});

test('risk analysis: deterministic without ranges, probabilities with ranges', () => {
  const base = [
    { start: 540, spd: 34, totalDistance: 12, range: 0 },
    { start: 544, spd: 40, totalDistance: 12, range: 0 }
  ];
  const det = C.analyseRisk({ grades: base, raceType: 'circuit', lapLength: 2, afterCatch: 'continue' });
  assert.equal(det.runs, 1);
  assert.equal(det.pairs.length, 1);
  assert.equal(det.pairs[0].probability, 1);

  const ranged = base.map(g => ({ ...g, range: 3 }));
  const r = C.analyseRisk({ grades: ranged, raceType: 'circuit', lapLength: 2, afterCatch: 'continue', runs: 400 });
  const p = r.pairs.find(x => x.c1Index === 1 && x.c2Index === 0);
  assert.ok(p.probability > 0 && p.probability <= 1);
  assert.ok(p.earliest <= det.pairs[0].earliest && p.latest >= det.pairs[0].earliest, 'window contains the nominal catch');
  const again = C.analyseRisk({ grades: ranged, raceType: 'circuit', lapLength: 2, afterCatch: 'continue', runs: 400 });
  assert.deepEqual(again, r, 'seeded, so repeatable');
});

function allPairsOk(grades, starts, opts) {
  const placed = grades.map((g, i) => ({ ...g, start: starts[i] }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < placed.length; j++) {
      const f = placed[i], s = placed[j];
      if (i === j || !(f.spd > s.spd)) continue;
      for (const ev of C.findCatchEvents(opts.raceType, opts.lapLength, f, s)) {
        if (C.violatesRule(opts.rule, opts.raceType, opts.lapLength, f, s, ev)) return false;
      }
    }
  }
  return true;
}

test('planner: "no catches" schedule really has no catches and respects the minimum gap', () => {
  const grades = [42, 40, 38, 36, 34].map((spd, i) => ({ spd, laps: 6 - i, totalDistance: 2 * (6 - i), range: 0 }));
  for (const order of ['slowest', 'fastest', 'current']) {
    const opts = { grades, raceType: 'circuit', lapLength: 2, raceStart: 540, order, minGap: 2, objective: 'compact', rule: { type: 'none' } };
    const plan = C.planStarts(opts);
    assert.ok(plan.feasible, order);
    assert.ok(allPairsOk(grades, plan.starts, opts), `${order}: no catches`);
    const sorted = plan.order.map(i => plan.starts[i]);
    sorted.slice(1).forEach((s, k) => assert.ok(s - sorted[k] >= 2, 'min gap'));
    assert.equal(Math.min(...plan.starts), 540);
  }
});

test('planner: "final laps" rule and speed ranges', () => {
  const grades = [42, 39, 36].map((spd, i) => ({ spd, laps: 10, totalDistance: 20, range: 1.5 }));
  const opts = { grades, raceType: 'circuit', lapLength: 2, raceStart: 540, order: 'slowest', minGap: 1, objective: 'compact', rule: { type: 'final', n: 3 }, useRanges: true };
  const plan = C.planStarts(opts);
  assert.ok(plan.feasible);
  for (const d of [-1.5, 0, 1.5]) {
    for (const e of [-1.5, 0, 1.5]) {
      const g2 = grades.map((g, k) => ({ ...g, spd: g.spd + (k === 0 ? d : k === 2 ? e : 0) }));
      assert.ok(allPairsOk(g2, plan.starts, opts), 'rule holds across the speed range');
    }
  }
});

test('planner: "finish together" brings finishes closer than "compact"', () => {
  const grades = [44, 40, 36, 32].map(spd => ({ spd, totalDistance: 30, range: 0 }));
  const base = { grades, raceType: 'point', lapLength: 30, raceStart: 540, order: 'slowest', minGap: 1, rule: { type: 'final', n: 2 } };
  const spread = plan => {
    const f = grades.map((g, i) => plan.starts[i] + g.totalDistance * 60 / g.spd);
    return Math.max(...f) - Math.min(...f);
  };
  const together = C.planStarts({ ...base, objective: 'together' });
  const compact = C.planStarts({ ...base, objective: 'compact' });
  assert.ok(spread(together) < spread(compact));
  assert.ok(allPairsOk(grades, together.starts, base));
});

// ---------- v11.3: planner rules, results import, course maps, share links ----------
const fs = require('fs');
const path = require('path');

test('planner: locked starts stay put and the rest fit around them', () => {
  const grades = [42, 40, 38, 36, 34].map((spd, i) => ({ spd, laps: 6 - i, totalDistance: 2 * (6 - i), range: 0 }));
  const opts = { grades, raceType: 'circuit', lapLength: 2, raceStart: 540, order: 'slowest', minGap: 1,
    objective: 'compact', rule: { type: 'none' }, locks: { 0: 545 } };
  const plan = C.planStarts(opts);
  assert.equal(plan.starts[0], 545, 'A keeps its locked start');
  assert.ok(allPairsOk(grades, plan.starts, opts));
  const sorted = plan.starts.slice().sort((a, b) => a - b);
  sorted.slice(1).forEach((s, k) => assert.ok(s - sorted[k] >= 1, 'min gap between all starts'));
});

test('planner: finish-by deadline cuts laps from the latest finishers', () => {
  const grades = [42, 40, 38, 36, 34].map((spd, i) => ({ spd, laps: 10, totalDistance: 20, range: 0 }));
  const base = { grades, raceType: 'circuit', lapLength: 2, raceStart: 540, order: 'slowest', minGap: 1, objective: 'compact', rule: { type: 'final', n: 2 } };
  const free = C.planStarts(base);
  const freeLast = Math.max(...grades.map((g, i) => free.starts[i] + g.totalDistance * 60 / g.spd));
  const deadline = Math.floor(freeLast) - 8;
  const plan = C.planStarts({ ...base, finishBy: deadline, allowLapCuts: true });
  assert.ok(plan.finishBy.met, 'deadline met');
  assert.ok(plan.laps.some(l => l < 10), 'some laps cut');
  const last = Math.max(...grades.map((g, i) => plan.starts[i] + plan.laps[i] * 2 * 60 / g.spd));
  assert.ok(last <= deadline + 1e-9);
  const g2 = grades.map((g, i) => ({ ...g, laps: plan.laps[i], totalDistance: plan.laps[i] * 2 }));
  assert.ok(allPairsOk(g2, plan.starts, base), 'rule still holds after the cuts');
  const strict = C.planStarts({ ...base, finishBy: 541, allowLapCuts: true });
  assert.equal(strict.finishBy.met, false, 'impossible deadline is reported');
  assert.equal(strict.feasible, false);
});

test('planner: fixed gaps choose the most laps that keep the rule', () => {
  const grades = [42, 40, 38, 36, 34].map(spd => ({ spd, laps: 12, totalDistance: 24, range: 0 }));
  const opts = { grades, raceType: 'circuit', lapLength: 2, raceStart: 540, order: 'slowest', method: 'laps', fixedGap: 2, rule: { type: 'none' } };
  const plan = C.planStarts(opts);
  const order = plan.order;
  order.forEach((i, k) => assert.equal(plan.starts[i], 540 + 2 * k, 'fixed gap'));
  const g2 = grades.map((g, i) => ({ ...g, laps: plan.laps[i], totalDistance: plan.laps[i] * 2 }));
  assert.ok(allPairsOk(g2, plan.starts, opts));
  assert.ok(plan.laps.every(l => l >= 1 && l <= 12));
  // One more lap for any grade (except those at the cap) would break the rule
  plan.laps.forEach((l, i) => {
    if (l >= 12) return;
    const g3 = g2.map((g, k) => k === i ? { ...g, laps: l + 1, totalDistance: (l + 1) * 2 } : g);
    const placedBefore = order.slice(0, order.indexOf(i) + 1);
    const sub = placedBefore.map(k => ({ ...g3[k], start: plan.starts[k] }));
    assert.ok(!allPairsOk(sub, sub.map(s => s.start), opts), `grade ${i} could not have ${l + 1} laps`);
  });
});

test('results: durations, CSV parsing and speed stats', () => {
  assert.ok(close(C.parseDuration('1:23:45'), 83.75));
  assert.ok(close(C.parseDuration('45:30'), 45.5));
  assert.ok(close(C.parseDuration('0:17:07.6'), 17 + 7.6 / 60));
  assert.ok(close(C.parseDuration('90', 'seconds'), 1.5));
  assert.deepEqual(C.parseCsv('a;b\n"x;y";2\n'), [['a', 'b'], ['x;y', '2']]);

  const res = C.readResults(fs.readFileSync(path.join(__dirname, '../docs/sample-results.csv'), 'utf8'));
  assert.equal(res.groups.length, 5);
  assert.equal(res.skipped, 1, 'DNF row skipped');
  const a = res.groups.find(g => g.label === 'A Grade');
  const st = C.speedStats(a.riders, 0, 2);
  assert.equal(st.n, 9);
  assert.ok(Math.abs(st.speed - 42) < 1.2, `A speed ${st.speed}`);
  assert.ok(st.range >= 0.5 && st.range <= 3);

  // Without distance info, the grade's configured distance is used
  const tOnly = C.readResults('Category,Elapsed\nB,0:15:00\nB,0:16:00\n');
  const st2 = C.speedStats(tOnly.groups[0].riders, 10, 2);
  assert.ok(close(st2.speed, 38.8, 1e-9), `B speed ${st2.speed}`); // median of 40 and 37.5
  assert.throws(() => C.readResults('Name,Time\nX,1:00\n'), /grade/);
});

test('course: GPX parsing, length and orientation', () => {
  const gpx = C.parseGpx(fs.readFileSync(path.join(__dirname, '../docs/sample-circuit.gpx'), 'utf8'));
  assert.equal(gpx.name, 'Sample park circuit');
  const course = C.buildCourse(gpx);
  assert.ok(course.closed && course.hasElevation);
  assert.ok(course.lengthKm > 1.6 && course.lengthKm < 2.4, `length ${course.lengthKm}`);
  assert.ok(course.points.length <= 400);
  assert.notEqual(Math.sign(C.signedArea(course.points)), 0);
  assert.throws(() => C.parseGpx('<gpx></gpx>'), /No track points/);
});

test('hills: the warp is monotonic, invertible and slows climbs', () => {
  const course = C.buildCourse(C.parseGpx(fs.readFileSync(path.join(__dirname, '../docs/sample-circuit.gpx'), 'utf8')));
  for (const kind of ['circuit', 'point', 'outback']) {
    const L = 2;
    const w = C.makeWarp(course, L, kind, 1);
    const span = kind === 'outback' ? 2 * L : L;
    let prev = -1;
    for (let k = 0; k <= 200; k++) {
      const x = (kind === 'circuit' ? 3 * span : span) * k / 200;
      const u = w.toU(x);
      assert.ok(u >= prev - 1e-12, 'monotonic');
      assert.ok(close(w.toX(u), x, 1e-9), 'invertible');
      prev = u;
    }
    assert.ok(close(w.toU(span), span, 1e-9), 'whole course takes the same total time');
  }
  // The sample's climb is on the second half of the lap (sin > 0 in the GPX's own direction)
  const w = C.makeWarp(course, 2, 'circuit', 1);
  const climbs = course.points.map((p, i) => i ? p[2] - course.points[i - 1][2] : 0);
  const iUp = climbs.indexOf(Math.max(...climbs)), iDown = climbs.indexOf(Math.min(...climbs));
  const at = i => 2 * i / (course.points.length - 1);
  const rate = i => (w.toU(at(i) + 0.005) - w.toU(at(i) - 0.005)) / 0.01;
  assert.ok(rate(iUp) > 1.1, 'more effort per km uphill');
  assert.ok(rate(iDown) < 0.95, 'less effort per km downhill');
  assert.equal(C.makeWarp(null, 2, 'circuit').identity, true);
  assert.equal(C.makeWarp(course, 2, 'circuit', 0).identity, true);
});

test('share links round-trip', async () => {
  const data = { raceName: 'Crit ✓', grades: [{ name: 'A', spd: 42 }], course: { points: [[1.5, -2, 30]] } };
  const z = await C.encodeShare(data);
  assert.ok(z.startsWith('z'), 'compressed');
  assert.deepEqual(await C.decodeShare(z), data);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(z.slice(1)), 'URL-safe');
});

// ---------- Real MyLaps (Orbits Cycling → Sporthive) exports, riders anonymised ----------
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', `sporthive-${name}.csv`), 'utf8');

test('Sporthive: columns, lap length, DNFs and lapped riders (Pickering Brook)', () => {
  const res = C.readResults(fixture('pickering-brook'));
  const h = i => res.headers[i];
  assert.equal(h(res.columns.grade), 'Class');
  assert.equal(h(res.columns.time), 'Total Time');
  assert.equal(res.columns.speed, -1, 'Best Speed is a best lap, not the race speed');
  assert.equal(h(res.columns.laps), 'Laps');
  assert.equal(res.lapKm, 7.6, 'lap length from best lap × best speed');
  assert.equal(res.skipped, 9, 'DNF/DNS rows (0.000) skipped');
  const want = { MA: [10, 23, 8, 42.39, 107.12], MB: [8, 30, 3, 40.54, 89.72], MC: [6, 25, 8, 37.67, 72.56], MD: [6, 11, 3, 32.55, 82.13] };
  for (const [label, [laps, n, short, median, winner]] of Object.entries(want)) {
    const g = res.groups.find(x => x.label === label);
    assert.equal(g.fullLaps, laps, `${label} laps`);
    assert.equal(g.shortCount, short, `${label} lapped/pulled riders`);
    const st = C.speedStats(g.riders, 0, res.lapKm);
    assert.equal(st.n, n, `${label} riders counted`);
    assert.ok(Math.abs(st.median - median) < 0.01, `${label} median ${st.median}`);
    assert.ok(Math.abs(st.winnerMinutes - winner) < 0.01, `${label} winner ${st.winnerMinutes}`);
  }
});

test('Sporthive: Midland Traders 100 (17.5 km lap) and a road race without lap speeds', () => {
  const mid = C.readResults(fixture('midland-100'));
  assert.equal(mid.lapKm, 17.5);
  const mb = mid.groups.find(g => g.label === 'MB');
  assert.equal(mb.fullLaps, 4);
  assert.ok(Math.abs(C.speedStats(mb.riders, 0, mid.lapKm).median - 39.14) < 0.01);

  const road = C.readResults(fixture('road-champs'));
  assert.equal(road.lapKm, null, 'no best speeds, so no lap length');
  assert.equal(road.groups.length, 21);
  const elite = road.groups.find(g => g.label === 'MElite');
  // Distance must come from the planned race (e.g. 120 km); 1 lap here means the whole course
  const st = C.speedStats(elite.riders, 0, 120);
  assert.ok(st.n === 19 && st.median > 30 && st.median < 45, `elite median ${st.median}`);
});

test('grade names from different seasons map to the same grade', () => {
  const same = (labels, key) => labels.forEach(l => assert.equal(C.gradeKey(l), key, l));
  same(['A', 'A Grade', 'MA', 'M A', 'A MEN', 'Men A', 'a grade'], 'A');
  same(['WA', 'Womens A', "Women's A", 'A WOMEN', 'W A'], 'WA');
  same(['E', 'ME'], 'E');
  same(['OPEN', 'M_OPEN', 'Mens Open'], 'OPEN');
  same(['W_OPEN', 'Womens Open'], 'WOPEN');
  assert.equal(C.gradeKey('JM19'), 'JM19');
  assert.equal(C.gradeKey('MMAS3'), 'MMAS3');
});

test('history suggestion: recent median, combined ± range and trend', () => {
  const recs = [
    { date: '2026-03-01', speed: 44, range: 0.5 }, { date: '2026-02-01', speed: 43, range: 0.5 },
    { date: '2026-01-01', speed: 42, range: 0.5 }, { date: '2025-12-01', speed: 41, range: 0.5 },
    { date: '2025-11-01', speed: 40, range: 0.5 }, { date: '2025-10-01', speed: 39, range: 0.5 },
    { date: '2019-01-01', speed: 30, range: 0.5 }
  ];
  const s = C.historySuggestion(recs, 6);
  assert.equal(s.races, 6, 'only the latest 6');
  assert.equal(s.speed, 41.5);
  assert.ok(s.range >= 2 && s.range <= 2.5, `range ${s.range} reflects race-to-race spread, not just ±0.5`);
  assert.ok(s.trend > 2, 'getting faster');
  assert.equal(s.last, '2026-03-01');
  assert.equal(C.historySuggestion([], 6), null);
  assert.equal(C.historySuggestion([{ date: 'x', speed: 40, range: 0.5 }], 6).range, 0.5);
});

test('built-in club history is well formed and has no names', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/history-data.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  const h = sandbox.window.BUILTIN_HISTORY;
  assert.ok(h.races.length > 100);
  for (const r of h.races) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c && r.l > 0 && r.g.length);
    for (const g of r.g) assert.ok(g.length === 6 && g[3] >= 10 && g[3] <= 70, JSON.stringify(g));
  }
  const smeaton = h.races.filter(r => r.c === 'Rockingham Smeaton Way');
  const b = smeaton.flatMap(r => r.g.filter(g => C.gradeKey(g[0]) === 'B').map(g => ({ date: r.d, speed: g[3], range: g[4] })));
  const s = C.historySuggestion(b, 6);
  assert.ok(s.speed > 40 && s.speed < 46, `Smeaton B ${s.speed}`);
});

test('version and update date agree everywhere', () => {
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const app = read('js/app/state.js');
  const version = app.match(/const APP_VERSION = '([\d.]+)'/)[1];
  const updated = app.match(/const APP_UPDATED = '(\d{4}-\d{2}-\d{2})'/)[1];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'full major.minor.patch version');
  assert.ok(!isNaN(Date.parse(updated)), 'valid update date');
  assert.equal(JSON.parse(read('package.json')).version, version, 'package.json');
  assert.equal(read('sw.js').match(/const VERSION = 'race-sim-v([\d.]+)'/)[1], version, 'sw.js cache version');
  const html = read('index.html');
  assert.ok(html.includes(`v${version}</span>`) && html.includes(`Version ${version} · updated`), 'index.html first-paint text');
});
