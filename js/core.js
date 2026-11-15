/*
 * Cycling Race Simulator — race engine (no DOM).
 *
 * Everything in here is pure: given grades and course settings it returns
 * results. The page (js/app.js) and the tests (tests/core.test.js) both use it.
 *
 * Units: times are clock minutes since midnight, distances are km, speeds km/h.
 * A grade is { start, spd, totalDistance, laps?, range? }.
 */
(function (root) {
  'use strict';

  const EPS = 1e-9;

  // ---------- Formatting ----------

  function toClock(minutes) {
    let m = Math.round(minutes);
    m = ((m % 1440) + 1440) % 1440;
    const hh = Math.floor(m / 60), mm = m % 60;
    return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
  }

  function toClockSec(minutes) {
    let s = Math.round(minutes * 60);
    s = ((s % 86400) + 86400) % 86400;
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function fromClock(timestr) {
    if (!timestr) return NaN;
    const [hh, mm] = String(timestr).split(':').map(Number);
    return hh * 60 + mm;
  }

  function formatDuration(minutes) {
    let hrs = Math.floor(minutes / 60);
    let mins = Math.round(minutes % 60);
    if (mins === 60) { hrs += 1; mins = 0; }
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  }

  // Elapsed time as H:MM:SS.
  function formatElapsed(minutes) {
    const total = Math.max(0, Math.round(minutes * 60));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Lap time etc. as M:SS (or H:MM:SS when over an hour).
  function formatSplit(minutes) {
    const total = Math.max(0, Math.round(minutes * 60));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function finishClockOf(g) {
    return g.start + (g.totalDistance * 60) / g.spd;
  }

  // ---------- Pairwise catch maths (constant speeds) ----------

  // Every on-road meeting between a faster and a slower grade on a circuit, in time order.
  // A meeting happens whenever the distance gap (slower - faster) is a whole number of laps k:
  //   k > 0  faster rider reaches the slower group, which is k laps ahead in race distance
  //   k = 0  faster draws level on equal distance
  //   k < 0  faster laps the slower group (|k| laps up)
  function calculateCircuitCatches(faster, slower, lapLength) {
    if (!(faster.spd > slower.spd) || !(lapLength > 0)) return [];
    const t0 = Math.max(faster.start, slower.start);
    const tEnd = Math.min(finishClockOf(faster), finishClockOf(slower));
    if (!(tEnd > t0)) return [];

    const speedDiff = slower.spd - faster.spd; // negative
    const gapAt = t => slower.spd * (t - slower.start) / 60 - faster.spd * (t - faster.start) / 60;
    const kHigh = Math.floor(gapAt(t0) / lapLength + EPS);
    const kLow = Math.ceil(gapAt(tEnd) / lapLength - EPS);

    const events = [];
    for (let k = kHigh; k >= kLow; k--) { // decreasing k = increasing time
      const t = (k * lapLength * 60 + slower.spd * slower.start - faster.spd * faster.start) / speedDiff;
      if (t <= t0 + EPS || t > tEnd + EPS) continue;
      events.push({
        catchTime: t,
        lapsUp: k === 0 ? 0 : -k,
        fasterDistance: Math.min(faster.totalDistance, faster.spd * (t - faster.start) / 60),
        slowerDistance: Math.min(slower.totalDistance, slower.spd * (t - slower.start) / 60)
      });
    }
    return events;
  }

  // Point-to-point / out-and-back: the faster grade catches only if it starts behind.
  function calculateLinearCatch(faster, slower) {
    if (faster.spd <= slower.spd || faster.start < slower.start) return null;
    const head = slower.spd * ((faster.start - slower.start) / 60);
    const after = head / (faster.spd - slower.spd) * 60;
    if (!(after > 0)) return null; // same start: no head start, not a catch
    const catchTime = faster.start + after;
    const fasterDist = faster.spd * (after / 60);
    const slowerDist = slower.spd * ((catchTime - slower.start) / 60);
    if (fasterDist <= faster.totalDistance && slowerDist <= slower.totalDistance) {
      return { catchTime, lapsUp: 0, fasterDistance: fasterDist, slowerDistance: slowerDist };
    }
    return null;
  }

  function findCatchEvents(raceType, lapLength, faster, slower) {
    if (raceType === 'circuit') return calculateCircuitCatches(faster, slower, lapLength);
    const r = calculateLinearCatch(faster, slower);
    return r ? [r] : [];
  }

  // ---------- Full race simulation with after-catch rules ----------

  /*
   * Event-driven simulation. Each grade moves at constant speed in segments;
   * a catch can change that, depending on `afterCatch`:
   *   'continue'   both grades carry on unchanged (the classic model)
   *   'neutralise' the caught grade is taken out of the race at the catch
   *   'merge'      the caught grade joins the catchers and rides at their speed
   *
   * Returns { events, tracks, endClock } where each track is
   *   { segments: [{ t0, d0, v }], total, start, finishClock|null, neutralisedAt|null }
   */
  function simulateRace(opts) {
    const { grades, raceType, lapLength } = opts;
    const afterCatch = opts.afterCatch || 'continue';
    const n = grades.length;
    const tracks = grades.map(g => ({
      segments: [{ t0: g.start, d0: 0, v: g.spd }],
      total: g.totalDistance,
      start: g.start,
      neutralisedAt: null,
      finishClock: null
    }));

    const last = tr => tr.segments[tr.segments.length - 1];
    const finishOf = tr => { const s = last(tr); return s.t0 + (tr.total - s.d0) * 60 / s.v; };
    const posLast = (tr, t) => { const s = last(tr); return s.d0 + s.v * (t - s.t0) / 60; };

    // Next meeting of faster i with slower j: after the pair's previous event (strict),
    // at or after the global clock T (inclusive), after both have started (strict).
    function nextMeeting(i, j, pairAfter, T) {
      const f = tracks[i], s = tracks[j];
      const F = last(f), S = last(s);
      if (!(F.v > S.v)) return null;
      const tStrict = Math.max(pairAfter, f.start, s.start);
      const tA = Math.max(tStrict, T);
      const tB = Math.min(finishOf(f), finishOf(s));
      if (tB < tA - EPS) return null;
      const gapA = posLast(s, tA) - posLast(f, tA);
      const dv = (S.v - F.v) / 60; // gap slope per minute (negative)
      const candidates = [];
      if (raceType === 'circuit') {
        const k0 = Math.floor(gapA / lapLength + EPS);
        candidates.push(k0, k0 - 1);
      } else {
        if (gapA < -EPS) return null; // faster already ahead
        candidates.push(0);
      }
      for (const k of candidates) {
        const t = tA + (k * (raceType === 'circuit' ? lapLength : 0) - gapA) / dv;
        if (t <= tStrict + EPS || t < T - EPS || t > tB + EPS) continue;
        return {
          t,
          lapsUp: k === 0 ? 0 : -k,
          fasterDistance: Math.min(f.total, posLast(f, t)),
          slowerDistance: Math.min(s.total, posLast(s, t))
        };
      }
      return null;
    }

    const events = [];
    const pairLast = new Map();
    let T = -Infinity;
    for (let guard = 0; guard < 20000; guard++) {
      let best = null;
      for (let i = 0; i < n; i++) {
        if (tracks[i].neutralisedAt !== null) continue;
        for (let j = 0; j < n; j++) {
          if (i === j || tracks[j].neutralisedAt !== null) continue;
          const key = i * n + j;
          const ev = nextMeeting(i, j, pairLast.has(key) ? pairLast.get(key) : -Infinity, T);
          if (ev && (!best || ev.t < best.t - EPS)) best = { ...ev, i, j, key };
        }
      }
      if (!best) break;

      T = best.t;
      pairLast.set(best.key, best.t);
      const pairCount = events.filter(e => e.c1Index === best.i && e.c2Index === best.j).length;
      events.push({
        key: `${best.i}-${best.j}-${pairCount}`,
        c1Index: best.i,
        c2Index: best.j,
        catchTime: best.t,
        lapsUp: best.lapsUp,
        fasterDistance: best.fasterDistance,
        slowerDistance: best.slowerDistance
      });

      const caught = tracks[best.j];
      if (afterCatch === 'neutralise') {
        caught.neutralisedAt = best.t;
      } else if (afterCatch === 'merge') {
        caught.segments.push({ t0: best.t, d0: posLast(caught, best.t), v: last(tracks[best.i]).v });
      }
    }

    let endClock = -Infinity;
    for (const tr of tracks) {
      if (tr.neutralisedAt === null) tr.finishClock = finishOf(tr);
      endClock = Math.max(endClock, tr.neutralisedAt !== null ? tr.neutralisedAt : tr.finishClock);
    }
    return { events, tracks, endClock };
  }

  // State of one grade at clock time t.
  function stateAt(track, t) {
    if (t < track.start) {
      return { started: false, position: 0, speed: track.segments[0].v, finished: false, neutralised: false };
    }
    if (track.neutralisedAt !== null && t >= track.neutralisedAt) {
      const p = distanceAt(track, track.neutralisedAt);
      return { started: true, position: p, speed: 0, finished: false, neutralised: true };
    }
    const finished = track.finishClock !== null && t >= track.finishClock;
    let seg = track.segments[0];
    for (const s of track.segments) { if (s.t0 <= t) seg = s; }
    return {
      started: true,
      position: finished ? track.total : Math.min(track.total, seg.d0 + seg.v * (t - seg.t0) / 60),
      speed: seg.v,
      finished,
      neutralised: false
    };
  }

  function distanceAt(track, t) {
    let seg = track.segments[0];
    for (const s of track.segments) { if (s.t0 <= t) seg = s; }
    return Math.min(track.total, Math.max(0, seg.d0 + seg.v * (t - seg.t0) / 60));
  }

  // Clock time at which a grade reaches distance d (null if it never does).
  function timeAtDistance(track, d) {
    if (d <= 0) return track.start;
    for (let k = 0; k < track.segments.length; k++) {
      const s = track.segments[k];
      const end = k + 1 < track.segments.length ? track.segments[k + 1].t0 : Infinity;
      const t = s.t0 + (d - s.d0) * 60 / s.v;
      if (t >= s.t0 - EPS && t <= end + EPS) {
        if (track.neutralisedAt !== null && t > track.neutralisedAt + EPS) return null;
        return t;
      }
    }
    return null;
  }

  // ---------- Speed-range (risk) analysis ----------

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /*
   * Runs the race many times with each grade's speed drawn uniformly from
   * [spd - range, spd + range] and reports, for every pair that meets in any run,
   * how often it happens and the window for their first meeting.
   */
  function analyseRisk(opts) {
    const { grades, raceType, lapLength, afterCatch } = opts;
    const anyRange = grades.some(g => g.range > 0);
    const runs = anyRange ? (opts.runs || 300) : 1;
    const rand = mulberry32(opts.seed || 12345);
    const pairs = new Map();

    for (let r = 0; r < runs; r++) {
      const sample = grades.map(g => {
        const v = g.range > 0 ? g.spd + (rand() * 2 - 1) * g.range : g.spd;
        return { ...g, spd: Math.max(1, v) };
      });
      const sim = simulateRace({ grades: sample, raceType, lapLength, afterCatch });
      const seen = new Set();
      for (const ev of sim.events) {
        const key = `${ev.c1Index}-${ev.c2Index}`;
        if (seen.has(key)) continue; // first meeting of the pair only
        seen.add(key);
        let p = pairs.get(key);
        if (!p) {
          p = { c1Index: ev.c1Index, c2Index: ev.c2Index, count: 0, earliest: Infinity, latest: -Infinity, distMin: Infinity, distMax: -Infinity };
          pairs.set(key, p);
        }
        p.count++;
        p.earliest = Math.min(p.earliest, ev.catchTime);
        p.latest = Math.max(p.latest, ev.catchTime);
        p.distMin = Math.min(p.distMin, ev.slowerDistance);
        p.distMax = Math.max(p.distMax, ev.slowerDistance);
      }
    }

    const result = [...pairs.values()].map(p => ({ ...p, probability: p.count / runs }));
    result.sort((a, b) => b.probability - a.probability || a.earliest - b.earliest);
    return { runs, deterministic: !anyRange, pairs: result };
  }

  // ---------- Start-gap planner ----------

  // Does a catch event break the planning rule?
  function violatesRule(rule, raceType, lapLength, faster, slower, ev) {
    if (rule.type === 'none') return true;
    // 'final': no catch while either grade is within its final N laps (circuit) or N km.
    const remF = faster.totalDistance - ev.fasterDistance;
    const remS = slower.totalDistance - ev.slowerDistance;
    const limit = raceType === 'circuit' ? rule.n * lapLength : rule.n;
    return remF < limit - EPS || remS < limit - EPS;
  }

  function speedOptions(g, useRanges) {
    if (!useRanges || !(g.range > 0)) return [g.spd];
    return [g.spd - g.range, g.spd, g.spd + g.range].map(v => Math.max(1, v));
  }

  // Pairwise check of a candidate against already placed grades.
  function pairOk(a, b, opts) {
    for (const va of speedOptions(a, opts.useRanges)) {
      for (const vb of speedOptions(b, opts.useRanges)) {
        const A = { ...a, spd: va }, B = { ...b, spd: vb };
        if (A.spd === B.spd) continue;
        const [f, s] = A.spd > B.spd ? [A, B] : [B, A];
        const evs = findCatchEvents(opts.raceType, opts.lapLength, f, s);
        if (evs.some(ev => violatesRule(opts.rule, opts.raceType, opts.lapLength, f, s, ev))) return false;
      }
    }
    return true;
  }

  /*
   * Plan a race.
   *
   * method 'starts' (default): grades are placed one at a time in the chosen order;
   *   each gets the earliest whole-minute start (at least `minGap` from every start
   *   already placed) that keeps the rule against every grade already placed.
   *   Grades in `locks` ({ index: clockMinutes }) keep that start and are placed first.
   * method 'laps' (circuits): starts are fixed at `fixedGap` minutes apart in the
   *   chosen order, and each grade gets the most laps (up to its current number)
   *   that keep the rule.
   *
   *   order:     'slowest' | 'fastest' | 'current'
   *   objective: 'compact'  – shortest overall race
   *              'together' – aim for everyone to finish at about the same time
   *   rule:      { type: 'none' } or { type: 'final', n }
   *   finishBy:  optional clock time everyone must have finished by. On circuits,
   *              with allowLapCuts, laps are taken off the latest finishers until it fits.
   *
   * Returns { starts, laps, order, notes, feasible, finishBy: { met, lastFinish } }.
   */
  function planStarts(opts) {
    const { grades, raceStart } = opts;
    const circuit = opts.raceType === 'circuit';
    const laps = grades.map(g => g.laps || 1);
    const withLaps = (g, i) => circuit ? { ...g, laps: laps[i], totalDistance: laps[i] * opts.lapLength } : g;

    let result = planOnce(grades.map(withLaps), opts);
    if (opts.method === 'laps' && circuit) laps.splice(0, laps.length, ...result.laps);

    // Finish-by deadline: trim laps from the latest finisher and plan again.
    const slowSpd = g => (opts.useRanges && g.range > 0) ? Math.max(1, g.spd - g.range) : g.spd;
    const lastFinish = (starts, gs) => Math.max(...gs.map((g, i) => starts[i] + g.totalDistance * 60 / slowSpd(g)));
    let finishInfo = null;
    if (opts.finishBy !== undefined && opts.finishBy !== null && isFinite(opts.finishBy)) {
      let gs = grades.map(withLaps);
      let last = lastFinish(result.starts, gs);
      let guard = 0;
      while (last > opts.finishBy + EPS && circuit && opts.allowLapCuts && guard++ < 400) {
        let worst = -1, worstT = -Infinity;
        gs.forEach((g, i) => {
          const t = result.starts[i] + g.totalDistance * 60 / slowSpd(g);
          if (laps[i] > 1 && t > worstT) { worst = i; worstT = t; }
        });
        if (worst < 0) break;
        laps[worst]--;
        gs = grades.map(withLaps);
        result = planOnce(gs, opts);
        if (opts.method === 'laps') laps.splice(0, laps.length, ...result.laps.map((l, i) => Math.min(l, laps[i])));
        gs = grades.map(withLaps);
        last = lastFinish(result.starts, gs);
      }
      finishInfo = { met: last <= opts.finishBy + EPS, lastFinish: last };
      if (!finishInfo.met) {
        result.notes.push({ index: null, message: circuit && opts.allowLapCuts
          ? 'Even with laps cut to the minimum, the last grade finishes after the deadline.'
          : 'The last grade finishes after the deadline.' });
      }
    }

    return {
      starts: result.starts,
      laps: circuit ? laps.slice() : grades.map(() => 1),
      order: result.order,
      notes: result.notes,
      feasible: result.notes.length === 0,
      finishBy: finishInfo
    };
  }

  function orderOf(grades, order) {
    const idx = grades.map((g, i) => i);
    if (order === 'slowest') idx.sort((a, b) => grades[a].spd - grades[b].spd || a - b);
    else if (order === 'fastest') idx.sort((a, b) => grades[b].spd - grades[a].spd || a - b);
    return idx;
  }

  function planOnce(grades, opts) {
    const minGap = Math.max(0, Math.round(opts.minGap ?? 1));
    const maxSearch = opts.maxSearch ?? 240;
    const locks = opts.locks || {};
    const notes = [];
    const starts = new Array(grades.length).fill(null);
    const placed = [];

    if (opts.method === 'laps' && opts.raceType === 'circuit') {
      const gap = Math.max(0, Math.round(opts.fixedGap ?? minGap));
      const idx = orderOf(grades, opts.order);
      const laps = grades.map(g => g.laps || 1);
      idx.forEach((i, k) => {
        const g = grades[i];
        const s = opts.raceStart + k * gap;
        let chosen = null;
        for (let l = laps[i]; l >= 1; l--) {
          const cand = { ...g, start: s, laps: l, totalDistance: l * opts.lapLength };
          if (placed.every(p => pairOk(cand, p, opts))) { chosen = l; break; }
        }
        if (chosen === null) {
          chosen = 1;
          notes.push({ index: i, message: 'Even one lap breaks the rule for this grade at this gap.' });
        }
        laps[i] = chosen;
        starts[i] = s;
        placed.push({ ...g, start: s, laps: chosen, totalDistance: chosen * opts.lapLength });
      });
      return { starts, laps, order: idx, notes };
    }

    // Locked grades keep their start and are placed first.
    for (const [k, v] of Object.entries(locks)) {
      const i = +k;
      if (grades[i] && isFinite(v)) {
        starts[i] = v;
        placed.push({ ...grades[i], start: v });
      }
    }
    const idx = orderOf(grades, opts.order).filter(i => starts[i] === null);
    const duration = g => g.totalDistance * 60 / g.spd;
    let prev = null, targetFinish = null;
    if (opts.objective === 'together' && placed.length) {
      targetFinish = Math.max(...placed.map(p => p.start + duration(p)));
    }

    for (const i of idx) {
      const g = grades[i];
      let base = prev === null ? opts.raceStart : prev + minGap;
      if (opts.objective === 'together') {
        if (targetFinish === null) targetFinish = base + duration(g);
        base = Math.max(base, Math.ceil(targetFinish - duration(g) - EPS));
      }
      let chosen = null;
      for (let s = base; s <= base + maxSearch; s++) {
        if (placed.some(p => Math.abs(p.start - s) < minGap - EPS)) continue;
        const cand = { ...g, start: s };
        if (placed.every(p => pairOk(cand, p, opts))) { chosen = s; break; }
      }
      if (chosen === null) {
        chosen = base;
        notes.push({ index: i, message: `No start within ${maxSearch} min keeps the rule for this grade; using the earliest allowed start.` });
      }
      starts[i] = chosen;
      placed.push({ ...g, start: chosen });
      prev = chosen;
    }

    // Locked grades that break the rule between themselves are reported, not moved.
    const lockedIdx = Object.keys(locks).map(Number).filter(i => grades[i]);
    for (let a = 0; a < lockedIdx.length; a++) {
      for (let b = a + 1; b < lockedIdx.length; b++) {
        const A = { ...grades[lockedIdx[a]], start: starts[lockedIdx[a]] };
        const B = { ...grades[lockedIdx[b]], start: starts[lockedIdx[b]] };
        if (!pairOk(A, B, opts)) notes.push({ index: lockedIdx[b], message: 'Two locked grades break the rule between themselves.' });
      }
    }
    return { starts, laps: grades.map(g => g.laps || 1), order: orderOf(grades, opts.order), notes };
  }

  // ---------- Results import (calibration) ----------

  // Minimal CSV parser: quoted fields, and comma, semicolon or tab delimiters.
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = [',', ';', '\t'].map(d => [d, (firstLine.match(new RegExp(d === '\t' ? '\\t' : d, 'g')) || []).length]);
    const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field.trim()); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim()); field = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field.trim());
    if (row.some(v => v !== '')) rows.push(row);
    return rows;
  }

  // Duration in minutes from "1:23:45", "83:45" (min:sec), "1:23:45.6" or plain minutes.
  function parseDuration(v, unitHint) {
    if (v === undefined || v === null) return NaN;
    const s = String(v).trim().replace(',', '.');
    if (!s) return NaN;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s);
      return unitHint === 'seconds' ? n / 60 : unitHint === 'hours' ? n * 60 : n;
    }
    const parts = s.split(':').map(Number);
    if (parts.some(p => !isFinite(p))) return NaN;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    if (parts.length === 2) return parts[0] + parts[1] / 60;
    return NaN;
  }

  function findColumn(headers, patterns, exclude) {
    for (const re of patterns) {
      const i = headers.findIndex(h => re.test(h) && !(exclude && exclude.test(h)));
      if (i >= 0) return i;
    }
    return -1;
  }

  /*
   * Read a results CSV, including MyLaps Orbits / Sporthive / Speedhive exports
   * (Pos, Start Number, Competitor, Class, Total Time, Diff, Laps, Best Lap, Best Lap No., Best Speed).
   *
   * Returns {
   *   columns, headers, skipped,
   *   lapKm,                       lap length worked out from best lap × best speed, or null
   *   groups: [{ label, fullLaps, shortCount, riders: [{ minutes, speed, distance, laps, short }] }]
   * }
   * DNF/DNS/DQ rows and rows without a time are skipped. Riders who finished fewer laps than
   * most of their group (lapped or pulled) are kept but marked `short`.
   */
  function readResults(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('The file has no result rows.');
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const notRaceTime = /start|gap|behind|\blap|pace|best|diff|of day|clock/;
    const col = {
      grade: findColumn(headers, [/^grade$/, /grade/, /^class$/, /^cat(egory)?\b/, /categor/, /class/, /division/, /^race$/]),
      time: findColumn(headers, [/total ?time/, /elapsed/, /race ?time/, /finish ?time/, /duration/, /^time$/, /time/, /result/], notRaceTime),
      speed: findColumn(headers, [/av(era)?g\.? ?speed|speed ?av(era)?g/, /^speed$/, /speed/, /km\/h/, /kph/], /best|max|top|fastest/),
      distance: findColumn(headers, [/dist/, /^km$/, /\bkm\b/], /km\/h|speed/),
      laps: findColumn(headers, [/^laps?$/, /laps/], /best|no\.?$|number|behind/),
      status: findColumn(headers, [/status/, /dnf/]),
      bestLap: findColumn(headers, [/^best ?lap$/, /best ?lap ?time/, /fastest ?lap$/], /no\.?$|number|#/),
      bestSpeed: findColumn(headers, [/best ?speed/, /top ?speed/, /max ?speed/])
    };
    if (col.grade < 0) throw new Error('No grade or category column found.');
    if (col.time < 0 && col.speed < 0) throw new Error('No time or speed column found.');
    const unit = col.time >= 0 ? (/sec/.test(headers[col.time]) ? 'seconds' : /hour|\(h\)/.test(headers[col.time]) ? 'hours' : 'minutes') : null;
    const num = v => parseFloat(String(v ?? '').replace(',', '.'));

    const groups = new Map();
    const lapKms = [];
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const label = (r[col.grade] || '').trim();
      const status = col.status >= 0 ? String(r[col.status] || '') : '';
      if (!label || /\b(dnf|dns|dsq|dq|otl|abd|dnc)\b/i.test(status)) { skipped++; continue; }
      const rider = {
        minutes: col.time >= 0 ? parseDuration(r[col.time], unit) : NaN,
        speed: col.speed >= 0 ? num(r[col.speed]) : NaN,
        distance: col.distance >= 0 ? num(r[col.distance]) : NaN,
        laps: col.laps >= 0 ? num(r[col.laps]) : NaN,
        short: false
      };
      if (!(rider.minutes > 0) && !(rider.speed > 0)) { skipped++; continue; }
      if (col.bestLap >= 0 && col.bestSpeed >= 0) {
        const t = parseDuration(r[col.bestLap], 'minutes'), v = num(r[col.bestSpeed]);
        if (t > 0 && v > 0) lapKms.push(v * t / 60);
      }
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(rider);
    }

    // Lap length: timing systems compute best speed from the configured lap length,
    // so every rider gives (almost) the same figure. Only trust it when they agree.
    let lapKm = null;
    if (lapKms.length >= 3) {
      lapKms.sort((a, b) => a - b);
      const med = quantile(lapKms, 0.5), lo = quantile(lapKms, 0.1), hi = quantile(lapKms, 0.9);
      if (med > 0.2 && med < 100 && (hi - lo) / med < 0.02) lapKm = Math.round(med * 100) / 100;
    }

    const out = [...groups].map(([label, riders]) => {
      // Full distance = the most common lap count (the larger one on a tie)
      const counts = new Map();
      riders.forEach(r => { if (r.laps > 0) counts.set(r.laps, (counts.get(r.laps) || 0) + 1); });
      let fullLaps = null, best = 0;
      counts.forEach((c, l) => { if (c > best || (c === best && l > fullLaps)) { best = c; fullLaps = l; } });
      let shortCount = 0;
      if (fullLaps) riders.forEach(r => { if (r.laps > 0 && r.laps < fullLaps) { r.short = true; shortCount++; } });
      return { label, fullLaps, shortCount, riders };
    });
    return { columns: col, headers: rows[0], groups: out, skipped, lapKm };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /*
   * Speed statistics for one group of riders. Distance per rider comes from, in order:
   * a distance column, laps × `lapLength`, or `distanceKm` (the grade's planned distance).
   * Riders marked `short` (lapped or pulled) and speeds outside 10–70 km/h are ignored.
   * Also returns the winner's and the median rider's elapsed time.
   */
  function speedStats(riders, distanceKm, lapLength) {
    const speeds = [], times = [];
    for (const r of riders) {
      if (r.short) continue;
      let v = r.speed;
      if (!(v > 0) && r.minutes > 0) {
        const d = r.distance > 0 ? r.distance : (r.laps > 0 && lapLength > 0 ? r.laps * lapLength : distanceKm);
        if (d > 0) v = d / (r.minutes / 60);
      }
      if (v >= 10 && v <= 70) {
        speeds.push(v);
        if (r.minutes > 0) times.push(r.minutes);
      }
    }
    speeds.sort((a, b) => a - b);
    times.sort((a, b) => a - b);
    if (!speeds.length) return { n: 0 };
    const median = quantile(speeds, 0.5);
    const spread = (quantile(speeds, 0.9) - quantile(speeds, 0.1)) / 2;
    return {
      n: speeds.length,
      median,
      min: speeds[0],
      max: speeds[speeds.length - 1],
      speed: Math.round(median * 10) / 10,
      range: speeds.length === 1 ? 1 : Math.max(0.5, Math.round(spread * 2) / 2),
      winnerMinutes: times.length ? times[0] : null,
      medianMinutes: times.length ? quantile(times, 0.5) : null
    };
  }

  /*
   * A canonical key for a grade label, so the same grade matches across seasons:
   *   "A", "A Grade", "MA", "M A", "A Men", "Men A"   → "A"
   *   "WA", "W A", "Womens A", "A Women", "Women's A"  → "WA"
   *   "E", "ME" → "E";  "Open", "M Open", "M_OPEN"   → "OPEN";  "W Open" → "WOPEN"
   * Anything else (juniors, masters, age groups) is upper-cased with spaces and punctuation removed.
   */
  function gradeKey(label) {
    let s = String(label || '').toUpperCase().replace(/[’'`]/g, '').replace(/[_\-–.]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\bGRADE\b/g, '').replace(/\s+/g, ' ').trim();
    let m;
    if ((m = s.match(/^(?:W|WOMENS?|WOMAN|FEMALE|F)\s*([A-E])$/)) || (m = s.match(/^([A-E])\s*(?:WOMENS?|WOMAN|FEMALE)$/))) return 'W' + m[1];
    if ((m = s.match(/^(?:M|MENS?|MALE)?\s*([A-E])$/)) || (m = s.match(/^([A-E])\s*(?:MENS?|MALE)$/))) return m[1];
    if (/^(?:M|MENS?)?\s*OPEN$/.test(s)) return 'OPEN';
    if (/^(?:W|WOMENS?)\s*OPEN$/.test(s)) return 'WOPEN';
    return s.replace(/[^A-Z0-9+]/g, '');
  }

  /*
   * Suggested speed for one grade on one course from past races.
   *   records: [{ date, speed, range }] for that grade on that course (any order)
   *   recent:  how many of the latest races to use
   * Returns { races, speed, range, spreadWithin, spreadBetween, trend, first, last } or null.
   * The ± range covers both the spread inside a race and how much the grade varies race to race.
   */
  function historySuggestion(records, recent = 6) {
    const rs = records.filter(r => r.speed > 0).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, recent);
    if (!rs.length) return null;
    const speeds = rs.map(r => r.speed).sort((a, b) => a - b);
    const median = quantile(speeds, 0.5);
    const within = quantile(rs.map(r => r.range || 0).sort((a, b) => a - b), 0.5);
    const between = rs.length >= 3 ? (quantile(speeds, 0.9) - quantile(speeds, 0.1)) / 2 : 0;
    const range = Math.max(0.5, Math.round(Math.sqrt(within * within + between * between) * 2) / 2);
    // Trend: newest third against the rest (km/h), only with enough races
    let trend = null;
    if (rs.length >= 4) {
      const k = Math.max(1, Math.round(rs.length / 3));
      const avg = a => a.reduce((s, v) => s + v.speed, 0) / a.length;
      trend = Math.round((avg(rs.slice(0, k)) - avg(rs.slice(k))) * 10) / 10;
    }
    return {
      races: rs.length,
      speed: Math.round(median * 10) / 10,
      range,
      spreadWithin: within,
      spreadBetween: Math.round(between * 10) / 10,
      trend,
      first: rs[rs.length - 1].date,
      last: rs[0].date
    };
  }

  // ---------- Course maps (GPX) and hills ----------

  function parseGpx(text) {
    const pts = [];
    const re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
    let m;
    while ((m = re.exec(text))) {
      const lat = parseFloat((m[2].match(/lat\s*=\s*["']([-\d.eE+]+)["']/) || [])[1]);
      const lon = parseFloat((m[2].match(/lon\s*=\s*["']([-\d.eE+]+)["']/) || [])[1]);
      const ele = m[4] ? parseFloat((m[4].match(/<ele>\s*([-\d.eE+]+)\s*<\/ele>/) || [])[1]) : NaN;
      if (isFinite(lat) && isFinite(lon)) pts.push({ lat, lon, ele });
    }
    const name = (text.match(/<name>\s*([^<]+?)\s*<\/name>/) || [])[1] || '';
    if (pts.length < 2) throw new Error('No track points found in this GPX file.');
    return { name, points: pts };
  }

  /*
   * Turn GPS points into a course: metres east/north of the centre, resampled to at
   * most `maxPoints` evenly spaced points. Returns
   *   { name, points: [[x, y, ele], ...], lengthKm, closed, hasElevation }.
   */
  function buildCourse(gpx, maxPoints = 400) {
    const R = 6371000;
    const lat0 = gpx.points.reduce((s, p) => s + p.lat, 0) / gpx.points.length;
    const lon0 = gpx.points.reduce((s, p) => s + p.lon, 0) / gpx.points.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    let raw = gpx.points.map(p => ({
      x: (p.lon - lon0) * Math.PI / 180 * R * k,
      y: (p.lat - lat0) * Math.PI / 180 * R,
      e: p.ele
    }));
    // Drop repeated points
    raw = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y) > 0.5);
    const cum = [0];
    for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y));
    const total = cum[cum.length - 1];
    if (!(total > 10)) throw new Error('The GPX track is too short.');
    const hasElevation = raw.filter(p => isFinite(p.e)).length > raw.length * 0.8;
    const n = Math.min(maxPoints, Math.max(20, raw.length));
    const out = [];
    let j = 0;
    for (let s = 0; s < n; s++) {
      const d = total * s / (n - 1);
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const t = cum[j + 1] > cum[j] ? (d - cum[j]) / (cum[j + 1] - cum[j]) : 0;
      const a = raw[j], b = raw[j + 1];
      const e = hasElevation ? (isFinite(a.e) && isFinite(b.e) ? a.e + (b.e - a.e) * t : (isFinite(a.e) ? a.e : b.e)) : 0;
      out.push([Math.round((a.x + (b.x - a.x) * t) * 10) / 10, Math.round((a.y + (b.y - a.y) * t) * 10) / 10, Math.round(e * 10) / 10]);
    }
    const first = raw[0], last = raw[raw.length - 1];
    return {
      name: gpx.name,
      points: out,
      lengthKm: total / 1000,
      closed: Math.hypot(first.x - last.x, first.y - last.y) < Math.max(150, total * 0.03),
      hasElevation
    };
  }

  // Speed multiplier for a gradient (rise/run): slower uphill, faster downhill.
  function gradientFactor(g) {
    if (g >= 0) return 1 / (1 + 10 * g);
    return Math.min(1.4, 1 + 5 * -g);
  }

  /*
   * A "warp" between real distance x along the course and riding-effort distance u.
   * Every grade's u advances at its average speed, so catch times are exactly those
   * of a flat course; hills only change where riders are (x) at a given moment.
   *   unitKm  length of one lap (circuit) or of the out leg / whole course
   *   kind    'circuit' | 'point' | 'outback'
   * With no elevation, or strength 0, the warp is the identity.
   */
  function makeWarp(course, unitKm, kind, strength = 1) {
    const identity = { toU: x => x, toX: u => u, identity: true };
    if (!course || !course.hasElevation || !(strength > 0) || !(unitKm > 0)) return identity;
    const pts = course.points;
    const n = pts.length;
    // Smoothed elevation per sample, then gradient per segment along the GPX geometry.
    const segLen = course.lengthKm * 1000 / (n - 1);
    const win = Math.max(1, Math.round(100 / segLen));
    const ele = pts.map((p, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) { s += pts[k][2]; c++; }
      return s / c;
    });
    const grads = [];
    for (let i = 0; i < n - 1; i++) grads.push((ele[i + 1] - ele[i]) / segLen);
    // The return leg of an out-and-back meets the same segments in reverse, downhill where it was uphill.
    const profile = kind === 'outback' ? grads.concat(grads.slice().reverse().map(g => -g)) : grads;
    const factors = profile.map(g => gradientFactor(g * strength));
    const span = kind === 'outback' ? 2 * unitKm : unitKm;
    const m = factors.length;
    // time weight per segment ∝ length / factor; normalise to the span
    const w = factors.map(f => 1 / f);
    const sumW = w.reduce((a, b) => a + b, 0);
    const cumX = [0], cumU = [0];
    for (let i = 0; i < m; i++) {
      cumX.push(span * (i + 1) / m);
      cumU.push(cumU[i] + span * w[i] / sumW);
    }
    const interp = (v, from, to) => {
      if (v <= 0) return 0;
      if (v >= span) return span;
      let lo = 0, hi = from.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (from[mid] <= v) lo = mid; else hi = mid; }
      const t = (v - from[lo]) / (from[hi] - from[lo]);
      return to[lo] + (to[hi] - to[lo]) * t;
    };
    const wrap = fn => v => {
      if (kind !== 'circuit') return fn(Math.max(0, Math.min(span, v)));
      const laps = Math.floor(v / span + 1e-12);
      return laps * span + fn(v - laps * span);
    };
    return {
      toU: wrap(x => interp(x, cumX, cumU)),
      toX: wrap(u => interp(u, cumU, cumX)),
      identity: false
    };
  }

  // Signed area of a closed polyline (positive = clockwise when y points down the screen).
  function signedArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }

  // ---------- Share links ----------

  function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function streamBytes(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  // Encode race data for a URL: 'z' + deflated JSON, or 'j' + plain JSON when compression is unavailable.
  async function encodeShare(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    if (typeof CompressionStream === 'function') {
      try { return 'z' + toBase64Url(await streamBytes(bytes, new CompressionStream('deflate-raw'))); } catch (e) { /* fall through */ }
    }
    return 'j' + toBase64Url(bytes);
  }

  async function decodeShare(s) {
    const kind = s[0], body = fromBase64Url(s.slice(1));
    let bytes = body;
    if (kind === 'z') bytes = await streamBytes(body, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') throw new Error('Unrecognised share link.');
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ---------- Exports ----------

  const SimCore = {
    EPS, toClock, toClockSec, fromClock, formatDuration, formatElapsed, formatSplit,
    finishClockOf, calculateCircuitCatches, calculateLinearCatch, findCatchEvents,
    simulateRace, stateAt, distanceAt, timeAtDistance, analyseRisk, planStarts,
    violatesRule, mulberry32, parseCsv, parseDuration, readResults, speedStats,
    gradeKey, historySuggestion, parseGpx, buildCourse, makeWarp, gradientFactor, signedArea, encodeShare, decodeShare
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SimCore;
  root.SimCore = SimCore;
})(typeof window !== 'undefined' ? window : globalThis);
