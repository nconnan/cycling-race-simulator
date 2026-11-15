/* Cycling Race Simulator: Race data, dialogs, race library, share links and results import.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

// =====================================================================
// v11.3: race library, share links, planner rules, results import, course maps
// =====================================================================

// ---------- Race data (shared by file save, library, autosave and share links) ----------

function buildRaceData(opts = {}) {
  let rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  let gradeData = [];
  rows.forEach(row => {
    let idx = row.dataset.index;
    if (!document.getElementById(`g${idx}_name`)) return;
    let laps = raceType === 'circuit'
      ? (+document.getElementById(`g${idx}_laps`)?.value || 1) : (+row.dataset.laps || 1);
    let totalDist = raceType === 'outback' ? lapLength * 2 : lapLength * (raceType === 'circuit' ? laps : 1);
    const spd = +document.getElementById(`g${idx}_spd`).value;
    gradeData.push({
      name: document.getElementById(`g${idx}_name`).value || String.fromCharCode(65 + gradeData.length),
      color: document.getElementById(`g${idx}_color`).value,
      start: fromClock(document.getElementById(`g${idx}_start`).value),
      laps,
      spd,
      baseSpd: spd,
      totalDistance: totalDist,
      range: +document.getElementById(`g${idx}_range`)?.value || 0,
      prevtime: document.getElementById(`g${idx}_prevtime`)?.value || ''
    });
  });

  const data = {
    raceName,
    raceType,
    raceStartMinutes,
    lapLength,
    afterCatch,
    direction: { ...directionByType },
    course: course ? { name: course.name, points: course.points, lengthKm: course.lengthKm, closed: course.closed, hasElevation: course.hasElevation } : null,
    hillEffect,
    grades: gradeData,
    scenarioAdjustments,
    review: reviewState,
    historyCourse,
    club: currentClub() ? currentClub().id : null,
    version: APP_VERSION
  };
  if (!opts.lean) {
    // Snapshot images are regenerated on load, so they are not stored in the file.
    data.catches = catches.map(({ snapshot, ...rest }) => rest);
    data.raceElapsed = raceElapsed;
    data.finishers = finishers;
    data.baselineGrades = baselineGrades;
  }
  return data;
}

function validCourse(c) {
  return c && Array.isArray(c.points) && c.points.length >= 2 &&
    c.points.every(p => Array.isArray(p) && p.length >= 2 && p.every(v => isFinite(+v))) && +c.lengthKm > 0;
}

// Apply saved race data to the page. Throws if the data is not a race.
function applyRaceData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.grades) || data.grades.length === 0) {
    throw new Error('This is not a valid race (no grades found).');
  }

  raceName = typeof data.raceName === 'string' && data.raceName ? data.raceName : 'Cycling Race';
  raceType = VALID_RACE_TYPES.includes(data.raceType) ? data.raceType : 'circuit';
  raceStartMinutes = isFinite(+data.raceStartMinutes) ? +data.raceStartMinutes : 540;
  lapLength = +data.lapLength > 0 ? +data.lapLength : DEFAULT_DISTANCES[distanceCategory(raceType)];
  distanceByType[distanceCategory(raceType)] = lapLength;
  afterCatch = AFTER_CATCH[data.afterCatch] ? data.afterCatch : 'continue';
  document.getElementById('after-catch').value = afterCatch;
  updateAfterCatchHint();
  directionByType = { ...DEFAULT_DIRECTIONS };
  if (data.direction && typeof data.direction === 'object') {
    for (const t of Object.keys(DEFAULT_DIRECTIONS)) {
      if (data.direction[t] === 'clockwise' || data.direction[t] === 'anticlockwise') directionByType[t] = data.direction[t];
    }
  }
  course = validCourse(data.course) ? {
    name: String(data.course.name || ''),
    points: data.course.points.map(p => [+p[0], +p[1], +(p[2] || 0)]),
    lengthKm: +data.course.lengthKm,
    closed: !!data.course.closed,
    hasElevation: !!data.course.hasElevation
  } : null;
  hillEffect = data.hillEffect !== false;
  plannerLocks = new Set();
  reviewState = validReview(data.review) ? data.review : null;
  if (data.club !== undefined && clubList().some(c => c.id === data.club)) selectedClub = data.club;
  historyCourse = typeof data.historyCourse === 'string' ? data.historyCourse : '';

  document.getElementById('race-name').value = raceName;
  document.getElementById('race-start-time').value = toClock(raceStartMinutes);
  document.querySelectorAll('.race-type-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`${raceType}-btn`).classList.add('active');
  document.getElementById('distance-label').innerHTML = lapLengthLabelHTML(raceType, lapLength);

  let form = document.getElementById('grade-form');
  form.innerHTML = '';
  gradeCounter = 0;
  data.grades.slice(0, MAX_GRADES).forEach((g, i) => {
    addGradeRow(form, i, g.name ?? '', safeColor(g.color, defaultColor(i)),
      toClock(isFinite(+g.start) ? +g.start : raceStartMinutes + i * 2),
      +g.laps > 0 ? +g.laps : 1, +g.spd > 0 ? +g.spd : 18, g.prevtime || '', true, +g.range > 0 ? +g.range : 0);
    gradeCounter++;
  });
  let btnContainer = document.createElement('div');
  btnContainer.innerHTML = addGradeButtonHTML();
  form.appendChild(btnContainer);
  updateMoveButtons();
  updateAddButton();

  // updateCourseSetup() rebuilds the baseline and resets the adjustments,
  // so keep the saved adjustments and re-apply them afterwards.
  const savedAdjustments = Array.isArray(data.scenarioAdjustments) ? data.scenarioAdjustments : [];
  raceElapsed = 0;
  updateCourseSetup();
  savedAdjustments.forEach((adj, i) => {
    adj = Math.max(-4, Math.min(4, Math.round(+adj) || 0));
    let slider = document.getElementById(`scenario-slider-${i}`);
    if (adj !== 0 && slider) {
      slider.value = adj;
      updateScenario(i, adj);
    }
  });

  if (+data.raceElapsed > 0) {
    raceElapsed = Math.min(+data.raceElapsed, raceMaxElapsed);
    setSliderValue(raceElapsed * 100);
    updateRaceToTime(raceElapsed);
  }
  refreshRaceViews();
}

// ---------- Generic dialog ----------

function openDialog(title, bodyHTML, footHTML = '') {
  document.getElementById('dialogTitle').textContent = title;
  document.getElementById('dialogBody').innerHTML = bodyHTML;
  const foot = document.getElementById('dialogFoot');
  foot.innerHTML = footHTML;
  foot.style.display = footHTML ? '' : 'none';
  document.getElementById('dialog').classList.add('active');
}

function closeDialog() {
  document.getElementById('dialog').classList.remove('active');
}

// ---------- Autosave and race library (this browser only) ----------

const LIBRARY_KEY = 'crs-library-v1';
const AUTOSAVE_KEY = 'crs-autosave-v1';

function storageGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (grades.length) storageSet(AUTOSAVE_KEY, buildRaceData({ lean: true }));
  }, 400);
}

function readLibrary() {
  const lib = storageGet(LIBRARY_KEY, []);
  return Array.isArray(lib) ? lib.filter(e => e && e.id && e.data) : [];
}

function raceMeta(data) {
  const n = Array.isArray(data.grades) ? data.grades.length : 0;
  const type = RACE_TYPE_LABELS[data.raceType] || 'Race';
  const dist = data.raceType === 'circuit' ? `${data.lapLength} km lap` : `${data.lapLength} km`;
  return `${type} · ${dist} · ${n} grade${n === 1 ? '' : 's'}${data.course ? ' · map' : ''}`;
}

function openLibrary() {
  const lib = readLibrary().sort((a, b) => b.savedAt - a.savedAt);
  const items = lib.length ? lib.map(e => `
    <div class="lib-item">
      <div class="lib-main">
        <div class="lib-name">${escapeHtml(e.name)}</div>
        <div class="lib-meta">${escapeHtml(raceMeta(e.data))} · saved ${escapeHtml(new Date(e.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</div>
      </div>
      <div class="lib-actions">
        <button class="btn sm primary" onclick="openFromLibrary('${e.id}')">Open</button>
        <button class="btn sm" onclick="duplicateInLibrary('${e.id}')" title="Make a copy">Duplicate</button>
        <button class="btn sm danger" onclick="deleteFromLibrary('${e.id}')" title="Delete">Delete</button>
      </div>
    </div>`).join('') : `<div class="lib-empty">No saved races yet. Save this one to start your library.</div>`;

  openDialog('Races', `
    <div class="lib-save">
      <label class="field" style="flex:1">
        <span class="field-label">Save this race as</span>
        <input type="text" id="lib-name" value="${escapeHtml(raceName)}" maxlength="80">
      </label>
      <button class="btn primary" onclick="saveToLibrary()">Save to library</button>
    </div>
    <div class="lib-list">${items}</div>
    <p class="field-hint" style="margin:12px 0 0">Saved in this browser on this device. To move a race to another device, download it as a file or share a link.</p>
  `, `
    <button class="btn" onclick="openWizard()">New race…</button>
    <button class="btn" onclick="closeDialog(); loadRace()">Open file…</button>
    <button class="btn" onclick="closeDialog(); saveRace()">Download file</button>
    <span style="flex:1"></span>
    <button class="btn" onclick="closeDialog()">Close</button>
  `);
}

function saveToLibrary() {
  const name = (document.getElementById('lib-name').value || raceName).trim();
  const lib = readLibrary();
  const existing = lib.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (existing && !confirm(`Replace the saved race “${name}”?`)) return;
  const entry = { id: existing ? existing.id : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, savedAt: Date.now(), data: buildRaceData({ lean: true }) };
  const next = existing ? lib.map(e => e.id === existing.id ? entry : e) : lib.concat(entry);
  if (!storageSet(LIBRARY_KEY, next)) { alert('Could not save: this browser is blocking local storage.'); return; }
  showToast(`<span class="t-ico">✓</span><span>Saved <strong>${escapeHtml(name)}</strong> to your library</span>`);
  openLibrary();
}

function openFromLibrary(id) {
  const e = readLibrary().find(x => x.id === id);
  if (!e) return;
  try {
    applyRaceData(e.data);
    closeDialog();
    showToast(`<span class="t-ico">✓</span><span>Opened <strong>${escapeHtml(e.name)}</strong></span>`);
  } catch (err) { alert(err.message); }
}

function duplicateInLibrary(id) {
  const lib = readLibrary();
  const e = lib.find(x => x.id === id);
  if (!e) return;
  let name = `${e.name} (copy)`, k = 2;
  while (lib.some(x => x.name === name)) name = `${e.name} (copy ${k++})`;
  lib.push({ ...e, id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, savedAt: Date.now(), data: { ...e.data, raceName: name } });
  storageSet(LIBRARY_KEY, lib);
  openLibrary();
}

function deleteFromLibrary(id) {
  const lib = readLibrary();
  const e = lib.find(x => x.id === id);
  if (!e || !confirm(`Delete “${e.name}” from your library?`)) return;
  storageSet(LIBRARY_KEY, lib.filter(x => x.id !== id));
  openLibrary();
}

// ---------- Share links ----------

async function shareRace() {
  if (!grades.length) return;
  let code;
  try { code = await SimCore.encodeShare(buildRaceData({ lean: true })); }
  catch (e) { alert('Could not create a link for this race.'); return; }
  const url = `${location.href.split('#')[0]}#race=${code}`;
  const local = location.protocol === 'file:';
  const canShare = typeof navigator.share === 'function' && !local;
  openDialog('Share this race', `
    <p style="margin:0 0 10px;color:var(--text-2)">Anyone with this link opens <strong>${escapeHtml(raceName)}</strong> with your grades, start times and settings. Nothing is uploaded; the whole race is inside the link.</p>
    <input type="text" id="share-url" readonly value="${escapeHtml(url)}" onclick="this.select()">
    <p class="field-hint" style="margin:8px 0 0">${Math.round(url.length / 100) / 10}k characters${local ? ' · <strong>This page is a file on this computer, so the link only works here. Links work for other people once the app is hosted.</strong>' : ''}</p>
  `, `
    ${canShare ? '<button class="btn" onclick="nativeShare()">Share…</button>' : ''}
    <span style="flex:1"></span>
    <button class="btn primary" onclick="copyShareLink()">Copy link</button>
  `);
}

async function copyShareLink() {
  const input = document.getElementById('share-url');
  try { await navigator.clipboard.writeText(input.value); }
  catch (e) { input.select(); document.execCommand && document.execCommand('copy'); }
  showToast(`<span class="t-ico">✓</span><span>Link copied</span>`);
}

async function nativeShare() {
  try { await navigator.share({ title: raceName, text: `${raceName}: race plan`, url: document.getElementById('share-url').value }); } catch (e) {}
}

// On start-up: a shared link wins, otherwise restore the last session.
async function restoreStartupRace() {
  const m = location.hash.match(/^#race=([A-Za-z0-9_-]+)$/);
  if (m) {
    try {
      const data = await SimCore.decodeShare(m[1]);
      applyRaceData(data);
      history.replaceState(null, '', location.href.split('#')[0]);
      showToast(`<span class="t-ico">✓</span><span>Opened shared race <strong>${escapeHtml(raceName)}</strong></span>`);
      return;
    } catch (e) {
      showToast(`<span class="t-ico">!</span><span>That share link could not be opened.</span>`);
    }
  }
  const saved = storageGet(AUTOSAVE_KEY, null);
  if (saved) {
    try { applyRaceData(saved); } catch (e) { /* ignore a damaged autosave */ }
  }
}

