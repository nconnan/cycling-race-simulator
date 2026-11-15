/* Cycling Race Simulator: After-catch rules, catch risk, start planner, race sheet, direction.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

// =====================================================================
// v11 additions: after-catch rules, catch risk, start planner, race sheet
// =====================================================================

function fmtSpd(v) {
  return Math.round(v * 10) / 10;
}

function catchKindTag(c) {
  let tag = '';
  if (raceType === 'circuit' && c.lapsUp > 0) {
    tag += `<span class="kind lap">Lapped${c.lapsUp > 1 ? ' ×' + c.lapsUp : ''}</span>`;
  }
  if (afterCatch === 'neutralise') tag += `<span class="kind">Neutralised</span>`;
  else if (afterCatch === 'merge') tag += `<span class="kind">Merged</span>`;
  return tag;
}

// ---------- After-catch rule ----------

function updateAfterCatchHint() {
  document.getElementById('after-catch-hint').textContent = AFTER_CATCH[afterCatch].hint;
}

function handleAfterCatchChange() {
  const v = document.getElementById('after-catch').value;
  afterCatch = AFTER_CATCH[v] ? v : 'continue';
  updateAfterCatchHint();
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

// ---------- Catch risk ----------

function scheduleRiskUpdate() {
  clearTimeout(riskTimer);
  riskTimer = setTimeout(updateRisk, 80);
}

function updateRisk() {
  const intro = document.getElementById('risk-intro');
  const out = document.getElementById('risk-result');
  if (!grades.length) { intro.innerHTML = ''; out.innerHTML = ''; return; }

  const res = SimCore.analyseRisk({ grades, raceType, lapLength, afterCatch, runs: 300 });
  intro.innerHTML = res.deterministic
    ? `<span><strong>No grade has a speed range set</strong>, so this shows the single predicted outcome. Give grades a <strong>± Range</strong> in the grade settings to see how likely each catch is and when it could happen.</span>`
    : `<span>Each grade's speed was varied at random within its ± range across <strong>${res.runs} simulated races</strong>, using the rule “${AFTER_CATCH[afterCatch].label.toLowerCase()}”. <strong>Chance</strong> is the share of races in which the pair met at least once; the <strong>window</strong> covers their first meeting.</span>`;

  if (res.pairs.length === 0) {
    out.innerHTML = `<div class="table-wrap"><table class="data"><tbody><tr class="empty-row"><td>No pair of grades meets in any simulated race.</td></tr></tbody></table></div>`;
    return;
  }

  const rows = res.pairs.map(p => {
    const a = grades[p.c1Index], b = grades[p.c2Index];
    const pct = Math.round(p.probability * 100);
    const level = p.probability >= 0.67 ? 'high' : p.probability >= 0.34 ? 'mid' : '';
    const window = p.latest - p.earliest < 0.5
      ? `<span class="mono">${toClock(p.earliest)}</span>`
      : `<span class="mono">${toClock(p.earliest)} – ${toClock(p.latest)}</span>`;
    let where;
    if (raceType === 'circuit') {
      const l1 = Math.floor(p.distMin / lapLength + 1e-9) + 1, l2 = Math.floor(p.distMax / lapLength + 1e-9) + 1;
      where = l1 === l2 ? `Lap ${l1}` : `Laps ${l1}–${l2}`;
    } else {
      const d1 = warp.toX(p.distMin), d2 = warp.toX(p.distMax);
      where = d2 - d1 < 0.05 ? `${d1.toFixed(1)} km` : `${d1.toFixed(1)}–${d2.toFixed(1)} km`;
    }
    return `<tr>
      <td>${gradeChip(a.name, a.color)}</td>
      <td>${gradeChip(b.name, b.color)}</td>
      <td><div class="risk-bar ${level}"><div class="bar"><span style="width:${pct}%"></span></div><span class="mono">${pct}%</span></div></td>
      <td>${window}</td>
      <td>${where} <span class="muted">(${escapeHtml(b.name)})</span></td>
    </tr>`;
  }).join('');

  out.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Catcher</th><th>Caught</th><th>Chance</th><th>First meeting window</th><th>Where (caught grade)</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- Start planner ----------

function updatePlannerForm() {
  const rule = document.getElementById('plan-rule').value;
  const method = document.getElementById('plan-method');
  const circuit = raceType === 'circuit';
  if (!circuit && method.value === 'laps') method.value = 'starts';
  method.querySelector('option[value="laps"]').disabled = !circuit;
  const laps = method.value === 'laps';
  document.getElementById('plan-n-wrap').style.display = rule === 'final' ? '' : 'none';
  document.getElementById('plan-n-unit').textContent = circuit ? 'laps' : 'km';
  document.getElementById('plan-gap-label').textContent = laps ? 'Gap between starts' : 'Minimum start gap';
  document.getElementById('plan-objective-field').style.display = laps ? 'none' : '';
  document.getElementById('plan-locks-field').style.display = laps ? 'none' : '';
  document.getElementById('plan-order-label').textContent = laps ? 'Start order' : 'Start order';
  const deadlineOn = document.getElementById('plan-deadline-on').checked;
  document.getElementById('plan-deadline').disabled = !deadlineOn;
  document.getElementById('plan-cut-row').style.display = deadlineOn && circuit ? '' : 'none';
}

function readPlannerOptions() {
  const rule = document.getElementById('plan-rule').value;
  let n = +document.getElementById('plan-n').value;
  if (!(n > 0)) { n = raceType === 'circuit' ? 2 : 1; document.getElementById('plan-n').value = n; }
  let gap = Math.round(+document.getElementById('plan-gap').value);
  if (!(gap >= 0)) { gap = 1; document.getElementById('plan-gap').value = gap; }
  const method = document.getElementById('plan-method').value === 'laps' && raceType === 'circuit' ? 'laps' : 'starts';
  const deadlineOn = document.getElementById('plan-deadline-on').checked;
  const deadline = fromClock(document.getElementById('plan-deadline').value);
  const locks = {};
  if (method === 'starts') plannerLocks.forEach(i => { if (grades[i]) locks[i] = grades[i].start; });
  return {
    method,
    order: document.getElementById('plan-order').value,
    minGap: gap,
    fixedGap: gap,
    rule: rule === 'final' ? { type: 'final', n } : { type: 'none' },
    objective: document.getElementById('plan-objective').value,
    useRanges: document.getElementById('plan-ranges').checked,
    finishBy: deadlineOn && isFinite(deadline) ? deadline : null,
    allowLapCuts: document.getElementById('plan-cut').checked,
    locks
  };
}

function invalidatePlan() {
  const applyBtn = document.getElementById('plan-apply');
  if (applyBtn) applyBtn.disabled = true;
  if (currentPlan) {
    document.getElementById('plan-result').innerHTML =
      `<div class="callout warn"><span>Race settings have changed since the last plan. Press <strong>Suggest start times</strong> to plan again.</span></div>`;
  }
  currentPlan = null;
}

function runPlanner() {
  if (!grades.length) return;
  const opts = readPlannerOptions();
  const plan = SimCore.planStarts({ grades, raceType, lapLength, raceStart: raceStartMinutes, ...opts });
  const planned = grades.map((g, i) => {
    const laps = raceType === 'circuit' ? plan.laps[i] : g.laps;
    return { ...g, start: plan.starts[i], laps, totalDistance: raceType === 'circuit' ? laps * lapLength : g.totalDistance };
  });
  const sim = SimCore.simulateRace({ grades: planned, raceType, lapLength, afterCatch });
  currentPlan = { plan, sim, opts, planned };
  renderPlan();
  document.getElementById('plan-apply').disabled = false;
}

function describeRule(opts) {
  if (opts.rule.type === 'none') return 'no catches at all';
  return `no catches in the final ${opts.rule.n} ${raceType === 'circuit' ? (opts.rule.n === 1 ? 'lap' : 'laps') : 'km'}`;
}

function raceSpread(sim) {
  const ends = sim.tracks.map(t => t.finishClock).filter(v => v !== null);
  if (!ends.length) return null;
  return { first: Math.min(...ends), last: Math.max(...ends), spread: Math.max(...ends) - Math.min(...ends) };
}

function renderPlan() {
  const { plan, sim, opts } = currentPlan;
  const out = document.getElementById('plan-result');
  let html = '';

  if (!plan.feasible) {
    const gradeNotes = plan.notes.filter(n => n.index !== null);
    const names = [...new Set(gradeNotes.map(n => grades[n.index].name))].map(escapeHtml).join(', ');
    if (gradeNotes.length) {
      html += `<div class="callout warn"><span><strong>The rule can't be fully met for grade ${names}.</strong> ${escapeHtml(gradeNotes[0].message)} Try a different start order, a looser rule or fewer laps.</span></div>`;
    }
    plan.notes.filter(n => n.index === null).forEach(n => {
      html += `<div class="callout warn"><span><strong>Deadline:</strong> ${escapeHtml(n.message)}</span></div>`;
    });
  }

  const now = raceSpread(simResult), next = raceSpread(sim);
  const stat = (k, v, sub = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="muted" style="font-size:12px;margin-top:2px">${sub}</div>` : ''}</div>`;
  const change = (a, b) => {
    const d = Math.round(b - a);
    if (d === 0) return 'no change';
    return `<span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '+' : '−'}${Math.abs(d)} min</span> vs current`;
  };
  html += `<div class="stat-row">
    ${stat('Rule', describeRule(opts).replace(/^./, c => c.toUpperCase()), opts.useRanges && grades.some(g => g.range > 0) ? 'allowing for speed ranges' : 'at nominal speeds')}
    ${stat('Predicted catches', sim.events.length, `currently ${simResult.events.length}`)}
    ${next ? stat('Last finish', `<span class="mono">${toClock(next.last)}</span>`, now ? change(now.last, next.last) : '') : stat('Last finish', '—')}
    ${next ? stat('Finish spread', formatDuration(next.spread), now ? `currently ${formatDuration(now.spread)}` : '') : ''}
    ${plan.finishBy ? stat('Finished by ' + toClock(opts.finishBy), plan.finishBy.met ? '<span class="delta-down">✓ Met</span>' : '<span class="delta-up">✗ Missed</span>', `last finish ${toClock(plan.finishBy.lastFinish)}${opts.useRanges && grades.some(g => g.range > 0) ? ' at slowest speeds' : ''}`) : ''}
  </div>`;

  let prev = null;
  const rowOrder = grades.map((g, i) => i).sort((a, b) => plan.starts[a] - plan.starts[b] || plan.order.indexOf(a) - plan.order.indexOf(b));
  const rows = rowOrder.map((i, k) => {
    const g = grades[i];
    const s = plan.starts[i];
    const tr = sim.tracks[i];
    const gap = prev === null ? '—' : `+${s - prev} min`;
    prev = s;
    const moved = s - g.start;
    const movedHTML = moved === 0 ? '<span class="muted">unchanged</span>'
      : `<span class="${moved > 0 ? 'delta-up' : 'delta-down'}">${moved > 0 ? '+' : '−'}${Math.abs(moved)} min</span>`;
    const finish = tr.finishClock !== null ? `<span class="mono">${toClock(tr.finishClock)}</span>` : `<span class="pill out">Neutralised ${toClock(tr.neutralisedAt)}</span>`;
    const newLaps = raceType === 'circuit' ? plan.laps[i] : null;
    const lapsHTML = newLaps === null ? '' : `<td class="mono">${newLaps === g.laps ? newLaps : `<span class="muted">${g.laps} →</span> <strong>${newLaps}</strong>`}</td>`;
    const locked = opts.locks && opts.locks[i] !== undefined;
    return `<tr>
      <td class="mono">${k + 1}</td>
      <td>${gradeChip(g.name, g.color)}${locked ? ' <span title="Start locked">🔒</span>' : ''}</td>
      <td><strong class="mono">${toClock(s)}</strong></td>
      <td class="mono">${gap}</td>
      <td>${movedHTML}</td>
      <td class="mono muted">${toClock(g.start)}</td>
      <td class="mono">${fmtSpd(g.spd)} km/h${g.range > 0 ? ` <span class="muted">±${g.range}</span>` : ''}</td>
      ${lapsHTML}
      <td>${finish}</td>
    </tr>`;
  }).join('');

  html += `<div class="table-wrap"><table class="data">
    <thead><tr><th>#</th><th>Grade</th><th>Suggested start</th><th>Gap</th><th>Change</th><th>Current start</th><th>Speed</th>${raceType === 'circuit' ? '<th>Laps</th>' : ''}<th>Projected finish</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;

  if (sim.events.length && opts.rule.type === 'final') {
    html += `<p class="muted" style="font-size:12.5px;margin:12px 2px 0">Catches still predicted with this plan happen before the protected final ${opts.rule.n} ${raceType === 'circuit' ? 'laps' : 'km'}. See the Catch log after applying it.</p>`;
  }
  out.innerHTML = html;
}

function applyPlan() {
  if (!currentPlan) return;
  const { plan } = currentPlan;
  const rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  rows.forEach((row, i) => {
    const input = document.getElementById(`g${row.dataset.index}_start`);
    if (input && plan.starts[i] !== null && plan.starts[i] !== undefined) input.value = toClock(plan.starts[i]);
    const lapsInput = document.getElementById(`g${row.dataset.index}_laps`);
    if (lapsInput && raceType === 'circuit' && plan.laps[i]) lapsInput.value = plan.laps[i];
  });
  const earliest = Math.min(...plan.starts);
  if (earliest < raceStartMinutes) document.getElementById('race-start-time').value = toClock(earliest);
  updateCourseSetup();
  document.getElementById('plan-result').innerHTML =
    `<div class="callout"><span><strong>Plan applied.</strong> The track, Catch log and Race sheet now use the planned starts${raceType === 'circuit' ? ' and laps' : ''}.</span></div>`;
  showToast(`<span class="t-ico">✓</span><span>Planned start times applied to <strong>${escapeHtml(raceName)}</strong></span>`);
}

// ---------- Race-day sheet ----------

function sheetSwatch(color) {
  return `<span class="sw" style="background:${safeColor(color)}"></span>`;
}

function buildRaceSheet() {
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const typeLabel = RACE_TYPE_LABELS[raceType];
  const courseText = (raceType === 'circuit' ? `${lapLength} km lap`
    : raceType === 'outback' ? `${lapLength} km out and back (${lapLength * 2} km)` : `${lapLength} km`)
    + (directionByType[raceType] && !(course && raceType !== 'circuit') ? `, ${directionByType[raceType]}` : '')
    + (course ? ` · map: ${escapeHtml(course.name || 'GPX')}${course.hasElevation && hillEffect ? ' (hills on)' : ''}` : '');
  const ends = simResult.tracks.map(t => t.finishClock).filter(v => v !== null);
  const anyRange = grades.some(g => g.range > 0);

  // Start list
  const startRows = [...grades].sort((a, b) => a.start - b.start || a.idx - b.idx).map(g => {
    const tr = simResult.tracks[g.idx];
    const dist = raceType === 'circuit' ? `${g.laps} × ${lapLength} km = ${fmtSpd(g.totalDistance)} km` : `${fmtSpd(g.totalDistance)} km`;
    let extra = '';
    if (raceType === 'circuit') {
      const bell = g.laps > 1 ? SimCore.timeAtDistance(tr, (g.laps - 1) * lapLength) : g.start;
      extra = `<td class="mono">${formatSplit(lapLength * 60 / g.spd)}</td><td class="mono">${bell !== null ? toClockSec(bell) : '—'}</td>`;
    } else if (raceType === 'outback') {
      const turn = SimCore.timeAtDistance(tr, warp.toU(lapLength));
      extra = `<td class="mono">${turn !== null ? toClockSec(turn) : '—'}</td>`;
    }
    const fin = tr.finishClock !== null ? toClockSec(tr.finishClock) : `Neutralised ${toClockSec(tr.neutralisedAt)}`;
    return `<tr><td>${sheetSwatch(g.color)}<b>${escapeHtml(g.name)}</b></td><td class="mono"><b>${toClockSec(g.start)}</b></td><td>${dist}</td>
      <td class="mono">${fmtSpd(g.spd)}${g.range > 0 ? ` ±${g.range}` : ''} km/h</td>${extra}<td class="mono">${fin}</td></tr>`;
  }).join('');
  const extraHead = raceType === 'circuit' ? '<th>Lap time</th><th>Bell (final lap)</th>' : raceType === 'outback' ? '<th>At turn</th>' : '';

  // Predicted catches
  const catchRows = catchEvents.map(c => {
    const where = raceType === 'circuit'
      ? `${escapeHtml(c.c1)} lap ${c.c1Lap} · ${escapeHtml(c.c2)} lap ${c.c2Lap} · ${c.c2LapDist.toFixed(2)} km into lap`
      : `${c.c2Distance.toFixed(2)} km from start`;
    let kind = raceType === 'circuit' && c.lapsUp > 0 ? `Lapped${c.lapsUp > 1 ? ' ×' + c.lapsUp : ''}` : 'Caught';
    if (afterCatch === 'neutralise') kind += ' → neutralised';
    if (afterCatch === 'merge') kind += ' → joins bunch';
    return `<tr><td class="mono"><b>${toClockSec(c.catchTime)}</b></td><td>${sheetSwatch(c.c1Color)}${escapeHtml(c.c1)}</td><td>${sheetSwatch(c.c2Color)}${escapeHtml(c.c2)}</td><td>${kind}</td><td>${where}</td></tr>`;
  }).join('');

  // Risk
  let riskHTML = '';
  if (anyRange) {
    const res = SimCore.analyseRisk({ grades, raceType, lapLength, afterCatch, runs: 300 });
    const rows = res.pairs.map(p => {
      const a = grades[p.c1Index], b = grades[p.c2Index];
      const win = p.latest - p.earliest < 0.5 ? toClock(p.earliest) : `${toClock(p.earliest)} – ${toClock(p.latest)}`;
      return `<tr><td>${sheetSwatch(a.color)}${escapeHtml(a.name)}</td><td>${sheetSwatch(b.color)}${escapeHtml(b.name)}</td><td class="mono">${Math.round(p.probability * 100)}%</td><td class="mono">${win}</td></tr>`;
    }).join('');
    riskHTML = `<h2>Catch risk (speeds varied within ± ranges)</h2>
      ${rows ? `<table><thead><tr><th>Catcher</th><th>Caught</th><th>Chance</th><th>Window</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No catches in any simulated race.</p>'}`;
  }

  // Lap-by-lap clock times (circuit)
  let lapsHTML = '';
  if (raceType === 'circuit') {
    const maxLaps = Math.max(...grades.map(g => g.laps));
    const chunk = 10;
    let tables = '';
    for (let from = 1; from <= maxLaps; from += chunk) {
      const to = Math.min(maxLaps, from + chunk - 1);
      let head = '<th>Grade</th>';
      for (let k = from; k <= to; k++) head += `<th>Lap ${k}</th>`;
      const body = grades.map(g => {
        const tr = simResult.tracks[g.idx];
        let cells = '';
        for (let k = from; k <= to; k++) {
          if (k > g.laps) { cells += '<td></td>'; continue; }
          const t = SimCore.timeAtDistance(tr, k * lapLength);
          cells += `<td class="mono">${t !== null ? toClockSec(t) : '—'}</td>`;
        }
        return `<tr><td>${sheetSwatch(g.color)}<b>${escapeHtml(g.name)}</b></td>${cells}</tr>`;
      }).join('');
      tables += `<table class="laps-table" style="margin-bottom:8pt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    lapsHTML = `<div class="page-break"></div><h2>Lap-by-lap clock times (each lap completed)</h2>${tables}`;
  }

  return `<div class="sheet">
    <h1>${escapeHtml(raceName)}</h1>
    <div class="meta">
      <span><b>Date:</b> ${escapeHtml(today)}</span>
      <span><b>Course:</b> ${typeLabel}, ${courseText}</span>
      <span><b>First start:</b> ${toClock(Math.min(...grades.map(g => g.start)))}</span>
      <span><b>Expected last finish:</b> ${ends.length ? toClock(Math.max(...ends)) : '—'}</span>
      <span><b>When caught:</b> ${AFTER_CATCH[afterCatch].label}</span>
    </div>
    <h2>Start list</h2>
    <table><thead><tr><th>Grade</th><th>Start</th><th>Distance</th><th>Speed</th>${extraHead}<th>Expected finish</th></tr></thead><tbody>${startRows}</tbody></table>
    <h2>Predicted catches (${catchEvents.length})</h2>
    ${catchEvents.length ? `<table><thead><tr><th>Time</th><th>Catcher</th><th>Caught</th><th>Type</th><th>Where</th></tr></thead><tbody>${catchRows}</tbody></table>` : '<p>No catches predicted at the planned speeds.</p>'}
    ${riskHTML}
    ${lapsHTML}
    <div class="foot">Prepared with Cycling Race Simulator v11 on ${escapeHtml(today)}. Predictions assume steady speeds and are for planning only; they do not account for terrain, weather, crashes or race tactics.</div>
  </div>`;
}

function printRaceSheet() {
  if (!grades.length) return;
  document.getElementById('print-sheet').innerHTML = buildRaceSheet();
  window.print();
}

// Keep the sheet current if the browser's own Print command is used.
window.addEventListener('beforeprint', () => {
  if (grades.length) document.getElementById('print-sheet').innerHTML = buildRaceSheet();
});

// ---------- Direction of travel ----------

function updateDirectionUI() {
  const field = document.getElementById('direction-field');
  if (!field) return;
  const dir = directionByType[raceType];
  field.style.display = dir && !(course && raceType !== 'circuit') ? '' : 'none';
  document.querySelectorAll('.dir-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.dir === dir));
}

function setDirection(dir) {
  if (!directionByType[raceType] || (dir !== 'clockwise' && dir !== 'anticlockwise')) return;
  if (directionByType[raceType] === dir) return;
  directionByType[raceType] = dir;
  mapGeometryCache = null;
  updateHeaderMeta();
  scheduleAutosave();
  // Snapshots show the old direction, so redraw them.
  snapshotCache.clear();
  snapshotQueue.length = 0;
  catchEvents.forEach(ev => { ev.snapshot = null; });
  lastCatchTableSig = null;
  updateRaceToTime(raceElapsed);
  refreshRaceViews();
}
