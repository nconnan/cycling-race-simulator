/* Cycling Race Simulator: Post-race review and course speed history.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

// ---------- Post-race review ----------

function useImportLap() {
  if (!importState || !importState.res.lapKm) return;
  document.getElementById('lap-length').value = importState.res.lapKm;
  handleLapLengthChange();
  renderImportDialog();
}

function compareWithPlan() {
  if (!importState) return;
  const { res, map, fileName } = importState;
  reviewState = {
    fileName,
    lapKm: res.lapKm,
    importedAt: Date.now(),
    groups: res.groups.map((gr, k) => {
      const st = importStats(k);
      const g = map[k] >= 0 ? grades[map[k]] : null;
      return {
        label: gr.label,
        gradeName: g ? g.name : null,
        gradeIdx: g ? g.idx : -1,
        fullLaps: gr.fullLaps,
        shortCount: gr.shortCount,
        n: st.n || 0,
        median: st.n ? st.median : null,
        speed: st.n ? st.speed : null,
        range: st.n ? st.range : null,
        winnerMinutes: st.n ? st.winnerMinutes : null,
        medianMinutes: st.n ? st.medianMinutes : null
      };
    })
  };
  closeDialog();
  showTab('review');
  renderReview();
  scheduleAutosave();
}

function validReview(r) {
  return r && typeof r === 'object' && Array.isArray(r.groups) && r.groups.every(g => g && typeof g.label === 'string');
}

// Which current grade a reviewed group belongs to (by index, falling back to name).
function reviewGrade(gr) {
  if (gr.gradeIdx >= 0 && grades[gr.gradeIdx] && grades[gr.gradeIdx].name === gr.gradeName) return grades[gr.gradeIdx];
  return gr.gradeName ? grades.find(g => g.name === gr.gradeName) || null : null;
}

function clearReview() {
  reviewState = null;
  renderReview();
  scheduleAutosave();
}

function applyReviewSpeeds() {
  if (!reviewState) return;
  const rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  let n = 0;
  for (const gr of reviewState.groups) {
    const g = reviewGrade(gr);
    if (!g || !(gr.speed > 0)) continue;
    const row = rows[g.idx];
    if (!row) continue;
    document.getElementById(`g${row.dataset.index}_spd`).value = gr.speed;
    document.getElementById(`g${row.dataset.index}_range`).value = gr.range;
    n++;
  }
  updateCourseSetup();
  showToast(`<span class="t-ico">✓</span><span>Speeds and ranges updated for <strong>${n}</strong> grade${n === 1 ? '' : 's'} from the results</span>`);
}

function catchList(events, gs) {
  if (!events.length) return '<div class="muted">No catches.</div>';
  return events.map(ev => {
    const a = gs[ev.c1Index], b = gs[ev.c2Index];
    const x = warp.toX(ev.slowerDistance);
    const where = raceType === 'circuit' ? `lap ${Math.floor(x / lapLength + 1e-9) + 1}` : `${x.toFixed(1)} km`;
    return `<div class="rv-catch">${gradeDot(a.name, a.color, 'sm')} <strong>${escapeHtml(a.name)}</strong> ${raceType === 'circuit' && ev.lapsUp > 0 ? 'laps' : 'catches'} ${gradeDot(b.name, b.color, 'sm')} <strong>${escapeHtml(b.name)}</strong> <span class="mono">${toClock(ev.catchTime)}</span> <span class="muted">· ${where}</span></div>`;
  }).join('');
}

function renderReview() {
  const box = document.getElementById('review-content');
  if (!box) return;
  document.getElementById('review-ready').classList.toggle('show', !!reviewState);
  if (!reviewState) {
    box.innerHTML = `<div class="summary-placeholder">
      <strong>No results to review yet</strong>
      <span>After a race, download the results CSV (Sporthive / Speedhive, or any results file), choose <strong>Import results (CSV)</strong> under the grades, then <strong>Compare with plan</strong>.</span>
    </div>`;
    return;
  }

  const rowsData = reviewState.groups.map(gr => ({ gr, g: reviewGrade(gr) }));
  const compared = rowsData.filter(r => r.g && r.gr.median);
  const unmatched = rowsData.filter(r => !r.g || !r.gr.median).map(r => r.gr.label);

  // What the model predicts with the speeds (and laps) that were actually ridden
  const actualGrades = grades.map(g => {
    const r = compared.find(x => x.g.idx === g.idx);
    if (!r) return g;
    const laps = raceType === 'circuit' && r.gr.fullLaps ? r.gr.fullLaps : g.laps;
    return { ...g, spd: r.gr.median, laps, totalDistance: raceType === 'circuit' ? laps * lapLength : g.totalDistance };
  });
  const actualSim = SimCore.simulateRace({ grades: actualGrades, raceType, lapLength, afterCatch });

  let sumSpeed = 0, sumFinish = 0, nFinish = 0, inRange = 0;
  const rows = compared.map(({ gr, g }) => {
    const k = reviewState.groups.indexOf(gr);
    const diff = gr.median - g.spd;
    sumSpeed += Math.abs(diff);
    const within = g.range > 0 ? Math.abs(diff) <= g.range + 1e-9 : Math.abs(diff) < 0.05;
    if (within) inRange++;
    const tr = simResult.tracks[g.idx];
    const planned = tr.finishClock;
    const startAt = isFinite(gr.actualStart) ? gr.actualStart : g.start;
    const actual = gr.medianMinutes !== null ? startAt + gr.medianMinutes : null;
    let finishDiff = '';
    if (planned !== null && actual !== null) {
      const d = actual - planned;
      sumFinish += Math.abs(d); nFinish++;
      finishDiff = `<span class="${Math.abs(d) < 1 ? 'muted' : d > 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '+' : '−'}${formatSplit(Math.abs(d))}</span>`;
    }
    const lapsCell = raceType === 'circuit'
      ? (gr.fullLaps && gr.fullLaps !== g.laps ? `<span class="delta-up">${gr.fullLaps}</span> <span class="muted">(plan ${g.laps})</span>` : `<span class="mono">${g.laps}</span>`)
      : '';
    return `<tr>
      <td>${gradeChip(g.name, g.color)}<div class="muted" style="font-size:11.5px">${escapeHtml(gr.label)} · ${gr.n} rider${gr.n === 1 ? '' : 's'}${gr.shortCount ? `, ${gr.shortCount} lapped/pulled` : ''}</div></td>
      ${raceType === 'circuit' ? `<td>${lapsCell}</td>` : ''}
      <td class="mono">${fmtSpd(g.spd)}${g.range > 0 ? ` <span class="muted">±${g.range}</span>` : ''}</td>
      <td class="mono"><strong>${fmtSpd(gr.median)}</strong> <span class="muted">±${gr.range}</span></td>
      <td><span class="mono ${Math.abs(diff) < 0.05 ? 'muted' : diff > 0 ? 'delta-down' : 'delta-up'}">${diff >= 0 ? '+' : '−'}${fmtSpd(Math.abs(diff))}</span> ${within ? '<span class="pill done">in range</span>' : '<span class="pill out">outside</span>'}</td>
      <td><input type="time" class="rv-start${isFinite(gr.actualStart) && gr.actualStart !== g.start ? ' changed' : ''}" value="${toClock(startAt)}" step="60" onchange="setReviewStart(${k}, this.value)" aria-label="Actual start time for ${escapeHtml(g.name)}"></td>
      <td class="mono">${planned !== null ? toClock(planned) : '—'}</td>
      <td class="mono">${actual !== null ? toClock(actual) : '—'}</td>
      <td class="mono">${finishDiff}</td>
    </tr>`;
  }).join('');

  const nC = compared.length;
  const stat = (k, v, sub = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="muted" style="font-size:12px;margin-top:2px">${sub}</div>` : ''}</div>`;
  const when = new Date(reviewState.importedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  box.innerHTML = `
    <div class="panel-intro">
      <p><strong>${escapeHtml(reviewState.fileName)}</strong>, imported ${escapeHtml(when)}${reviewState.lapKm ? ` · lap ${reviewState.lapKm} km from the file` : ''}. Actual finish is the median rider's time added to the grade's actual start; set the start times below if any grade went off late.</p>
      <button class="btn" onclick="clearReview()">Clear</button>
      <button class="btn" onclick="openAddToHistory()" title="Keep these speeds in the course history for future plans">${reviewState.addedToHistory ? '✓ In history' : 'Add to course history…'}</button>
      <button class="btn primary" onclick="applyReviewSpeeds()">Update speeds from results</button>
    </div>
    <div class="stat-row">
      ${stat('Grades compared', nC, unmatched.length ? `not matched: ${unmatched.map(escapeHtml).join(', ')}` : '')}
      ${stat('Speed error', nC ? `${fmtSpd(sumSpeed / nC)} km/h` : '—', 'average, planned vs actual')}
      ${stat('Within ± range', nC ? `${inRange}/${nC}` : '—', 'grades whose actual speed fell in the planned range')}
      ${stat('Finish error', nFinish ? formatSplit(sumFinish / nFinish) : '—', 'average, min:sec')}
    </div>
    ${nC ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Grade</th>${raceType === 'circuit' ? '<th>Laps ridden</th>' : ''}<th>Planned km/h</th><th>Actual km/h</th><th>Difference</th><th title="When the grade actually started. Change it if it differed from the plan.">Actual start</th><th>Predicted finish</th><th>Actual finish</th><th>Off by</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<div class="callout warn"><span>No grades in the file are matched to grades in this race. Import again and choose a grade for each group.</span></div>'}
    <div class="rv-catches">
      <div><div class="scenario-result-head">Catches predicted by your plan (${simResult.events.length})</div>${catchList(simResult.events, grades)}</div>
      <div><div class="scenario-result-head">Catches predicted with the actual speeds (${actualSim.events.length})</div>${catchList(actualSim.events, actualGrades)}</div>
    </div>
    <p class="field-hint" style="margin:12px 0 0">The results file has finishing times only, so actual catches during the race can't be confirmed from it. The right-hand list is what the model predicts once it knows the real speeds.</p>
  `;
}

function setReviewStart(k, value) {
  if (!reviewState || !reviewState.groups[k]) return;
  const t = fromClock(value);
  if (isFinite(t)) reviewState.groups[k].actualStart = t; else delete reviewState.groups[k].actualStart;
  renderReview();
  scheduleAutosave();
}

// ---------- Course speed history ----------

const USER_HISTORY_KEY = 'crs-history-v1';

function userHistory() {
  const h = storageGet(USER_HISTORY_KEY, []);
  return Array.isArray(h) ? h.filter(r => r && r.c && Array.isArray(r.g)) : [];
}

function allHistory() {
  const builtin = (window.BUILTIN_HISTORY && Array.isArray(window.BUILTIN_HISTORY.races)) ? window.BUILTIN_HISTORY.races : [];
  return userHistory().map(r => ({ ...r, mine: true })).concat(builtin);
}

function historyCourses() {
  const counts = new Map();
  for (const r of allHistory()) counts.set(r.c, (counts.get(r.c) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Records for one grade key on one course: [{ date, speed, range, laps, riders, lapped }]
function historyFor(courseName, key) {
  const out = [];
  for (const r of allHistory()) {
    if (r.c !== courseName) continue;
    for (const g of r.g) {
      if (SimCore.gradeKey(g[0]) !== key) continue;
      out.push({ date: r.d, speed: g[3], range: g[4], laps: g[1], riders: g[2], lapped: g[5] || 0, lapKm: r.l, event: r.e, mine: !!r.mine });
    }
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function renderHistoryCourseSelect() {
  const sel = document.getElementById('history-course');
  if (!sel) return;
  const courses = historyCourses();
  sel.innerHTML = `<option value="">— none —</option>` + courses.map(([c, n]) =>
    `<option value="${escapeHtml(c)}" ${c === historyCourse ? 'selected' : ''}>${escapeHtml(c)} (${n} race${n === 1 ? '' : 's'})</option>`).join('');
  if (historyCourse && !courses.some(([c]) => c === historyCourse)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(historyCourse)}" selected>${escapeHtml(historyCourse)} (no races yet)</option>`);
  }
}

function setHistoryCourse(value) {
  historyCourse = value || '';
  renderHistory();
  scheduleAutosave();
}

function setHistoryRecent(value) {
  historyRecent = +value || 6;
  renderHistory();
}

function typicalLaps(recs) {
  const laps = recs.map(r => r.laps).filter(l => l > 0).sort((a, b) => a - b);
  return laps.length ? laps[Math.floor(laps.length / 2)] : null;
}

function renderHistory() {
  const box = document.getElementById('history-content');
  if (!box) return;
  const courses = historyCourses();
  const builtin = window.BUILTIN_HISTORY;
  const mine = userHistory();
  const courseOptions = `<option value="">Choose a course…</option>` + courses.map(([c, n]) =>
    `<option value="${escapeHtml(c)}" ${c === historyCourse ? 'selected' : ''}>${escapeHtml(c)} (${n})</option>`).join('');
  const head = `
    <div class="panel-intro">
      <p>Grade speeds from past races, by course${builtin ? `: built in from <strong>${escapeHtml(builtin.club)}</strong> results on Sporthive (${builtin.races.length} races)` : ''}${mine.length ? `, plus <strong>${mine.length}</strong> of your reviewed race${mine.length === 1 ? '' : 's'}` : ''}. Suggested speed is the median of the most recent races; the ± range covers both the spread within a race and how much a grade varies race to race.</p>
    </div>
    <div class="history-bar">
      <label class="field"><span class="field-label">Course</span><select onchange="setHistoryCourse(this.value); renderHistoryCourseSelect()">${courseOptions}</select></label>
      <label class="field"><span class="field-label">Use the latest</span><select onchange="setHistoryRecent(this.value)">${[3, 6, 10, 20].map(n => `<option value="${n}" ${n === historyRecent ? 'selected' : ''}>${n} races</option>`).join('')}</select></label>
      <span style="flex:1"></span>
      <button class="btn primary" onclick="openHistorySuggest()" ${historyCourse ? '' : 'disabled'}>Use for this race…</button>
    </div>`;
  if (!historyCourse) {
    box.innerHTML = head + `<div class="summary-placeholder"><strong>Choose a course</strong><span>Pick the course for this race to see each grade's typical speed there. You can also set it in Race setup.</span></div>`;
    return;
  }
  const keys = new Map();
  for (const r of allHistory()) if (r.c === historyCourse) for (const g of r.g) {
    const k = SimCore.gradeKey(g[0]);
    if (!keys.has(k)) keys.set(k, g[0]);
  }
  const order = ['A', 'B', 'C', 'D', 'E', 'OPEN', 'WA', 'WB', 'WC', 'WD', 'WE', 'WOPEN'];
  const sortedKeys = [...keys.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const rows = sortedKeys.map(k => {
    const recs = historyFor(historyCourse, k);
    const sug = SimCore.historySuggestion(recs, historyRecent);
    if (!sug) return '';
    const lapped = recs.slice(0, historyRecent);
    const lappedPct = Math.round(100 * lapped.reduce((s, r) => s + r.lapped, 0) / Math.max(1, lapped.reduce((s, r) => s + r.riders + r.lapped, 0)));
    const trend = sug.trend === null ? '<span class="muted">—</span>'
      : Math.abs(sug.trend) < 0.5 ? '<span class="muted">steady</span>'
      : `<span class="${sug.trend > 0 ? 'delta-down' : 'delta-up'}">${sug.trend > 0 ? '▲ +' : '▼ −'}${Math.abs(sug.trend)}</span>`;
    const spark = recs.slice(0, historyRecent).reverse().map(r => r.speed);
    const lo = Math.min(...spark), hi = Math.max(...spark);
    const bars = spark.map(v => `<span style="height:${4 + (hi > lo ? (v - lo) / (hi - lo) * 14 : 7)}px"></span>`).join('');
    const mineMark = recs.some(r => r.mine) ? ' <span class="kind">yours</span>' : '';
    return `<tr>
      <td><strong>${escapeHtml(k)}</strong>${keys.get(k) !== k ? ` <span class="muted">(${escapeHtml(keys.get(k))})</span>` : ''}${mineMark}</td>
      <td class="mono">${sug.races}<span class="muted">/${recs.length}</span></td>
      <td class="mono"><strong>${sug.speed}</strong> <span class="muted">±${sug.range}</span></td>
      <td><span class="spark" title="${spark.join(', ')} km/h">${bars}</span></td>
      <td>${trend}</td>
      <td class="mono">${typicalLaps(recs.slice(0, historyRecent)) ?? '—'}</td>
      <td class="mono">${lappedPct}%</td>
      <td class="mono muted">${escapeHtml(sug.last)}</td>
    </tr>`;
  }).join('');
  const lapKms = [...new Set(allHistory().filter(r => r.c === historyCourse).map(r => r.l))];
  const myRaces = mine.filter(r => r.c === historyCourse);
  box.innerHTML = head + `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Grade</th><th title="Races used / races on record">Races</th><th>Suggested km/h</th><th>Recent</th><th title="Newest third of races against the rest">Trend</th><th>Typical laps</th><th title="Share of starters lapped or pulled">Lapped</th><th>Latest</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="field-hint" style="margin:10px 0 0">Lap ${lapKms.join(' / ')} km. Speeds are each grade's median finisher over the full distance; lapped or pulled riders are left out.</p>
    ${myRaces.length ? `<div class="scenario-result-head" style="margin-top:14px">Your races on this course</div>
      ${myRaces.map(r => `<div class="rv-catch"><span class="mono">${escapeHtml(r.d)}</span> ${escapeHtml(r.e)} <span class="muted">· ${r.g.length} grades</span> <button class="link-btn" onclick="deleteUserHistory('${r.id}')">Remove</button></div>`).join('')}` : ''}`;
}

function deleteUserHistory(id) {
  if (!confirm('Remove this race from your course history?')) return;
  storageSet(USER_HISTORY_KEY, userHistory().filter(r => r.id !== id));
  renderHistoryCourseSelect();
  renderHistory();
}

// Suggest speeds for the current grades from the course history
let historySuggestState = null;

function openHistorySuggest() {
  const courses = historyCourses();
  if (!courses.length) { alert('There is no course history yet.'); return; }
  if (!historyCourse) {
    // Best guess: a course whose name appears in the race name
    const guess = courses.find(([c]) => raceName.toLowerCase().includes(c.toLowerCase().split(' ')[0]));
    historyCourse = guess ? guess[0] : courses[0][0];
  }
  historySuggestState = { course: historyCourse, recent: historyRecent };
  renderHistorySuggest();
}

function renderHistorySuggest() {
  const st = historySuggestState;
  const courses = historyCourses();
  const rows = grades.map(g => {
    const key = SimCore.gradeKey(g.name);
    const recs = historyFor(st.course, key);
    const sug = SimCore.historySuggestion(recs, st.recent);
    const laps = typicalLaps(recs.slice(0, st.recent));
    return `<tr>
      <td>${gradeChip(g.name, g.color)}${key !== g.name.toUpperCase() ? ` <span class="muted">as ${escapeHtml(key)}</span>` : ''}</td>
      <td class="mono">${sug ? sug.races : 0}</td>
      <td>${sug ? `<strong class="mono">${sug.speed}</strong> <span class="muted">±${sug.range}</span>` : '<span class="muted">no history</span>'}</td>
      <td class="mono">${sug && laps ? laps : '—'}</td>
      <td class="mono muted">${fmtSpd(g.spd)} ±${g.range}${raceType === 'circuit' ? ` · ${g.laps} laps` : ''}</td>
    </tr>`;
  }).join('');
  openDialog('Speeds from course history', `
    <div class="history-bar" style="margin-bottom:12px">
      <label class="field" style="flex:1"><span class="field-label">Course</span><select onchange="historySuggestState.course = this.value; renderHistorySuggest()">${courses.map(([c, n]) => `<option value="${escapeHtml(c)}" ${c === st.course ? 'selected' : ''}>${escapeHtml(c)} (${n})</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">Use the latest</span><select onchange="historySuggestState.recent = +this.value; renderHistorySuggest()">${[3, 6, 10, 20].map(n => `<option value="${n}" ${n === st.recent ? 'selected' : ''}>${n} races</option>`).join('')}</select></label>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Grade</th><th>Races</th><th>Suggested km/h</th><th>Typical laps</th><th>Current</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="field-hint" style="margin:10px 0 0">Grades are matched by name (A = MA = “A Grade”; WA = “Womens A”). The ± range covers race-to-race variation as well as the spread within a race.</p>
    <label class="check"><input type="checkbox" id="hist-ranges" checked> Set ± ranges</label>
    ${raceType === 'circuit' ? '<label class="check"><input type="checkbox" id="hist-laps"> Also set laps to the typical number on this course</label>' : ''}
  `, `
    <button class="btn" onclick="closeDialog()">Cancel</button>
    <span style="flex:1"></span>
    <button class="btn primary" onclick="applyHistorySuggest()">Apply</button>
  `);
}

function applyHistorySuggest() {
  const st = historySuggestState;
  const setRanges = document.getElementById('hist-ranges').checked;
  const setLaps = raceType === 'circuit' && document.getElementById('hist-laps')?.checked;
  const rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  let n = 0;
  grades.forEach((g, i) => {
    const recs = historyFor(st.course, SimCore.gradeKey(g.name));
    const sug = SimCore.historySuggestion(recs, st.recent);
    if (!sug || !rows[i]) return;
    const idx = rows[i].dataset.index;
    document.getElementById(`g${idx}_spd`).value = sug.speed;
    if (setRanges) document.getElementById(`g${idx}_range`).value = sug.range;
    const laps = typicalLaps(recs.slice(0, st.recent));
    if (setLaps && laps) document.getElementById(`g${idx}_laps`).value = laps;
    n++;
  });
  historyCourse = st.course;
  historyRecent = st.recent;
  closeDialog();
  updateCourseSetup();
  showToast(`<span class="t-ico">✓</span><span>Speeds for <strong>${n}</strong> grade${n === 1 ? '' : 's'} from ${escapeHtml(st.course)}</span>`);
}

// Add a reviewed race to your own course history
function openAddToHistory() {
  if (!reviewState) return;
  const courses = historyCourses();
  const course = historyCourse || raceName;
  openDialog('Add to course history', `
    <p style="margin:0 0 12px;color:var(--text-2)">Keeps this race's grade speeds (no riders' names) for future plans on the same course. It is stored in this browser.</p>
    <div class="field-grid">
      <label class="field full"><span class="field-label">Course</span>
        <input type="text" id="hist-course-name" list="hist-course-list" value="${escapeHtml(course)}">
        <datalist id="hist-course-list">${courses.map(([c]) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
      </label>
      <label class="field"><span class="field-label">Race date</span><input type="date" id="hist-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field"><span class="field-label">Lap length</span><span class="input-unit"><input type="number" id="hist-lap" value="${reviewState.lapKm || lapLength}" step="0.01" min="0.1"><span class="unit">km</span></span></label>
    </div>
  `, `
    <button class="btn" onclick="closeDialog()">Cancel</button>
    <span style="flex:1"></span>
    <button class="btn primary" onclick="addReviewToHistory()">Add</button>
  `);
}

function addReviewToHistory() {
  const c = document.getElementById('hist-course-name').value.trim();
  const d = document.getElementById('hist-date').value || new Date().toISOString().slice(0, 10);
  const l = +document.getElementById('hist-lap').value || lapLength;
  if (!c) { alert('Enter a course name.'); return; }
  const entry = {
    id: `h${Date.now().toString(36)}`,
    d, c, e: raceName, l,
    g: reviewState.groups.filter(g => g.speed > 0).map(g => [g.label, g.fullLaps || null, g.n, g.speed, g.range, g.shortCount || 0])
  };
  storageSet(USER_HISTORY_KEY, userHistory().concat(entry));
  reviewState.addedToHistory = true;
  historyCourse = c;
  closeDialog();
  renderHistoryCourseSelect();
  renderHistory();
  renderReview();
  scheduleAutosave();
  showToast(`<span class="t-ico">✓</span><span>Added to the <strong>${escapeHtml(c)}</strong> history</span>`);
}