// ---------- Results import (calibrate speeds) ----------

let importState = null;
// Post-race review: per-grade summary of an imported results file (no riders' names).
let reviewState = null;
// Course used for the speed history (built-in club history plus your own reviewed races).
let historyCourse = '';
let historyRecent = 6;

function importResults() {
  document.getElementById('resultsFileInput').click();
}

function normaliseGradeLabel(s) {
  return String(s).toLowerCase().replace(/\b(grade|grd|cat|category|class|division|div|race)\b/g, '').replace(/[^a-z0-9+]/g, '');
}

function handleResultsFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    let res;
    try { res = SimCore.readResults(String(e.target.result)); }
    catch (err) { alert(`Could not read results: ${err.message}`); return; }
    const used = new Set();
    const map = res.groups.map(gr => {
      const key = normaliseGradeLabel(gr.label);
      let hit = grades.find(g => normaliseGradeLabel(g.name) === key) || grades.find(g => g.name.toLowerCase() === gr.label.toLowerCase());
      // Club exports often prefix men's grades with M (MA, MB, …); match those to A, B, …
      if (!hit && /^m[a-z]$/.test(key)) hit = grades.find(g => normaliseGradeLabel(g.name) === key.slice(1));
      if (!hit || used.has(hit.idx)) return -1;
      used.add(hit.idx);
      return hit.idx;
    });
    importState = { res, map, fileName: file.name };
    renderImportDialog();
  };
  reader.readAsText(file);
}

function importStats(k) {
  const { res, map } = importState;
  const g = map[k] >= 0 ? grades[map[k]] : null;
  // A lap length found in the file wins over the race's setting
  return SimCore.speedStats(res.groups[k].riders, g ? g.totalDistance : 0, res.lapKm || lapLength);
}

function renderImportDialog() {
  const { res, map, fileName } = importState;
  const cols = Object.entries(res.columns).filter(([k, i]) => i >= 0 && !['bestLap', 'bestSpeed'].includes(k)).map(([, i]) => res.headers[i]);
  const rows = res.groups.map((gr, k) => {
    const st = importStats(k);
    const g = map[k] >= 0 ? grades[map[k]] : null;
    const options = `<option value="-1">— skip —</option>` + grades.map(x =>
      `<option value="${x.idx}" ${map[k] === x.idx ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
    const speed = st.n ? `<strong class="mono">${st.speed}</strong> <span class="muted">±${st.range}</span>` : '<span class="muted">no usable times</span>';
    const now = g ? `<span class="mono muted">${fmtSpd(g.spd)} ±${g.range}</span>` : '';
    const laps = gr.fullLaps ? `<span class="mono">${gr.fullLaps}</span>${gr.shortCount ? `<div class="muted" style="font-size:11.5px">${gr.shortCount} lapped/pulled not counted</div>` : ''}` : '<span class="muted">—</span>';
    return `<tr>
      <td><strong>${escapeHtml(gr.label)}</strong></td>
      <td class="mono">${st.n || 0}</td>
      <td>${laps}</td>
      <td>${speed}${st.n ? `<div class="muted" style="font-size:11.5px">${fmtSpd(st.min)}–${fmtSpd(st.max)} km/h</div>` : ''}</td>
      <td><select onchange="importState.map[${k}] = +this.value; renderImportDialog()">${options}</select></td>
      <td>${now}</td>
    </tr>`;
  }).join('');
  const noDistance = res.columns.speed < 0 && res.columns.distance < 0 && res.columns.laps < 0;
  let lapNote = '';
  if (res.lapKm) {
    const differs = raceType === 'circuit' && Math.abs(res.lapKm - lapLength) > 0.005;
    lapNote = `<div class="callout${differs ? ' warn' : ''}"><span>This file's lap is <strong>${res.lapKm} km</strong> (worked out from best lap times and speeds), and speeds below use it.${differs ? ` Your race is set to ${lapLength} km. <button class="link-btn" onclick="useImportLap()">Use ${res.lapKm} km for this race</button>` : ''}</span></div>`;
  } else if (res.columns.speed < 0 && res.columns.distance < 0 && res.columns.laps >= 0) {
    lapNote = `<div class="callout"><span>Distances come from the <strong>Laps</strong> column × the current ${raceType === 'circuit' ? 'lap length' : 'race length'} (<strong>${lapLength} km</strong>). If these results were raced on a different course, set that length first.</span></div>`;
  }
  openDialog('Import results', `
    <p style="margin:0 0 12px;color:var(--text-2)"><strong>${escapeHtml(fileName)}</strong>: ${res.groups.reduce((s, g) => s + g.riders.length, 0)} finishers in ${res.groups.length} groups${res.skipped ? `, ${res.skipped} rows skipped (DNF, DNS, DQ or no time)` : ''}. Using columns: ${cols.map(escapeHtml).join(', ')}.</p>
    ${lapNote}
    ${noDistance ? `<div class="callout warn"><span>The file has no speed, distance or laps column, so speeds are worked out from each matched grade's <strong>current race distance</strong>. Make sure laps and lap length match the race these results came from.</span></div>` : ''}
    <div class="table-wrap"><table class="data">
      <thead><tr><th>In file</th><th>Riders</th><th>Laps</th><th>Typical speed (km/h)</th><th>Grade</th><th>Current</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="field-hint" style="margin:10px 0 0">Speed is the median rider who rode the full distance; the ± range covers the middle 80%. Lapped or pulled riders and speeds outside 10–70 km/h are left out.</p>
    <label class="check" style="margin-top:6px"><input type="checkbox" id="import-ranges" checked> Also set each grade's ± range when applying speeds</label>
  `, `
    <button class="btn" onclick="closeDialog()">Cancel</button>
    <span style="flex:1"></span>
    <button class="btn" onclick="compareWithPlan()" title="See how this race compared with your plan">Compare with plan</button>
    <button class="btn primary" onclick="applyImport()">Apply speeds</button>
  `);
}

function applyImport() {
  const { res, map } = importState;
  const setRanges = document.getElementById('import-ranges').checked;
  const rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  let n = 0;
  res.groups.forEach((gr, k) => {
    if (map[k] < 0) return;
    const st = importStats(k);
    if (!st.n) return;
    const row = rows[map[k]];
    if (!row) return;
    document.getElementById(`g${row.dataset.index}_spd`).value = st.speed;
    if (setRanges) document.getElementById(`g${row.dataset.index}_range`).value = st.range;
    n++;
  });
  closeDialog();
  updateCourseSetup();
  showUndoToast(`<span class="t-ico">✓</span><span>Speeds updated for <strong>${n}</strong> grade${n === 1 ? '' : 's'}</span>`);
}
