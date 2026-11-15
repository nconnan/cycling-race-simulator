/*
 * Cycling Race Simulator v11 — page logic.
 * The race maths lives in js/core.js (SimCore) and is covered by tests/core.test.js.
 */
const { toClock, toClockSec, fromClock, formatDuration, formatElapsed, formatSplit, finishClockOf } = SimCore;

let grades = [], catches = [], finishers = [];
let raceRunning = false, raceElapsed = 0, raceMaxElapsed = 30, raceInterval = null;
let raceStartMinutes = 540, lapLength = 2;
let speedMultiplier = 1;
const BASE_INTERVAL_DELAY = 36;
// Race minutes advanced per BASE_INTERVAL_DELAY ms of real time at 1x speed.
const RACE_MINUTES_PER_TICK = 0.032;
let lastTickTime = 0;
let rafId = null;
let lastPanelUpdate = 0;
// Real seconds the fastest grade should take for one lap (circuits) or the whole
// course (other races) at 1×, so short courses don't flash past.
const TARGET_LAP_SECONDS = 8;
const TARGET_COURSE_SECONDS = 15;
// Fastest playback at 1× (the v10 rate: 0.032 race-min every 36 ms ≈ 53× real time).
const MAX_RACE_MINUTES_PER_SECOND = RACE_MINUTES_PER_TICK / BASE_INTERVAL_DELAY * 1000;
const snapshotQueue = [];
let snapshotTimer = null;
let gradeCounter = 5;
let catchesProcessed = new Set();
let baselineGrades = [];
const MAX_GRADES = 15;
let scenarioAdjustments = [];
let raceType = 'circuit';
let raceName = 'Cycling Race';
let gradesSectionOpen = true;
let configSectionOpen = true;
let stagedGrades = [];
let finishFlagShown = false;
let finishingGradeName = '';
let summaryTableSortColumn = 0;
let summaryTableSortDirection = 'asc';
// All catch events for the current setup, computed once and sorted by time.
let catchEvents = [];
// Snapshot images keyed by catch event, kept while scrubbing back and forth.
let snapshotCache = new Map();
let lastCatchTableSig = null;
// Remembered course lengths so switching race type does not discard the user's value.
const DEFAULT_DISTANCES = { circuit: 2, linear: 10 };
let distanceByType = { ...DEFAULT_DISTANCES };
const VALID_RACE_TYPES = ['circuit', 'point', 'outback'];
const RACE_TYPE_LABELS = { circuit: 'Circuit', point: 'Point to point', outback: 'Out & back' };
// What happens when a grade is caught (see SimCore.simulateRace).
let afterCatch = 'continue';
// Direction of travel drawn on the track (display only; timings are unaffected).
// Defaults match earlier versions: circuits anticlockwise, out-and-back clockwise.
const DEFAULT_DIRECTIONS = { circuit: 'anticlockwise', outback: 'clockwise' };
let directionByType = { ...DEFAULT_DIRECTIONS };
// Course map from a GPX file (null = standard drawn shape) and whether hills move riders.
let course = null;
let hillEffect = true;
let warp = { toU: x => x, toX: u => u, identity: true };
let plannerLocks = new Set();
let autosaveTimer = null;
const AFTER_CATCH = {
  continue: { label: 'Both grades carry on', hint: 'Grades pass through each other; speeds never change.' },
  neutralise: { label: 'Caught grade neutralised', hint: 'A caught grade stops racing at the catch and gets no finish time.' },
  merge: { label: 'Caught grade joins the bunch', hint: 'A caught grade rides on at the catchers\u2019 speed, in the same bunch.' }
};
let simResult = null;
let currentPlan = null;
let riskTimer = null;

// Logical canvas size; the backing store is scaled for high-DPI screens.
const CW = 960, CH = 500;
let canvasDpr = 1;
let cv = {};
// Markers and labels are enlarged when the track is shown small (phones); 1 for snapshots.
let markerScale = 1;

document.getElementById('copyright-year').textContent = new Date().getFullYear();

// ---------- Small icons ----------
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_FLAG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4m0 0h12l-2 4 2 4H4"/></svg>';

// ---------- Helpers ----------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function safeColor(color, fallback = '#1976d2') {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color || '') ? color : fallback;
}

// Grey text on very light markers (e.g. white), white text otherwise.
function textColorFor(color) {
  let hex = safeColor(color, '#000000').slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.85 ? '#5b6474' : '#fff';
}

function gradeDot(name, color, cls = '') {
  const short = String(name).slice(0, 3);
  return `<span class="gdot ${cls}" style="--gc:${safeColor(color)};color:${textColorFor(color)}">${escapeHtml(short)}</span>`;
}

function gradeChip(name, color) {
  return `<span class="gchip">${gradeDot(name, color)}<span>${escapeHtml(name)}</span></span>`;
}

function distanceCategory(type) {
  return type === 'circuit' ? 'circuit' : 'linear';
}

function lapLengthLabelHTML(type, value) {
  const label = type === 'circuit' ? 'Lap length' : type === 'outback' ? 'Distance to turn' : 'Race length';
  const max = type === 'circuit' ? 50 : 200;
  return `<span class="field-label">${label}</span>
    <span class="input-unit"><input type="number" id="lap-length" value="${value}" min="0.1" max="${max}" step="0.1" onchange="handleLapLengthChange()"><span class="unit">km</span></span>`;
}

function readLapLength() {
  const v = +document.getElementById('lap-length').value;
  return v > 0 ? v : DEFAULT_DISTANCES[distanceCategory(raceType)];
}






function setRangeFill(el) {
  const min = +el.min || 0, max = +el.max || 100;
  const pct = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function setSliderValue(v) {
  const s = document.getElementById('raceSlider');
  s.value = v;
  setRangeFill(s);
}

function updateClockLabels() {
  document.getElementById("raceTimeLabel").textContent = toClock(raceStartMinutes + raceElapsed);
  document.getElementById("raceElapsedLabel").textContent = `+${formatElapsed(raceElapsed)} / ${formatElapsed(raceMaxElapsed)}`;
}

// ---------- Theme ----------

function readCanvasTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = n => cs.getPropertyValue(n).trim();
  cv = {
    bg: get('--cv-bg'), grid: get('--cv-grid'), road: get('--cv-road'), edge: get('--cv-edge'),
    lane: get('--cv-lane'), text: get('--cv-text'), ring: get('--cv-ring'), accent: get('--cv-accent'),
    finish: get('--cv-finish'), turn: get('--cv-turn')
  };
}

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  readCanvasTheme();
  drawRace();
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('crs-theme', next); } catch (e) {}
  applyTheme(next);
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('crs-theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  readCanvasTheme();
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!document.documentElement.dataset.theme) applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
})();

// ---------- Tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  try { localStorage.setItem('crs-tab', name); } catch (e) {}
}

function computeCatchEvents() {
  simResult = SimCore.simulateRace({ grades, raceType, lapLength, afterCatch });
  catchEvents = simResult.events.map(ev => {
    const a = grades[ev.c1Index], b = grades[ev.c2Index];
    const circuit = raceType === 'circuit';
    const x1 = warp.toX(ev.fasterDistance), x2 = warp.toX(ev.slowerDistance);
    return {
      ...ev,
      c1: a.name,
      c2: b.name,
      c1Color: a.color,
      c2Color: b.color,
      time: toClock(ev.catchTime),
      c1Distance: x1,
      c2Distance: x2,
      c1Lap: circuit ? Math.floor(x1 / lapLength + 1e-9) + 1 : 0,
      c2Lap: circuit ? Math.floor(x2 / lapLength + 1e-9) + 1 : 0,
      c1LapDist: circuit ? x1 - Math.floor(x1 / lapLength + 1e-9) * lapLength : x1,
      c2LapDist: circuit ? x2 - Math.floor(x2 / lapLength + 1e-9) * lapLength : x2,
      snapshot: null
    };
  });
}

// ---------- Race state ----------

function setGradeStateAt(g, clockTime) {
  const tr = simResult && simResult.tracks[g.idx];
  if (!tr) return;
  const st = SimCore.stateAt(tr, clockTime);
  // The engine works in riding-effort distance; the warp turns it into real distance on the course.
  g.position = warp.toX(st.position);
  if (raceType === 'circuit') {
    g.currentLap = Math.floor(g.position / lapLength);
  }
  g.curSpd = st.neutralised ? g.curSpd : st.speed;
  g.neutralised = st.neutralised;
  g.neutralisedAt = tr.neutralisedAt;
  g.finished = st.finished;
  g.finishClock = st.finished ? tr.finishClock : null;
  g.finishTime = st.finished ? toClock(tr.finishClock) : null;
}

function updateRaceToTime(targetElapsed) {
    const clockTime = raceStartMinutes + targetElapsed;

    for (const g of grades) {
        setGradeStateAt(g, clockTime);
    }

    finishers = grades.filter(g => g.finished);

    let anyOnFinalLap = false;
    let finalLapGrade = null;
    if (raceType === 'circuit') {
        for (const g of grades) {
            if (clockTime >= g.start && !g.finished && !g.neutralised && g.currentLap === g.laps - 1 && g.position > 0) {
                anyOnFinalLap = true;
                finalLapGrade = g.name;
                break;
            }
        }
    }

    let flagEl = document.getElementById('finish-flag');
    let flagNameEl = document.getElementById('finish-grade-name');
    if (anyOnFinalLap && !finishFlagShown) {
        finishFlagShown = true;
        finishingGradeName = finalLapGrade;
        flagEl.style.display = 'flex';
        flagNameEl.textContent = `Final lap · Grade ${finishingGradeName}`;
    } else if (!anyOnFinalLap && finishFlagShown) {
        finishFlagShown = false;
        finishingGradeName = '';
        flagEl.style.display = 'none';
    } else if (anyOnFinalLap && finishingGradeName !== finalLapGrade) {
        finishingGradeName = finalLapGrade;
        flagNameEl.textContent = `Final lap · Grade ${finishingGradeName}`;
    }

    // Catches that have happened by the current time (events are pre-sorted by time).
    const newCatches = [];
    for (const ev of catchEvents) {
        const catchElapsed = ev.catchTime - raceStartMinutes;
        if (catchElapsed > targetElapsed) break;
        if (catchElapsed < 0) continue;

        // The snapshot is rendered at the exact catch time, whichever way we got here.
        if (snapshotCache.has(ev.key)) {
            ev.snapshot = snapshotCache.get(ev.key);
        } else {
            queueSnapshot(ev);
        }

        // Warn only the first time the catch is reached.
        if (!catchesProcessed.has(ev.key)) {
            catchesProcessed.add(ev.key);
            warnCatch(ev);
        }

        newCatches.push(ev);
    }

    catches = newCatches;
}

function toggleRaceConfigSection() {
  configSectionOpen = !configSectionOpen;
  document.getElementById('config-content').classList.toggle('open', configSectionOpen);
  document.getElementById('config-arrow').classList.toggle('open', configSectionOpen);
}

function toggleGradesSection() {
  gradesSectionOpen = !gradesSectionOpen;
  document.getElementById('grades-content').classList.toggle('open', gradesSectionOpen);
  document.getElementById('grades-arrow').classList.toggle('open', gradesSectionOpen);
}

function handleRaceNameChange() {
  raceName = document.getElementById('race-name').value || 'Cycling Race';
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

function handleRaceStartTimeChange() {
  let raceStartStr = document.getElementById('race-start-time').value || "09:00";
  raceStartMinutes = fromClock(raceStartStr);
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

function handleLapLengthChange() {
  lapLength = readLapLength();
  document.getElementById('lap-length').value = lapLength;
  distanceByType[distanceCategory(raceType)] = lapLength;
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

function handleGradeInputChange() {
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

function setRaceType(type) {
  if (!VALID_RACE_TYPES.includes(type)) return;

  // Remember the length entered for the current type before switching.
  const current = +document.getElementById('lap-length').value;
  if (current > 0) distanceByType[distanceCategory(raceType)] = current;

  raceType = type;
  document.querySelectorAll('.race-type-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`${type}-btn`).classList.add('active');

  let label = document.getElementById('distance-label');
  label.innerHTML = lapLengthLabelHTML(type, distanceByType[distanceCategory(type)]);

  renderGradeForm();
  if (grades.length > 0) {
    updateCourseSetup();
  }
}

function resetAllSetup() {
  if (confirm('This will reset all race configuration. Are you sure?')) {
    document.getElementById('race-name').value = 'Cycling Race';
    document.getElementById('race-start-time').value = '09:00';

    raceType = 'circuit';
    distanceByType = { ...DEFAULT_DISTANCES };
    document.querySelectorAll('.race-type-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('circuit-btn').classList.add('active');

    let label = document.getElementById('distance-label');
    label.innerHTML = lapLengthLabelHTML('circuit', DEFAULT_DISTANCES.circuit);

    afterCatch = 'continue';
    document.getElementById('after-catch').value = afterCatch;
    updateAfterCatchHint();
    directionByType = { ...DEFAULT_DIRECTIONS };
    course = null;
    hillEffect = true;
    plannerLocks = new Set();
    reviewState = null;

    gradeCounter = 5;
    setupGradeInputs();

    // Rebuild the race from the default grades, as on first load.
    updateCourseSetup();
  }
}

function addGradeButtonHTML() {
  return `<button type="button" class="add-grade-btn" id="addGradeBtn" onclick="addNewGrade()">+ Add grade</button>
    <button type="button" class="import-btn" onclick="importResults()" title="Set speeds and ± ranges from a results file (CSV)">Import results (CSV)…</button>`;
}

function setupGradeInputs() {
  let form = document.getElementById('grade-form');
  let defaults = [
    {name:"A",color:"#ffffff",spd:42},
    {name:"B",color:"#ffd600",spd:40},
    {name:"C",color:"#1976d2",spd:38},
    {name:"D",color:"#43a047",spd:36},
    {name:"E",color:"#e53935",spd:34}
  ];

  gradeCounter = 5;
  form.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    let d = defaults[i];
    let laps = raceType === 'circuit' ? 6-i : 1;
    addGradeRow(form, i, d.name, d.color, defaultClock(i), laps, d.spd, '', true, 1);
  }
  let btnContainer = document.createElement('div');
  btnContainer.innerHTML = addGradeButtonHTML();
  form.appendChild(btnContainer);
  updateMoveButtons();
  updateAddButton();
}

function addGradeRow(container, index, name, color, startTime, laps, speed, prevtime = '', isInitial = false, range = 0) {
  let rowDiv = document.createElement('div');
  rowDiv.className = 'grade-row';
  rowDiv.dataset.index = index;
  // Keep the lap count even when the laps field is hidden (non-circuit races).
  rowDiv.dataset.laps = laps;
  const c = safeColor(color, '#000000');
  rowDiv.style.setProperty('--gc', c);

  let lapsHTML = raceType === 'circuit' ?
    `<label class="mini"><span>Laps</span><input type="number" id="g${index}_laps" value="${escapeHtml(laps)}" min="1" max="20" onchange="handleGradeInputChange()"></label>` : '';

  rowDiv.innerHTML = `
    <div class="gr-top">
      <label class="swatch" title="Grade colour">
        <input type="color" id="g${index}_color" value="${c}" oninput="this.closest('.grade-row').style.setProperty('--gc', this.value)" onchange="handleGradeInputChange()">
      </label>
      <input class="gr-name" type="text" maxlength="12" value="${escapeHtml(name)}" id="g${index}_name" placeholder="Grade name" aria-label="Grade name" onchange="handleGradeInputChange()">
      <div class="gr-actions">
        <button type="button" class="icon-btn mv-up" onclick="moveGradeUp(${index})" title="Move up" aria-label="Move up">${ICON_UP}</button>
        <button type="button" class="icon-btn mv-down" onclick="moveGradeDown(${index})" title="Move down" aria-label="Move down">${ICON_DOWN}</button>
        <button type="button" class="icon-btn remove" onclick="removeGrade(${index})" title="Remove grade" aria-label="Remove grade">${ICON_X}</button>
      </div>
    </div>
    <div class="gr-fields${raceType === 'circuit' ? '' : ' no-laps'}">
      <label class="mini"><span>Start</span><input type="time" id="g${index}_start" value="${escapeHtml(startTime)}" step="60" onchange="handleGradeInputChange()"></label>
      ${lapsHTML}
      <label class="mini"><span>Speed</span><span class="input-unit"><input type="number" id="g${index}_spd" value="${escapeHtml(speed)}" min="18" max="60" step="0.1" onchange="handleGradeInputChange()"><span class="unit">km/h</span></span></label>
      <label class="mini" title="How far this grade's speed may vary either way. Used by Catch risk and the Start planner."><span>± Range</span><span class="input-unit"><input type="number" id="g${index}_range" value="${escapeHtml(range)}" min="0" max="10" step="0.5" onchange="handleGradeInputChange()"><span class="unit">km/h</span></span></label>
      <label class="mini prev" title="Enter a previous race time (HH:MM:SS) to calculate the speed"><span>Prev time</span><input type="text" id="g${index}_prevtime" value="${escapeHtml(prevtime)}" placeholder="01:23:45" onchange="calculateGradeSpeed(${index})"></label>
    </div>
  `;

  let btnContainer = container.querySelector('div:last-child');
  if (btnContainer && btnContainer.querySelector('.add-grade-btn')) {
    container.insertBefore(rowDiv, btnContainer);
  } else {
    container.appendChild(rowDiv);
  }
}

function calculateGradeSpeed(index) {
  let timeStr = document.getElementById(`g${index}_prevtime`).value;
  let distance = readLapLength();

  if (!timeStr) return;

  let parts = timeStr.split(':');
  if (parts.length !== 3) {
    alert('Please enter time in HH:MM:SS format');
    return;
  }

  let hours = +parts[0];
  let minutes = +parts[1];
  let seconds = +parts[2];
  let totalHours = hours + minutes/60 + seconds/3600;

  if (!isFinite(totalHours) || totalHours <= 0) {
    alert('Please enter time in HH:MM:SS format');
    return;
  }

  if (raceType === 'circuit') {
    let laps = +document.getElementById(`g${index}_laps`)?.value || 1;
    distance = distance * laps;
  } else if (raceType === 'outback') {
    distance = distance * 2;
  }

  let speed = (distance / totalHours).toFixed(1);
  document.getElementById(`g${index}_spd`).value = speed;

  handleGradeInputChange();
}

function renderGradeForm() {
  let form = document.getElementById('grade-form');
  let existingGrades = [];

  let rows = form.querySelectorAll('.grade-row');
  rows.forEach(row => {
    let idx = row.dataset.index;
    if (document.getElementById(`g${idx}_name`)) {
      // Read the visible laps field if there is one, otherwise the remembered value.
      let lapsValue = document.getElementById(`g${idx}_laps`)?.value || row.dataset.laps || 1;
      existingGrades.push({
        index: parseInt(idx),
        name: document.getElementById(`g${idx}_name`).value,
        color: document.getElementById(`g${idx}_color`).value,
        start: document.getElementById(`g${idx}_start`).value,
        laps: lapsValue,
        spd: document.getElementById(`g${idx}_spd`).value,
        prevtime: document.getElementById(`g${idx}_prevtime`)?.value || '',
        range: document.getElementById(`g${idx}_range`)?.value || 0
      });
    }
  });

  form.innerHTML = '';
  existingGrades.forEach((g, i) => {
    addGradeRow(form, g.index, g.name, g.color, g.start, g.laps, g.spd, g.prevtime, true, g.range);
  });
  let btnContainer = document.createElement('div');
  btnContainer.innerHTML = addGradeButtonHTML();
  form.appendChild(btnContainer);
  updateMoveButtons();
  updateAddButton();
}

function addNewGrade() {
  let form = document.getElementById('grade-form');
  let rows = form.querySelectorAll('.grade-row');

  if (rows.length >= MAX_GRADES) {
    alert(`Maximum of ${MAX_GRADES} grades allowed.`);
    return;
  }

  let index = gradeCounter++;
  let name = String.fromCharCode(65 + (rows.length % 26));
  let color = defaultColor(rows.length);
  let startTime = defaultClock(rows.length);
  let laps = raceType === 'circuit' ? Math.max(1, 6 - rows.length) : 1;
  let speed = Math.max(18, 42 - rows.length * 2);

  addGradeRow(form, index, name, color, startTime, laps, speed, '', false, 1);
  updateMoveButtons();
  updateAddButton();
  handleGradeInputChange();
}

function removeGrade(index) {
  let form = document.getElementById('grade-form');
  let row = form.querySelector(`[data-index="${index}"]`);
  if (row) {
    let remainingRows = form.querySelectorAll('.grade-row').length;
    if (remainingRows <= 1) {
      alert('You must have at least one grade in the race.');
      return;
    }
    row.remove();
    updateMoveButtons();
    updateAddButton();
    handleGradeInputChange();
  }
}

function moveGradeUp(index) {
  let form = document.getElementById('grade-form');
  let row = form.querySelector(`[data-index="${index}"]`);
  let prevRow = row.previousElementSibling;
  if (prevRow && prevRow.classList.contains('grade-row')) {
    row.parentNode.insertBefore(row, prevRow);
    updateMoveButtons();
    handleGradeInputChange();
  }
}

function moveGradeDown(index) {
  let form = document.getElementById('grade-form');
  let row = form.querySelector(`[data-index="${index}"]`);
  let nextRow = row.nextElementSibling;
  if (nextRow && nextRow.classList.contains('grade-row')) {
    row.parentNode.insertBefore(nextRow, row);
    updateMoveButtons();
    handleGradeInputChange();
  }
}

function updateMoveButtons() {
  let form = document.getElementById('grade-form');
  let rows = form.querySelectorAll('.grade-row');
  rows.forEach((row, i) => {
    row.querySelector('.mv-up').disabled = (i === 0);
    row.querySelector('.mv-down').disabled = (i === rows.length - 1);
    row.querySelector('.remove').disabled = (rows.length <= 1);
  });
  document.getElementById('grades-count').textContent = rows.length;
}

function updateAddButton() {
  let form = document.getElementById('grade-form');
  let rows = form.querySelectorAll('.grade-row');
  let addBtn = document.getElementById('addGradeBtn');
  if (addBtn) {
    addBtn.disabled = (rows.length >= MAX_GRADES);
    if (rows.length >= MAX_GRADES) {
      addBtn.textContent = `Maximum ${MAX_GRADES} grades`;
    } else {
      addBtn.textContent = '+ Add grade';
    }
  }
}

function defaultColor(i) {
  const cs = ['#ffffff','#ffd600','#1976d2','#43a047','#e53935','#9c27b0','#ff6f00','#00897b','#d81b60','#5e35b1','#795548','#607d8b','#f06292','#4fc3f7','#aed581'];
  return cs[i%cs.length];
}

function defaultClock(i) {
  let raceStart = document.getElementById('race-start-time').value || "09:00";
  let mins = fromClock(raceStart) + i*2;
  return toClock(mins);
}

function updateHeaderMeta() {
  const typeLabel = RACE_TYPE_LABELS[raceType];
  const dist = raceType === 'circuit' ? `${lapLength} km lap`
    : raceType === 'outback' ? `${lapLength} km out, ${lapLength * 2} km total` : `${lapLength} km`;
  document.getElementById('appbar-race-name').textContent = raceName;
  document.getElementById('appbar-race-meta').textContent = `${typeLabel} · ${dist}`;
  const dir = directionByType[raceType] ? ` · ${directionByType[raceType]}` : '';
  document.getElementById('track-sub').textContent =
    `${typeLabel} · ${dist}${dir} · ${grades.length} grade${grades.length === 1 ? '' : 's'} · first start ${toClock(raceStartMinutes)}`;
  updateDirectionUI();
  document.getElementById('scrub-start').textContent = toClock(raceStartMinutes);
  document.getElementById('scrub-end').textContent = toClock(raceStartMinutes + raceMaxElapsed);
  document.title = `${raceName} · Cycling Race Simulator v11`;
}

function updateCourseSetup() {
  raceName = document.getElementById('race-name').value || 'Cycling Race';
  lapLength = readLapLength();
  let raceStartStr = document.getElementById('race-start-time').value || "09:00";
  raceStartMinutes = fromClock(raceStartStr);
  if (isNaN(raceStartMinutes)) raceStartMinutes = 540;
  grades = [];

  let form = document.getElementById('grade-form');
  let rows = form.querySelectorAll('.grade-row');

  rows.forEach(row => {
    let idx = row.dataset.index;
    if (document.getElementById(`g${idx}_name`)) {
      let laps = 1;
      if (raceType === 'circuit') {
        let lapsInput = document.getElementById(`g${idx}_laps`);
        laps = Math.round(+lapsInput?.value);
        if (!(laps >= 1)) { laps = 1; if (lapsInput) lapsInput.value = 1; }
        row.dataset.laps = laps;
      }
      let totalDist = raceType === 'outback' ? lapLength * 2 : lapLength * laps;

      // A zero, negative or blank speed would give infinite finish times.
      let spdInput = document.getElementById(`g${idx}_spd`);
      let spd = +spdInput.value;
      if (!(spd > 0)) { spd = 18; spdInput.value = 18; }

      let start = fromClock(document.getElementById(`g${idx}_start`).value);
      if (isNaN(start)) start = raceStartMinutes;

      let rangeInput = document.getElementById(`g${idx}_range`);
      let range = +rangeInput?.value;
      if (!(range >= 0)) { range = 0; if (rangeInput) rangeInput.value = 0; }

      grades.push({
        idx: grades.length,
        name: document.getElementById(`g${idx}_name`).value || String.fromCharCode(65 + grades.length),
        color: safeColor(document.getElementById(`g${idx}_color`).value),
        start: start,
        laps: laps,
        spd: spd,
        baseSpd: spd,
        curSpd: spd,
        range: range,
        totalDistance: totalDist,
        position: 0,
        neutralised: false,
        neutralisedAt: null,
        finished: false,
        finishTime: null,
        finishClock: null,
        currentLap: 0,
        direction: 1,
        prevtime: document.getElementById(`g${idx}_prevtime`)?.value || ''
      });
    }
  });

  stagedGrades = [...grades].sort((a, b) => a.start - b.start);

  baselineGrades = JSON.parse(JSON.stringify(grades));
  scenarioAdjustments = grades.map(() => 0);

  populateScenarioPanel();

  warp = SimCore.makeWarp(course, lapLength, raceType, hillEffect ? 1 : 0);
  mapGeometryCache = null;
  computeCatchEvents();
  raceMaxElapsed = Math.max(0, simResult.endClock - raceStartMinutes);
  document.getElementById('raceSlider').max = Math.ceil(raceMaxElapsed*100);
  updatePlannerForm();
  invalidatePlan();
  scheduleRiskUpdate();
  updatePlaybackHint();
  updateCourseUI();
  renderPlannerLocks();
  renderReview();
  scheduleAutosave();
  updateHeaderMeta();
  resetRace();
  drawStagingArea();
}

function drawStagingArea() {
  let stagingDiv = document.getElementById('staging-area');
  const clock = raceStartMinutes + raceElapsed;
  // Grades currently racing: started and not yet finished.
  const onCourse = stagedGrades.filter(g => !g.finished && !g.neutralised && clock >= g.start);
  if (onCourse.length === 0) {
    let msg = '—';
    if (grades.length) {
      msg = grades.every(g => g.finished || g.neutralised) ? 'All grades finished'
        : `First start ${toClock(Math.min(...grades.map(g => g.start)))}`;
    }
    stagingDiv.innerHTML = `<span class="staging-empty">${msg}</span>`;
    return;
  }
  stagingDiv.innerHTML = onCourse.map(g => {
    const where = raceType === 'circuit'
      ? `Lap ${Math.min(g.laps, Math.floor(g.position / lapLength) + 1)}/${g.laps}`
      : `${g.position.toFixed(1)} km`;
    return `<div class="staged-grade" title="Grade ${escapeHtml(g.name)} · started ${toClock(g.start)}">${gradeDot(g.name, g.color, 'sm')}<span class="staged-time mono">${where}</span></div>`;
  }).join('');
}

// ---------- What-if analysis ----------

function populateScenarioPanel() {
  let grid = document.getElementById('scenario-grid');
  grid.innerHTML = '';

  grades.forEach((g, i) => {
    let card = document.createElement('div');
    card.className = 'sc-card';
    card.style.setProperty('--gc', safeColor(g.color));
    card.innerHTML = `
      <div class="sc-head">
        ${gradeDot(g.name, g.color)}
        <div>
          <div class="sc-title">Grade ${escapeHtml(g.name)}</div>
          <div class="sc-sub">Base ${g.baseSpd} km/h</div>
        </div>
        <span class="sc-val mono" id="scenario-value-${i}">0 km/h</span>
      </div>
      <input type="range" class="slider" min="-4" max="4" value="0" step="1" id="scenario-slider-${i}"
             aria-label="Speed adjustment for grade ${escapeHtml(g.name)}"
             oninput="updateScenario(${i}, this.value)">
      <div class="sc-scale mono"><span>−4</span><span>0</span><span>+4</span></div>
      <div class="sc-result" id="scenario-result-${i}">
        <div class="scenario-result-item">Loading prediction...</div>
      </div>
    `;
    grid.appendChild(card);
    setRangeFill(card.querySelector('input[type=range]'));
  });

  recalculateAllScenarios();
}

function updateScenario(gradeIndex, adjustment) {
  adjustment = +adjustment;
  scenarioAdjustments[gradeIndex] = adjustment;

  const valEl = document.getElementById(`scenario-value-${gradeIndex}`);
  valEl.textContent = `${adjustment > 0 ? '+' : ''}${adjustment} km/h`;
  valEl.classList.toggle('up', adjustment > 0);
  valEl.classList.toggle('down', adjustment < 0);
  const slider = document.getElementById(`scenario-slider-${gradeIndex}`);
  if (slider) setRangeFill(slider);

  recalculateAllScenarios();
}

function resetScenarioAdjustments() {
  scenarioAdjustments.forEach((adj, i) => {
    const slider = document.getElementById(`scenario-slider-${i}`);
    if (slider) slider.value = 0;
    updateScenario(i, 0);
  });
}

function recalculateAllScenarios() {
  let testGrades = JSON.parse(JSON.stringify(baselineGrades));
  scenarioAdjustments.forEach((adj, i) => {
    if (!testGrades[i]) return;
    testGrades[i].spd = Math.max(1, testGrades[i].baseSpd + adj);
  });
  const opts = { raceType, lapLength, afterCatch };
  const sim = SimCore.simulateRace({ ...opts, grades: testGrades });
  const baseSim = SimCore.simulateRace({ ...opts, grades: baselineGrades });

  grades.forEach((g, i) => {
    let result = calculateScenarioOutcome(testGrades, i, sim, baseSim);
    displayScenarioResult(i, result, scenarioAdjustments[i]);
  });
}

function scenarioCatchDetails(name, faster, r) {
  const x = warp.toX(r.fasterDistance);
  let details = {
    name: name,
    time: toClock(r.catchTime),
    distance: x.toFixed(2),
    fromFinish: (faster.totalDistance - x).toFixed(2)
  };
  if (raceType === 'circuit') {
    const lapsDone = Math.floor(x / lapLength + 1e-9);
    details.lap = lapsDone + 1;
    details.lapDist = (x - lapsDone * lapLength).toFixed(2);
  }
  return details;
}

function calculateScenarioOutcome(testGrades, changedIndex, sim, baseSim) {
  const tr = sim.tracks[changedIndex];
  const baseTr = baseSim.tracks[changedIndex];
  let result = {
    finishTime: tr.finishClock !== null ? toClock(tr.finishClock) : null,
    neutralisedAt: tr.neutralisedAt,
    finishChange: 0,
    catches: [],
    caughtBy: []
  };
  if (tr.finishClock !== null && baseTr.finishClock !== null) {
    result.finishChange = Math.round((tr.finishClock - baseTr.finishClock) * 100) / 100;
  }

  for (const ev of sim.events) {
    if (ev.c1Index === changedIndex) {
      result.catches.push(scenarioCatchDetails(testGrades[ev.c2Index].name, testGrades[ev.c1Index], ev));
    } else if (ev.c2Index === changedIndex) {
      result.caughtBy.push(scenarioCatchDetails(testGrades[ev.c1Index].name, testGrades[ev.c1Index], ev));
    }
  }

  return result;
}

function displayScenarioResult(gradeIndex, result, adjustment) {
  let resultDiv = document.getElementById(`scenario-result-${gradeIndex}`);
  let html = '';

  html += result.finishTime === null
    ? `<div class="scenario-result-item"><strong>Finish:</strong> <span class="pill out">Neutralised ${toClock(result.neutralisedAt)}</span>`
    : `<div class="scenario-result-item"><strong>Finish:</strong> <span class="mono">${result.finishTime}</span>`;
  if (result.finishChange !== 0) {
    const cls = result.finishChange > 0 ? 'later' : 'earlier';
    html += ` <span class="scenario-result-change ${cls}">(${result.finishChange > 0 ? '+' : ''}${result.finishChange.toFixed(1)} min)</span>`;
  }
  html += '</div>';

  const describe = c => {
    let line = `<div class="scenario-result-item">→ <strong>${escapeHtml(c.name)}</strong> at <span class="mono">${c.time}</span>`;
    if (raceType === 'circuit') {
      line += ` <span class="muted">· Lap ${c.lap}, ${c.lapDist} km</span>`;
    } else {
      line += ` <span class="muted">· ${c.distance} km from start, ${c.fromFinish} km to finish</span>`;
    }
    return line + '</div>';
  };

  if (result.catches.length > 0) {
    html += '<div class="scenario-result-head">Would catch</div>';
    html += result.catches.map(describe).join('');
  }

  if (result.caughtBy.length > 0) {
    html += '<div class="scenario-result-head">Would be caught by</div>';
    html += result.caughtBy.map(describe).join('');
  }

  if (result.catches.length === 0 && result.caughtBy.length === 0) {
    html += '<div class="scenario-result-item scenario-result-same">No catch events</div>';
  }

  resultDiv.innerHTML = html;
}

// ---------- Playback ----------

function refreshRaceViews() {
  updateClockLabels();
  updateFinishersDisplay();
  updateCatchTable();
  updateRaceSummary();
  drawRace();
  drawStagingArea();
}

document.getElementById('raceSlider').addEventListener('input', function(e) {
  pauseRace();
  raceElapsed = +e.target.value / 100;
  setRangeFill(e.target);
  updateRaceToTime(raceElapsed);
  refreshRaceViews();
});

function scrubBy(minutes) {
  pauseRace();
  raceElapsed = Math.max(0, Math.min(raceMaxElapsed, raceElapsed + minutes));
  setSliderValue(Math.floor(raceElapsed * 100));
  updateRaceToTime(raceElapsed);
  refreshRaceViews();
}

function setSpeed(multiplier) {
    speedMultiplier = multiplier;
    document.querySelectorAll('.speed-btn').forEach(btn =>
      btn.classList.toggle('active', +btn.dataset.speed === multiplier));
    updatePlaybackHint();
}

// Race minutes shown per real second at 1×.
function baseRaceMinutesPerSecond() {
  if (!grades.length) return MAX_RACE_MINUTES_PER_SECOND;
  const fastest = Math.max(...grades.map(g => g.spd));
  const unitKm = raceType === 'circuit' ? lapLength : raceType === 'outback' ? 2 * lapLength : lapLength;
  const target = raceType === 'circuit' ? TARGET_LAP_SECONDS : TARGET_COURSE_SECONDS;
  return Math.min(MAX_RACE_MINUTES_PER_SECOND, (unitKm * 60 / fastest) / target);
}

function updatePlaybackHint() {
  const el = document.getElementById('playback-hint');
  if (!el) return;
  const rate = baseRaceMinutesPerSecond() * speedMultiplier;
  const realSeconds = raceMaxElapsed / rate;
  const what = raceType === 'circuit' ? 'lap' : 'course';
  const fastest = grades.length ? Math.max(...grades.map(g => g.spd)) : 0;
  const unitKm = raceType === 'circuit' ? lapLength : raceType === 'outback' ? 2 * lapLength : lapLength;
  const perUnit = fastest ? (unitKm * 60 / fastest) / rate : 0;
  el.textContent = grades.length
    ? `Whole race plays in ${realSeconds >= 90 ? Math.round(realSeconds / 60) + ' min' : Math.round(realSeconds) + ' s'} · fastest ${what} ≈ ${perUnit.toFixed(perUnit < 10 ? 1 : 0)} s`
    : '';
}

function updatePlayButton() {
  const btn = document.getElementById('playBtn');
  btn.innerHTML = raceRunning ? ICON_PAUSE : ICON_PLAY;
  btn.setAttribute('aria-label', raceRunning ? 'Pause' : 'Play');
  document.getElementById('appbar-race').classList.toggle('running', raceRunning);
}

function togglePlay() {
  if (raceRunning) pauseRace(); else playRace();
}

function playRace() {
  if (!grades.length) {
    alert('Please configure grades first by changing race settings.');
    updateCourseSetup();
    return;
  }
  if (raceRunning) return;
  raceRunning = true;
  lastTickTime = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(raceFrame);
  updatePlayButton();
}

function pauseRace() {
  raceRunning = false;
  cancelAnimationFrame(rafId);
  rafId = null;
  updatePlayButton();
}

function resetRace() {
  pauseRace();
  raceElapsed = 0;
  catches = [];
  catchesProcessed.clear();
  snapshotCache.clear();
  snapshotQueue.length = 0;
  catchEvents.forEach(ev => { ev.snapshot = null; });
  lastCatchTableSig = null;
  finishFlagShown = false;
  finishingGradeName = '';
  document.getElementById('finish-flag').style.display = 'none';

  grades.forEach(g => {
    g.position = 0;
    g.finished = false;
    g.finishTime = null;
    g.finishClock = null;
    g.currentLap = 0;
    g.direction = 1;
  });

  updateRaceToTime(0);

  document.getElementById("toasts").innerHTML = "";
  setSliderValue(0);
  refreshRaceViews();
}

// One animation frame, in step with the display's refresh rate.
function raceFrame(now) {
  if (!raceRunning) return;
  raceStep(now);
  if (raceRunning) rafId = requestAnimationFrame(raceFrame);
}

function raceStep(now = performance.now()) {
  // Advance by real elapsed time; cap the step so a background tab doesn't jump ahead.
  const dt = Math.min(Math.max(now - lastTickTime, 0), 100);
  lastTickTime = now;
  raceElapsed += baseRaceMinutesPerSecond() * (dt / 1000) * speedMultiplier;
  const ended = raceElapsed >= raceMaxElapsed;
  if (ended) {
    raceElapsed = raceMaxElapsed;
    pauseRace();
  }

  updateRaceToTime(raceElapsed);
  setSliderValue(Math.floor(raceElapsed * 100));

  // The track and clock redraw every frame; the tables a few times a second.
  updateClockLabels();
  drawRace();
  if (ended || now - lastPanelUpdate > 200) {
    lastPanelUpdate = now;
    updateFinishersDisplay();
    updateCatchTable();
    updateRaceSummary();
    drawStagingArea();
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeDialog(); return; }
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) && !(tag === 'INPUT' && e.target.type === 'range')) return;
  if (document.getElementById('imageModal').classList.contains('active') || document.getElementById('dialog').classList.contains('active')) return;
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && e.target.id !== 'raceSlider' && !(e.target.type === 'range')) { e.preventDefault(); scrubBy(e.shiftKey ? 5 : 1); }
  else if (e.key === 'ArrowLeft' && e.target.id !== 'raceSlider' && !(e.target.type === 'range')) { e.preventDefault(); scrubBy(e.shiftKey ? -5 : -1); }
});

// ---------- Snapshots & modal ----------

// Render the course as it was at `clockTime` on an off-screen canvas.
function captureRaceSnapshot(clockTime) {
  const scale = 1.5;
  let snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = Math.round(CW * scale);
  snapshotCanvas.height = Math.round(CH * scale);
  let ctx = snapshotCanvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // A hair before the catch so a grade finishing at that instant is still drawn.
  const t = clockTime - 1e-6;
  const saved = grades.map(g => ({
    position: g.position, finished: g.finished, finishTime: g.finishTime,
    finishClock: g.finishClock, currentLap: g.currentLap, neutralised: g.neutralised, curSpd: g.curSpd
  }));
  grades.forEach(g => setGradeStateAt(g, t));

  drawRaceOn(ctx, CW, CH, t, false);

  // Time stamp in the corner of the snapshot.
  ctx.save();
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.fillStyle = cv.text;
  ctx.textAlign = 'right';
  ctx.fillText(toClock(clockTime), CW - 16, CH - 14);
  ctx.restore();

  grades.forEach((g, i) => Object.assign(g, saved[i]));

  return snapshotCanvas.toDataURL();
}

// Snapshots are rendered between frames so a catch never stalls the animation.
function queueSnapshot(ev) {
  if (snapshotQueue.includes(ev)) return;
  snapshotQueue.push(ev);
  if (!snapshotTimer) snapshotTimer = setTimeout(processSnapshotQueue, 0);
}

function processSnapshotQueue() {
  snapshotTimer = null;
  const ev = snapshotQueue.shift();
  if (!ev) return;
  if (catchEvents.includes(ev) && !snapshotCache.has(ev.key)) {
    snapshotCache.set(ev.key, captureRaceSnapshot(ev.catchTime));
    ev.snapshot = snapshotCache.get(ev.key);
    lastCatchTableSig = null;
    updateCatchTable();
  }
  if (snapshotQueue.length) snapshotTimer = setTimeout(processSnapshotQueue, 16);
}

function openCatchModal(catchIndex) {
  const catchData = catches[catchIndex];
  if (!catchData) return;
  openModal(catchData);
}

function openModal(catchData) {
  const c1 = escapeHtml(catchData.c1);
  const c2 = escapeHtml(catchData.c2);
  document.getElementById('modalTitle').textContent = `Catch: ${catchData.c1} overtakes ${catchData.c2}`;

  let distanceInfo = raceType === 'circuit' ?
    `<div class="modal-info-row"><strong>${c1} position</strong><span>Lap ${catchData.c1Lap}, ${catchData.c1LapDist.toFixed(2)} km into lap</span></div>
     <div class="modal-info-row"><strong>${c2} position</strong><span>Lap ${catchData.c2Lap}, ${catchData.c2LapDist.toFixed(2)} km into lap</span></div>` :
    `<div class="modal-info-row"><strong>${c1} position</strong><span>${catchData.c1Distance.toFixed(2)} km from start</span></div>
     <div class="modal-info-row"><strong>${c2} position</strong><span>${catchData.c2Distance.toFixed(2)} km from start</span></div>`;

  let infoHTML = `
    <div class="modal-info-row"><strong>Catcher</strong><span>Grade ${c1}</span></div>
    <div class="modal-info-row"><strong>Caught</strong><span>Grade ${c2}</span></div>
    <div class="modal-info-row"><strong>Time</strong><span class="mono">${catchData.time}</span></div>
    ${distanceInfo}
  `;
  document.getElementById('modalInfo').innerHTML = infoHTML;

  document.getElementById('modalImage').src = catchData.snapshot || '';

  let legendHTML = `
    <div class="modal-legend-title">Grade indicators</div>
    <div class="modal-legend-item">
      ${gradeDot(catchData.c1, catchData.c1Color)}
      <span><strong>Grade ${c1}</strong> (catcher) – faster grade overtaking</span>
    </div>
    <div class="modal-legend-item">
      ${gradeDot(catchData.c2, catchData.c2Color)}
      <span><strong>Grade ${c2}</strong> (caught) – being overtaken at this position</span>
    </div>
    <div class="modal-note">
      Both grades overlap at the catch point on the ${raceType === 'circuit' ? 'circuit' : 'course'}.
    </div>
  `;
  document.getElementById('modalLegend').innerHTML = legendHTML;

  document.getElementById('imageModal').classList.add('active');
}

function closeModal() {
  document.getElementById('imageModal').classList.remove('active');
}

// ---------- Track rendering ----------

function setupCanvas() {
  const canvas = document.getElementById("raceCanvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (dpr !== canvasDpr || canvas.width !== Math.round(CW * dpr)) {
    canvasDpr = dpr;
    canvas.width = Math.round(CW * dpr);
    canvas.height = Math.round(CH * dpr);
  }
}

function drawRace() {
  let canvas = document.getElementById("raceCanvas");
  let ctx = canvas.getContext("2d");
  ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
  const shown = canvas.clientWidth || CW;
  markerScale = Math.max(1, Math.min(2.2, (CW / shown) * 0.75));
  drawRaceOn(ctx, CW, CH, raceStartMinutes + raceElapsed, true);
  markerScale = 1;
}

// withOverlays = false draws the canvas only (used for catch snapshots).
function drawRaceOn(ctx, W, H, clockTime, withOverlays) {
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H);

  if (course) {
    drawMapCourse(ctx, W, H, clockTime, withOverlays);
  } else if (raceType === 'circuit') {
    drawCircuitRace(ctx, W, H, clockTime, withOverlays);
  } else if (raceType === 'point') {
    drawPointToPointRace(ctx, W, H, clockTime, withOverlays);
  } else if (raceType === 'outback') {
    drawOutAndBackRace(ctx, W, H, clockTime, withOverlays);
  }
}

function drawBackground(ctx, W, H) {
  ctx.save();
  ctx.fillStyle = cv.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = cv.grid;
  for (let x = 20; x < W; x += 24) {
    for (let y = 20; y < H; y += 24) {
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }
  ctx.restore();
}

// Stroke a road along the current path: edge, asphalt and dashed centre line.
function strokeRoad(ctx, tracePath, width = 26) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePath(); ctx.strokeStyle = cv.edge; ctx.lineWidth = width + 6; ctx.stroke();
  tracePath(); ctx.strokeStyle = cv.road; ctx.lineWidth = width; ctx.stroke();
  tracePath(); ctx.strokeStyle = cv.lane; ctx.globalAlpha = .55; ctx.lineWidth = 1.5; ctx.setLineDash([10, 12]); ctx.stroke();
  ctx.restore();
}

// Chequered line across the road. Vertical line at x from y1 to y2.
function drawChecker(ctx, x, y1, y2, size = 4) {
  ctx.save();
  const rows = Math.ceil((y2 - y1) / size);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x - size + c * size, y1 + r * size, size, Math.min(size, y2 - (y1 + r * size)));
    }
  }
  ctx.restore();
}

function canvasLabel(ctx, text, x, y, color, align = 'center', weight = 700, size = 11) {
  ctx.save();
  ctx.font = `${weight} ${size * Math.min(markerScale, 1.6)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function niceStep(total, target = 6) {
  const raw = total / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

function formatKm(v) {
  return `${Math.round(v * 100) / 100} km`;
}

// Convert canvas coordinates to coordinates in the canvas's positioned parent,
// allowing for the canvas's position and any CSS scaling.
function canvasToOverlay(x, y) {
  let canvas = document.getElementById("raceCanvas");
  let sx = canvas.clientWidth ? canvas.clientWidth / CW : 1;
  let sy = canvas.clientHeight ? canvas.clientHeight / CH : 1;
  return { left: canvas.offsetLeft + x * sx, top: canvas.offsetTop + y * sy };
}

function drawCircuitRace(ctx, W, H, clockTime, withOverlays) {
  const padX = 64, top = 84, bottom = 70;
  let w = W - padX * 2, h = H - top - bottom, radius = 78;
  let perimeter = 2*(w-2*radius+h-2*radius)+2*Math.PI*radius;

  strokeRoad(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(padX + radius, top);
    ctx.lineTo(padX + w - radius, top); ctx.arcTo(padX + w, top, padX + w, top + radius, radius);
    ctx.lineTo(padX + w, top + h - radius); ctx.arcTo(padX + w, top + h, padX + w - radius, top + h, radius);
    ctx.lineTo(padX + radius, top + h); ctx.arcTo(padX, top + h, padX, top + h - radius, radius);
    ctx.lineTo(padX, top + radius); ctx.arcTo(padX, top, padX + radius, top, radius);
    ctx.closePath();
  });

  // Start / finish line
  const lineX = padX + w / 2;
  drawChecker(ctx, lineX + 4, top - 16, top + 16);
  canvasLabel(ctx, 'START / FINISH', lineX, top - 30, cv.finish, 'center', 800, 10.5);

  // Direction of travel
  ctx.save();
  ctx.strokeStyle = cv.text; ctx.globalAlpha = .6; ctx.lineWidth = 2; ctx.lineCap = 'round';
  // Riders leave the line to the left when anticlockwise, to the right when clockwise.
  const sgn = directionByType.circuit === 'clockwise' ? 1 : -1;
  const ax = lineX + sgn * 70 * Math.min(markerScale, 1.6), ay = top - 30;
  ctx.beginPath(); ctx.moveTo(ax - sgn * 22, ay); ctx.lineTo(ax, ay); ctx.moveTo(ax - sgn * 6, ay - 5); ctx.lineTo(ax, ay); ctx.lineTo(ax - sgn * 6, ay + 5); ctx.stroke();
  ctx.restore();

  // Course info in the infield
  canvasLabel(ctx, `${formatKm(lapLength)} lap`, padX + w / 2, top + h / 2 - 10, cv.text, 'center', 700, 15);
  canvasLabel(ctx, raceName, padX + w / 2, top + h / 2 + 14, cv.text, 'center', 500, 12);

  if (withOverlays && finishFlagShown) {
    let flagEl = document.getElementById('finish-flag');
    let p = canvasToOverlay(lineX, top - 62);
    flagEl.style.left = `${p.left}px`;
    flagEl.style.top = `${p.top}px`;
  }

  let gradePositions = [];

  // Canvas position of a distance along the circuit.
  const xyAt = position => {
      let lapsDone = Math.floor(position/lapLength);
      let lapDistance = position - lapsDone*lapLength;
      let progress = lapDistance/lapLength;

      const topStraight = w - 2 * radius;
      const rightStraight = h - 2 * radius;
      const bottomStraight = w - 2 * radius;
      const leftStraight = h - 2 * radius;
      const corner = Math.PI * radius / 2;

      const d1 = topStraight / 2;
      const d2 = d1 + corner;
      const d3 = d2 + leftStraight;
      const d4 = d3 + corner;
      const d5 = d4 + bottomStraight;
      const d6 = d5 + corner;
      const d7 = d6 + rightStraight;
      const d8 = d7 + corner;

      let distOnCanvas = progress * perimeter;

      let x, y;

      if (distOnCanvas < d1) {
          x = (w / 2) - distOnCanvas;
          y = 0;
      } else if (distOnCanvas < d2) {
          const distInSegment = distOnCanvas - d1;
          const angle = -Math.PI / 2 - (distInSegment / radius);
          x = radius + Math.cos(angle) * radius;
          y = radius + Math.sin(angle) * radius;
      } else if (distOnCanvas < d3) {
          const distInSegment = distOnCanvas - d2;
          x = 0;
          y = radius + distInSegment;
      } else if (distOnCanvas < d4) {
          const distInSegment = distOnCanvas - d3;
          const angle = Math.PI - (distInSegment / radius);
          x = radius + Math.cos(angle) * radius;
          y = (h - radius) + Math.sin(angle) * radius;
      } else if (distOnCanvas < d5) {
          const distInSegment = distOnCanvas - d4;
          x = radius + distInSegment;
          y = h;
      } else if (distOnCanvas < d6) {
          const distInSegment = distOnCanvas - d5;
          const angle = Math.PI / 2 - (distInSegment / radius);
          x = (w - radius) + Math.cos(angle) * radius;
          y = (h - radius) + Math.sin(angle) * radius;
      } else if (distOnCanvas < d7) {
          const distInSegment = distOnCanvas - d6;
          x = w;
          y = (h - radius) - distInSegment;
      } else if (distOnCanvas < d8) {
          const distInSegment = distOnCanvas - d7;
          const angle = (distInSegment / radius);
          x = (w - radius) + Math.cos(angle) * radius;
          y = radius - Math.sin(angle) * radius;
      } else {
          const distInSegment = distOnCanvas - d8;
          x = (w - radius) - distInSegment;
          y = 0;
      }

      x += padX;
      y += top;
      // Clockwise is the same lap mirrored about the start/finish line.
      if (directionByType.circuit === 'clockwise') x = 2 * lineX - x;
      return { x, y };
  };

  for (let g of grades) {
    if (g.finished || g.neutralised || clockTime < g.start) continue;
    const lapsDone = Math.floor(g.position / lapLength);
    drawTrail(ctx, g, xyAt, lapLength);
    const { x, y } = xyAt(g.position);
    drawGradeMarker(ctx, x, y, g);
    gradePositions.push({grade: g, x: x, y: y, lapsDone: lapsDone});
  }

  if (withOverlays) drawLapBadges(document.getElementById("lap-counters"), gradePositions, true);
}

function drawDistanceTicks(ctx, x0, x1, y, total, labelAbove = true) {
  const step = niceStep(total);
  ctx.save();
  ctx.strokeStyle = cv.text;
  ctx.globalAlpha = .5;
  ctx.lineWidth = 1;
  for (let d = step; d < total - step * 0.25; d += step) {
    const x = x0 + (d / total) * (x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x, y + (labelAbove ? -19 : 19));
    ctx.lineTo(x, y + (labelAbove ? -23 : 23));
    ctx.stroke();
    canvasLabel(ctx, formatKm(d), x, y + (labelAbove ? -31 : 31), cv.text, 'center', 600, 10);
  }
  ctx.restore();
}

function drawPointToPointRace(ctx, W, H, clockTime, withOverlays) {
  let pad = 70, w = W - pad * 2;
  let yPos = H / 2 + 10;

  strokeRoad(ctx, () => { ctx.beginPath(); ctx.moveTo(pad, yPos); ctx.lineTo(pad + w, yPos); });

  // Start line
  ctx.save();
  ctx.fillStyle = cv.accent;
  ctx.fillRect(pad - 2, yPos - 17, 4, 34);
  ctx.restore();
  canvasLabel(ctx, 'START', pad, yPos - 54, cv.accent, 'center', 800, 11);

  // Finish line
  drawChecker(ctx, pad + w + 4, yPos - 17, yPos + 17);
  canvasLabel(ctx, 'FINISH', pad + w, yPos - 54, cv.finish, 'center', 800, 11);
  canvasLabel(ctx, formatKm(lapLength), pad + w, yPos + 36, cv.text, 'center', 700, 11);

  drawDistanceTicks(ctx, pad, pad + w, yPos, lapLength, true);

  let gradePositions = [];

  const xyAt = position => ({ x: pad + (position / lapLength) * w, y: yPos });

  for (let g of grades) {
    if (g.finished || g.neutralised || clockTime < g.start) continue;

    drawTrail(ctx, g, xyAt, lapLength);
    const { x, y } = xyAt(g.position);

    drawGradeMarker(ctx, x, y, g);
    gradePositions.push({grade: g, x: x, y: y, lapsDone: 0});
  }

  if (withOverlays) drawLapBadges(document.getElementById("lap-counters"), gradePositions, false);
}

function drawOutAndBackRace(ctx, W, H, clockTime, withOverlays) {
  let pad = 70, w = W - pad * 2;
  let yMid = H / 2 + 10;
  let trackSeparation = 170;
  let yTop = yMid - trackSeparation/2;
  let yBottom = yMid + trackSeparation/2;
  let turnRadius = trackSeparation/2;
  const cx = pad + w - turnRadius;

  strokeRoad(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(pad, yTop);
    ctx.lineTo(cx, yTop);
    ctx.arc(cx, yMid, turnRadius, -Math.PI/2, Math.PI/2);
    ctx.lineTo(pad, yBottom);
  });

  // Start / finish across both carriageways
  drawChecker(ctx, pad + 4, yTop - 17, yTop + 17);
  drawChecker(ctx, pad + 4, yBottom - 17, yBottom + 17);
  canvasLabel(ctx, 'START / FINISH', pad, yTop - 54, cv.finish, 'left', 800, 11);
  // Clockwise: out along the top, back along the bottom. Anticlockwise: the reverse.
  const flip = directionByType.outback === 'anticlockwise';
  const yOut = flip ? yBottom : yTop, yBack = flip ? yTop : yBottom;
  canvasLabel(ctx, 'OUT →', pad + 30, yOut + (flip ? -30 : 30), cv.text, 'left', 700, 10);
  canvasLabel(ctx, '← BACK', pad + 30, yBack + (flip ? 30 : -30), cv.text, 'left', 700, 10);

  // Turnaround at the apex of the bend
  ctx.save();
  ctx.fillStyle = cv.turn;
  ctx.beginPath();
  const apexX = pad + w;
  ctx.moveTo(apexX + 22, yMid - 8); ctx.lineTo(apexX + 22, yMid + 8); ctx.lineTo(apexX + 34, yMid); ctx.closePath();
  ctx.fill();
  ctx.restore();
  canvasLabel(ctx, 'TURN', cx - 10, yMid - 9, cv.turn, 'center', 800, 11);
  canvasLabel(ctx, formatKm(lapLength), cx - 10, yMid + 9, cv.text, 'center', 600, 10.5);

  const straightDist = w - turnRadius;
  const turnDist = Math.PI * turnRadius;
  const routeLength = 2 * straightDist + turnDist;

  // Distance ticks on the out leg (scaled to the shared route mapping)
  ctx.save();
  const step = niceStep(lapLength);
  for (let d = step; d < lapLength - step * 0.25; d += step) {
    const s = (d / (2 * lapLength)) * routeLength;
    if (s > straightDist) break;
    const x = pad + s;
    ctx.strokeStyle = cv.text; ctx.globalAlpha = .5; ctx.lineWidth = 1;
    const side = -1; // labels above the out leg (inside the course when it runs along the bottom)
    ctx.beginPath(); ctx.moveTo(x, yOut + side * 19); ctx.lineTo(x, yOut + side * 23); ctx.stroke();
    ctx.globalAlpha = 1;
    canvasLabel(ctx, formatKm(d), x, yOut + side * 31, cv.text, 'center', 600, 10);
  }
  ctx.restore();

  let gradePositions = [];

  // Map distance uniformly along the drawn route (out straight, turn, back straight),
  // so both legs are drawn at the same scale and the turnaround is the apex of the turn.
  const xyAt = position => {
    let x, y;
    let s = Math.min(1, position / (2 * lapLength)) * routeLength;

    if (s <= straightDist) {
      x = pad + s;
      y = yTop;
    } else if (s <= straightDist + turnDist) {
      let angle = -Math.PI/2 + (s - straightDist) / turnRadius;
      x = cx + Math.cos(angle) * turnRadius;
      y = yMid + Math.sin(angle) * turnRadius;
    } else {
      x = pad + straightDist - (s - straightDist - turnDist);
      y = yBottom;
    }
    return { x, y: flip ? 2 * yMid - y : y };
  };

  for (let g of grades) {
    if (g.finished || g.neutralised || clockTime < g.start) continue;

    drawTrail(ctx, g, xyAt, 2 * lapLength);
    const { x, y } = xyAt(g.position);

    drawGradeMarker(ctx, x, y, g);
    gradePositions.push({grade: g, x: x, y: y, lapsDone: 0});
  }

  if (withOverlays) drawLapBadges(document.getElementById("lap-counters"), gradePositions, false);
}

// A short fading trail behind a marker, showing which way and how fast it is moving.
function drawTrail(ctx, g, xyAt, courseKm) {
  if (!(g.position > 0)) return;
  const r = 16 * markerScale;
  const step = courseKm * 0.006;
  ctx.save();
  ctx.fillStyle = g.color;
  for (let k = 6; k >= 1; k--) {
    const p = g.position - k * step;
    if (p < 0) continue;
    const { x, y } = xyAt(p);
    ctx.globalAlpha = 0.32 * (1 - k / 7);
    ctx.beginPath();
    ctx.arc(x, y, r * (1 - k / 10), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGradeMarker(ctx, x, y, g) {
  const r = 16 * markerScale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI*2);
  ctx.fillStyle = g.color;
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2.5 * markerScale;
  ctx.strokeStyle = cv.ring;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r - 3 * markerScale, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.stroke();
  ctx.fillStyle = textColorFor(g.color);
  let size = 13 * markerScale;
  ctx.font = `800 ${size}px Inter, system-ui, sans-serif`;
  while (size > 8 * markerScale && ctx.measureText(g.name).width > r * 2 - 7) {
    size -= 1;
    ctx.font = `800 ${size}px Inter, system-ui, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(g.name, x, y + 0.5);
  ctx.restore();
}

function drawLapBadges(lapDom, gradePositions, showLaps) {
  const keep = new Set();
  gradePositions.forEach(gp => {
    let badgeY = gp.y + 24 * markerScale;
    // Near the bottom edge, put the badge above the marker so it is not clipped.
    if (badgeY > CH - 30 * markerScale) badgeY = gp.y - 46 * markerScale;

    let overlap = true;
    let attempts = 0;
    while (overlap && attempts < 10) {
      overlap = false;
      for (let other of gradePositions) {
        if (other === gp) continue;
        let otherBadgeY = other.y + 24 * markerScale;
        if (Math.abs(gp.x - other.x) < 70 * markerScale && Math.abs(badgeY - otherBadgeY) < 22 * markerScale) {
          overlap = true;
          badgeY += 22 * markerScale;
          break;
        }
      }
      attempts++;
    }

    // Reuse each grade's badge element and move it with a transform (no layout work per frame).
    const key = String(gp.grade.idx);
    keep.add(key);
    let badge = lapDom.querySelector(`.lap-badge[data-g="${key}"]`);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = "lap-badge";
      badge.dataset.g = key;
      lapDom.appendChild(badge);
    }
    let speedLabel = `${fmtSpd(gp.grade.curSpd ?? gp.grade.spd)} km/h`;
    let html;
    if (showLaps && gp.grade.laps > 1) {
      let lapLabel = `Lap ${Math.min(gp.grade.laps,gp.lapsDone+1)}/${gp.grade.laps}`;
      html = `<span class="lap-text">${lapLabel}</span><span class="speed-text">${speedLabel}</span>`;
    } else {
      html = `<span class="speed-text">${speedLabel}</span>`;
    }
    if (badge._html !== html) { badge.innerHTML = html; badge._html = html; }
    let p = canvasToOverlay(gp.x, badgeY);
    badge.style.transform = `translate3d(${p.left.toFixed(1)}px, ${p.top.toFixed(1)}px, 0) translateX(-50%)`;
  });
  lapDom.querySelectorAll('.lap-badge').forEach(el => { if (!keep.has(el.dataset.g)) el.remove(); });
}

window.addEventListener('resize', () => { setupCanvas(); drawRace(); });

// ---------- Notifications ----------

function showToast(html) {
  const box = document.getElementById("toasts");
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = html;
  box.prepend(toast);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

function warnCatch(ev) {
  showToast(`<span class="t-ico">${ICON_FLAG}</span>
    <span>${gradeDot(ev.c1, ev.c1Color, 'sm')}</span>
    <span><strong>${escapeHtml(ev.c1)}</strong> ${ev.lapsUp > 0 ? 'lapped' : 'caught'} <strong>${escapeHtml(ev.c2)}</strong> at <span class="mono">${ev.time}</span></span>`);
}

// ---------- Tables ----------

function updateCatchTable() {
  // Catches only change when one is added or removed, so skip identical rebuilds
  // (each rebuild re-decodes every snapshot image).
  const sig = `${raceType}|${catches.map(c => c.key + (c.snapshot ? '+' : '')).join(',')}`;
  if (sig === lastCatchTableSig) return;
  lastCatchTableSig = sig;

  document.getElementById('catch-count').textContent = catches.length;
  let tbody = document.getElementById("catchTable").querySelector("tbody");

  if (catches.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No catches yet. They will appear here as the race unfolds.</td></tr>`;
    return;
  }

  tbody.innerHTML = catches.map((c, index) => {
    const c1 = escapeHtml(c.c1), c2 = escapeHtml(c.c2);
    let detailsHTML = raceType === 'circuit' ?
      `<div class="catch-details">
        <strong>${c1}:</strong> Lap ${c.c1Lap}, ${c.c1LapDist.toFixed(2)} km into lap<br>
        <strong>${c2}:</strong> Lap ${c.c2Lap}, ${c.c2LapDist.toFixed(2)} km into lap
      </div>` :
      `<div class="catch-details">
        <strong>${c1}:</strong> ${c.c1Distance.toFixed(2)} km from start<br>
        <strong>${c2}:</strong> ${c.c2Distance.toFixed(2)} km from start
      </div>`;

    let snapshotHTML = c.snapshot ?
      `<img src="${c.snapshot}" class="catch-snapshot" alt="Track position when ${c1} caught ${c2}" onclick="openCatchModal(${index})">` :
      '<span class="muted">No snapshot</span>';

    return `<tr>
      <td>${gradeChip(c.c1, c.c1Color)}</td>
      <td>${gradeChip(c.c2, c.c2Color)}</td>
      <td><span class="mono">${c.time}</span>${catchKindTag(c)}</td>
      <td>${detailsHTML}</td>
      <td>${snapshotHTML}</td>
    </tr>`;
  }).join('');
}

// Live standings table, including finish times.
// Live standings table, including finish times.
function updateFinishersDisplay() {
  let section = document.getElementById("finish-section");
  if (grades.length === 0) { section.innerHTML = ""; return; }
  const clock = raceStartMinutes + raceElapsed;
  const finishOrder = [...finishers].sort((a, b) => a.finishClock - b.finishClock);

  const rows = grades.map(g => {
    const tr = simResult.tracks[g.idx];
    const pct = Math.min(100, (g.position / g.totalDistance) * 100);
    let status;
    if (clock < g.start) {
      status = `<span class="pill wait">Starts ${toClock(g.start)}</span>`;
    } else if (g.neutralised) {
      status = `<span class="pill out">Neutralised ${toClock(g.neutralisedAt)}</span>`;
    } else if (g.finished) {
      status = `<span class="pill done">Finished · #${finishOrder.indexOf(g) + 1}</span>`;
    } else if (raceType === 'circuit') {
      status = `<span class="pill live">Lap ${Math.min(g.laps, g.currentLap + 1)}/${g.laps}</span>`;
    } else if (raceType === 'outback') {
      status = `<span class="pill live">${g.position <= lapLength ? 'Outbound' : 'Return leg'}</span>`;
    } else {
      status = `<span class="pill live">Racing</span>`;
    }
    const lapText = raceType === 'circuit'
      ? `${g.laps} lap${g.laps === 1 ? '' : 's'} · ${g.totalDistance.toFixed(1)} km`
      : `${g.totalDistance.toFixed(1)} km`;
    const speedHTML = (g.curSpd !== g.spd && !g.neutralised)
      ? `${fmtSpd(g.spd)} → <span class="speed-change">${fmtSpd(g.curSpd)}</span> km/h`
      : `${fmtSpd(g.spd)} km/h`;
    const rangeHTML = g.range > 0 ? ` <span class="muted">±${g.range}</span>` : '';
    let finishCell;
    if (g.finished) finishCell = `<strong class="mono">${g.finishTime}</strong>`;
    else if (tr.neutralisedAt !== null) finishCell = `<span class="muted">—</span>`;
    else finishCell = `<span class="mono muted">${toClock(tr.finishClock)}</span>`;
    return `<tr>
      <td>${gradeChip(g.name, g.color)}</td>
      <td class="mono">${toClock(g.start)}</td>
      <td class="mono">${speedHTML}${rangeHTML}</td>
      <td>${lapText}</td>
      <td><div class="progress-cell" style="--gc:${safeColor(g.color)}"><div class="bar" style="flex:1"><span style="width:${pct.toFixed(1)}%"></span></div><span class="pct mono">${Math.round(pct)}%</span></div></td>
      <td>${status}</td>
      <td>${finishCell}</td>
    </tr>`;
  }).join('');

  section.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Grade</th><th>Start</th><th>Speed</th><th>Distance</th><th style="min-width:160px">Progress</th><th>Status</th><th title="Finish time (projected time shown in grey)">Finish</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function updateRaceSummary() {
  const done = raceElapsed >= raceMaxElapsed;
  document.getElementById('summary-ready').classList.toggle('show', done);
  document.getElementById('summary-placeholder').style.display = done ? 'none' : 'flex';
  if (!done) {
    document.getElementById('summary-section').style.display = 'none';
    return;
  }

  document.getElementById('summary-section').style.display = 'block';

  populateSummaryTable();
}

function populateSummaryTable() {
  let tbody = document.getElementById('summaryTable').querySelector('tbody');

  // Catches are matched by grade position, not name, so duplicate names don't collide.
  const catchesMadeBy = g => catches.filter(c => c.c1Index === g.idx);
  const caughtByOf = g => catches.filter(c => c.c2Index === g.idx);
  const endOf = g => g.finished ? g.finishClock : g.neutralisedAt;

  // Headline figures
  const order = [...finishers].sort((a, b) => a.finishClock - b.finishClock);
  const outCount = grades.filter(g => g.neutralised).length;
  const stats = [
    ['Grades', grades.length],
    ['Catches', catches.length],
    ['First finisher', order.length ? `${escapeHtml(order[0].name)} · <span class="mono">${order[0].finishTime}</span>` : '—'],
    ['Last finish', order.length ? `<span class="mono">${order[order.length - 1].finishTime}</span>` : '—'],
    ['Race duration', formatDuration(raceMaxElapsed)]
  ];
  if (afterCatch === 'neutralise') stats.push(['Neutralised', outCount]);
  document.getElementById('summary-stats').innerHTML =
    stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  let sortedFinishers = grades.filter(g => g.finished || g.neutralised);

  sortedFinishers.sort((a, b) => {
    let valA, valB;

    switch(summaryTableSortColumn) {
      case 0: valA = a.name; valB = b.name; break;
      case 1: valA = a.start; valB = b.start; break;
      case 2: valA = endOf(a); valB = endOf(b); break;
      case 3: valA = endOf(a) - a.start; valB = endOf(b) - b.start; break;
      case 4: valA = a.spd; valB = b.spd; break;
      case 5: valA = catchesMadeBy(a).length; valB = catchesMadeBy(b).length; break;
      case 6: valA = caughtByOf(a).length; valB = caughtByOf(b).length; break;
      default: valA = a.name; valB = b.name;
    }

    if (typeof valA === 'string') {
      return summaryTableSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return summaryTableSortDirection === 'asc' ? valA - valB : valB - valA;
    }
  });

  tbody.innerHTML = sortedFinishers.map(g => {
    let catchesMade = catchesMadeBy(g).length;
    let caughtByNames = [...new Set(caughtByOf(g).map(c => c.c1))];
    let caughtByList = caughtByNames.map(escapeHtml).join(', ') || '<span class="muted">None</span>';
    const finishCell = g.finished
      ? `<span class="mono">${g.finishTime}</span>`
      : `<span class="pill out">Neutralised ${toClock(g.neutralisedAt)}</span>`;
    const avg = g.finished ? (g.totalDistance / ((g.finishClock - g.start) / 60)) : null;

    return `<tr>
      <td>${gradeChip(g.name, g.color)}</td>
      <td class="mono">${toClock(g.start)}</td>
      <td>${finishCell}</td>
      <td class="mono">${g.finished ? formatDuration(g.finishClock - g.start) : '—'}</td>
      <td class="mono">${avg !== null ? fmtSpd(avg) + ' km/h' : '—'}</td>
      <td class="mono">${catchesMade}</td>
      <td>${caughtByList}</td>
    </tr>`;
  }).join('');
}

function sortSummaryTable(columnIndex) {
  if (summaryTableSortColumn === columnIndex) {
    summaryTableSortDirection = summaryTableSortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    summaryTableSortColumn = columnIndex;
    summaryTableSortDirection = 'asc';
  }

  let headers = document.querySelectorAll('#summaryTable th');
  headers.forEach((th, i) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (i === columnIndex) {
      th.classList.add(summaryTableSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  populateSummaryTable();
}

// ---------- Save / load ----------

function saveRace() {
  let data = buildRaceData();
  let blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  let a = document.createElement("a");
  a.href = URL.createObjectURL(blob);

  let defaultName = `${raceName.replace(/\s+/g, '_')}_race_data.json`;
  let fileName = prompt('Enter filename:', defaultName);
  if (!fileName) return;
  if (!fileName.endsWith('.json')) fileName += '.json';
  a.download = fileName;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function loadRace() {
  document.getElementById('loadFileInput').click();
}

function handleRaceLoad(event) {
  let file = event.target.files[0];
  if (!file) return;
  let reader = new FileReader();
  reader.onload = function(e) {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      alert('This file is not a valid race file.');
      return;
    }
    try {
      applyRaceData(data);
    } catch (err) {
      alert(err.message.replace('race', 'race file'));
    }
  };
  reader.readAsText(file);

  event.target.value = '';
}


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
    version: '11.4'
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
  showToast(`<span class="t-ico">✓</span><span>Speeds updated for <strong>${n}</strong> grade${n === 1 ? '' : 's'}</span>`);
}

// ---------- Course map (GPX) ----------

function loadGpx() {
  document.getElementById('gpxFileInput').click();
}

function handleGpxFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const built = SimCore.buildCourse(SimCore.parseGpx(String(e.target.result)));
      if (!built.name) built.name = file.name.replace(/\.gpx$/i, '');
      course = built;
      updateCourseSetup();
      const diff = Math.abs(course.lengthKm - lapLength);
      showToast(`<span class="t-ico">✓</span><span>Course map <strong>${escapeHtml(course.name)}</strong> loaded (${course.lengthKm.toFixed(2)} km)${diff > 0.05 ? '. The race still uses your set length.' : ''}</span>`);
    } catch (err) {
      alert(`Could not read this GPX file: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function clearCourse() {
  course = null;
  updateCourseSetup();
}

function useCourseLength() {
  if (!course) return;
  document.getElementById('lap-length').value = Math.round(course.lengthKm * 100) / 100;
  handleLapLengthChange();
}

function handleHillToggle() {
  hillEffect = document.getElementById('hill-effect').checked;
  updateCourseSetup();
}

function updateCourseUI() {
  const has = !!course;
  document.getElementById('course-name').textContent = has ? course.name || 'GPX course' : 'Standard shape';
  document.getElementById('course-clear').style.display = has ? '' : 'none';
  const hill = document.getElementById('hill-row');
  hill.style.display = has && course.hasElevation ? '' : 'none';
  document.getElementById('hill-effect').checked = hillEffect;
  const hint = document.getElementById('course-hint');
  if (!has) { hint.innerHTML = 'Load a GPX route (e.g. exported from Strava or Garmin) to draw the real course.'; return; }
  const what = raceType === 'circuit' ? 'lap length' : raceType === 'outback' ? 'distance to turn' : 'race length';
  const off = Math.abs(course.lengthKm - lapLength) > 0.05;
  let txt = `Map ${course.lengthKm.toFixed(2)} km${course.hasElevation ? ' with elevation' : ''}.`;
  if (off) txt += ` Your ${what} is ${lapLength} km; the map is stretched to fit. <button class="link-btn" onclick="useCourseLength()">Use ${course.lengthKm.toFixed(2)} km</button>`;
  if (raceType === 'circuit' && !course.closed) txt += ' The route doesn’t return to its start, so it is drawn closed.';
  if (raceType !== 'circuit' && course.closed) txt += ` <strong>This map is a loop;</strong> ${raceType === 'outback' ? 'out-and-back' : 'point-to-point'} races need a one-way route (start to ${raceType === 'outback' ? 'turn' : 'finish'}).`;
  if (course.hasElevation && hillEffect) txt += ' Catch times are unchanged by hills; their positions move.';
  hint.innerHTML = txt;
}

// Canvas geometry for the map, cached per course/direction/canvas size.
let mapGeometryCache = null;

function mapGeometry(W, H) {
  const showProfile = course.hasElevation;
  const reverse = raceType === 'circuit' && (() => {
    const a = SimCore.signedArea(course.points.map(p => [p[0], -p[1]]));
    const isCw = a > 0;
    return (directionByType.circuit === 'clockwise') !== isCw;
  })();
  const key = `${course.points.length}|${course.lengthKm}|${W}|${H}|${reverse}|${showProfile}|${raceType}`;
  if (mapGeometryCache && mapGeometryCache.key === key && mapGeometryCache.course === course) return mapGeometryCache;

  let pts = course.points.map(p => [p[0], -p[1], p[2]]); // y down on screen
  if (reverse) pts = pts.slice().reverse();
  const left = 70, right = 70, top = 78, bottom = showProfile ? 118 : 64;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((W - left - right) / Math.max(1, maxX - minX), (H - top - bottom) / Math.max(1, maxY - minY));
  const ox = left + ((W - left - right) - (maxX - minX) * scale) / 2;
  const oy = top + ((H - top - bottom) - (maxY - minY) * scale) / 2;
  const P = pts.map(p => [ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale, p[2]]);
  if (raceType === 'circuit') P.push(P[0]); // close the loop
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cy = P.reduce((s, p) => s + p[1], 0) / P.length;
  mapGeometryCache = { key, course, P, cum, total: cum[cum.length - 1], cx, cy, showProfile, reverse };
  return mapGeometryCache;
}

// Point and unit tangent at a fraction (0–1) along the drawn path.
function pathAt(geo, f) {
  const d = Math.max(0, Math.min(1, f)) * geo.total;
  let lo = 0, hi = geo.cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (geo.cum[mid] <= d) lo = mid; else hi = mid; }
  const a = geo.P[lo], b = geo.P[hi];
  const len = geo.cum[hi] - geo.cum[lo] || 1;
  const t = (d - geo.cum[lo]) / len;
  const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tx, ty, ele: a[2] + (b[2] - a[2]) * t };
}

function drawMapCourse(ctx, W, H, clockTime, withOverlays) {
  const geo = mapGeometry(W, H);
  const P = geo.P;

  strokeRoad(ctx, () => {
    ctx.beginPath();
    P.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    if (raceType === 'circuit') ctx.closePath();
  }, 20);

  // Outward normal (away from the course centre) at a point on the path
  const outward = q => {
    let nx = -q.ty, ny = q.tx;
    if ((q.x - geo.cx) * nx + (q.y - geo.cy) * ny < 0) { nx = -nx; ny = -ny; }
    return { nx, ny };
  };
  const checkerAt = q => {
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(Math.atan2(q.ty, q.tx));
    drawChecker(ctx, 4, -14, 14);
    ctx.restore();
  };

  const startQ = pathAt(geo, 0);
  const endQ = pathAt(geo, 1);
  const so = outward(startQ);
  // A label beside the road, aligned so it grows away from the course.
  const sideLabel = (q, o, text, color, dist = 30) => {
    const align = o.nx > 0.45 ? 'left' : o.nx < -0.45 ? 'right' : 'center';
    let x = q.x + o.nx * dist;
    const y = q.y + o.ny * dist;
    // Keep the label inside the canvas (labels are enlarged on small screens).
    ctx.save();
    ctx.font = `800 ${10.5 * Math.min(markerScale, 1.6)}px Inter, system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.restore();
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    const shift = Math.max(6 - left, 0) - Math.max(left + w - (W - 6), 0);
    x += shift;
    canvasLabel(ctx, text, x, y, color, align, 800, 10.5);
  };
  checkerAt(startQ);
  if (raceType === 'circuit' || raceType === 'outback') {
    sideLabel(startQ, so, 'START / FINISH', cv.finish);
  } else {
    sideLabel(startQ, so, 'START', cv.accent);
    checkerAt(endQ);
    sideLabel(endQ, outward(endQ), 'FINISH', cv.finish);
  }
  if (raceType === 'outback') {
    const eo = outward(endQ);
    ctx.save();
    ctx.fillStyle = cv.turn;
    ctx.beginPath(); ctx.arc(endQ.x, endQ.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    sideLabel(endQ, eo, `TURN · ${formatKm(lapLength)}`, cv.turn);
  }

  // Direction arrow just after the start
  const aq = pathAt(geo, 0.035);
  ctx.save();
  ctx.translate(aq.x - so.nx * 20, aq.y - so.ny * 20);
  ctx.rotate(Math.atan2(aq.ty, aq.tx));
  ctx.strokeStyle = cv.text; ctx.globalAlpha = .7; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.moveTo(4, -4); ctx.lineTo(9, 0); ctx.lineTo(4, 4); ctx.stroke();
  ctx.restore();

  // Distance markers along the course
  const unit = lapLength;
  const step = niceStep(unit);
  for (let d = step; d < unit - step * 0.25; d += step) {
    const q = pathAt(geo, d / unit);
    const o = outward(q);
    ctx.save();
    ctx.fillStyle = cv.text; ctx.globalAlpha = .6;
    ctx.beginPath(); ctx.arc(q.x + o.nx * 16, q.y + o.ny * 16, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    canvasLabel(ctx, formatKm(d), q.x + o.nx * 28, q.y + o.ny * 28, cv.text, 'center', 600, 9.5);
  }

  if (raceType === 'circuit') {
    canvasLabel(ctx, `${formatKm(lapLength)} lap`, geo.cx, geo.cy - 8, cv.text, 'center', 700, 13);
    canvasLabel(ctx, course.name || raceName, geo.cx, geo.cy + 12, cv.text, 'center', 500, 11);
  }

  if (withOverlays && finishFlagShown) {
    let flagEl = document.getElementById('finish-flag');
    let p = canvasToOverlay(startQ.x, startQ.y - 62);
    flagEl.style.left = `${p.left}px`;
    flagEl.style.top = `${p.top}px`;
  }

  // Position on the drawn path for a distance (km) along the race
  const xyAt = position => {
    let f, side = 0;
    if (raceType === 'circuit') {
      const lapsDone = Math.floor(position / lapLength + 1e-12);
      f = (position - lapsDone * lapLength) / lapLength;
    } else if (raceType === 'outback') {
      if (position <= lapLength) { f = position / lapLength; side = -1; }
      else { f = Math.max(0, (2 * lapLength - position) / lapLength); side = 1; }
    } else {
      f = position / lapLength;
    }
    const q = pathAt(geo, f);
    // Out and back legs ride on opposite sides of the road
    return { x: q.x - q.ty * 7 * side, y: q.y + q.tx * 7 * side };
  };

  let gradePositions = [];
  for (let g of grades) {
    if (g.finished || g.neutralised || clockTime < g.start) continue;
    drawTrail(ctx, g, xyAt, raceType === 'outback' ? 2 * lapLength : lapLength);
    const { x, y } = xyAt(g.position);
    drawGradeMarker(ctx, x, y, g);
    gradePositions.push({ grade: g, x, y, lapsDone: Math.floor(g.position / lapLength) });
  }

  if (geo.showProfile) drawElevationProfile(ctx, W, H, geo, clockTime);
  if (withOverlays) drawLapBadges(document.getElementById("lap-counters"), gradePositions, raceType === 'circuit');
}

function drawElevationProfile(ctx, W, H, geo, clockTime) {
  const x0 = 70, x1 = W - 70, y1 = H - 22, y0 = H - 82;
  const span = raceType === 'outback' ? 2 * lapLength : lapLength;
  const samples = 160;
  const eleAt = d => {
    let f = raceType === 'outback' ? (d <= lapLength ? d / lapLength : (2 * lapLength - d) / lapLength) : d / lapLength;
    return pathAt(geo, f).ele;
  };
  const vals = [];
  for (let i = 0; i <= samples; i++) vals.push(eleAt(span * i / samples));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const rng = Math.max(5, hi - lo);
  const X = d => x0 + (d / span) * (x1 - x0);
  const Y = e => y1 - ((e - lo) / rng) * (y1 - y0);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  vals.forEach((e, i) => ctx.lineTo(X(span * i / samples), Y(e)));
  ctx.lineTo(x1, y1);
  ctx.closePath();
  ctx.fillStyle = cv.edge; ctx.globalAlpha = .55; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  vals.forEach((e, i) => i ? ctx.lineTo(X(span * i / samples), Y(e)) : ctx.moveTo(X(0), Y(e)));
  ctx.strokeStyle = cv.text; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
  canvasLabel(ctx, `ELEVATION ${Math.round(lo)}–${Math.round(hi)} m${raceType === 'circuit' ? ' · one lap' : ''}`, x0, y0 - 8, cv.text, 'left', 700, 9.5);
  if (raceType === 'outback') canvasLabel(ctx, 'TURN', X(lapLength), y0 - 8, cv.turn, 'center', 700, 9.5);

  for (const g of grades) {
    if (g.finished || g.neutralised || clockTime < g.start) continue;
    const d = raceType === 'circuit' ? g.position - Math.floor(g.position / lapLength + 1e-12) * lapLength : g.position;
    const x = X(Math.min(span, d)), y = Y(eleAt(Math.min(span, d)));
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = g.color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = cv.ring; ctx.stroke();
    ctx.restore();
  }
}

// ---------- Planner: locks, deadline and fixed-gap laps ----------

function renderPlannerLocks() {
  const box = document.getElementById('plan-locks');
  if (!box) return;
  for (const i of [...plannerLocks]) if (!grades[i]) plannerLocks.delete(i);
  box.innerHTML = grades.map(g => `
    <button type="button" class="lock-chip ${plannerLocks.has(g.idx) ? 'on' : ''}" onclick="toggleLock(${g.idx})" aria-pressed="${plannerLocks.has(g.idx)}" title="Keep this grade's current start time">
      ${gradeDot(g.name, g.color, 'sm')}<span class="mono">${toClock(g.start)}</span><span class="lock-ico">${plannerLocks.has(g.idx) ? '🔒' : '🔓'}</span>
    </button>`).join('');
}

function toggleLock(i) {
  if (plannerLocks.has(i)) plannerLocks.delete(i); else plannerLocks.add(i);
  renderPlannerLocks();
}

// ---------- Start-up ----------

setupCanvas();
updateAfterCatchHint();
setupGradeInputs();
updateCourseSetup();
restoreStartupRace();
(function restoreTab() {
  let tab = null;
  try { tab = localStorage.getItem('crs-tab'); } catch (e) {}
  if (tab && document.getElementById(`tab-${tab}`)) showTab(tab);
})();
// Redraw once web fonts are ready so canvas labels use them.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawRace());

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
    const diff = gr.median - g.spd;
    sumSpeed += Math.abs(diff);
    const within = g.range > 0 ? Math.abs(diff) <= g.range + 1e-9 : Math.abs(diff) < 0.05;
    if (within) inRange++;
    const tr = simResult.tracks[g.idx];
    const planned = tr.finishClock;
    const actual = gr.medianMinutes !== null ? g.start + gr.medianMinutes : null;
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
      <p><strong>${escapeHtml(reviewState.fileName)}</strong>, imported ${escapeHtml(when)}${reviewState.lapKm ? ` · lap ${reviewState.lapKm} km from the file` : ''}. Actual finish is the median rider's time added to the grade's planned start, so it assumes grades started on time.</p>
      <button class="btn" onclick="clearReview()">Clear</button>
      <button class="btn primary" onclick="applyReviewSpeeds()">Update speeds from results</button>
    </div>
    <div class="stat-row">
      ${stat('Grades compared', nC, unmatched.length ? `not matched: ${unmatched.map(escapeHtml).join(', ')}` : '')}
      ${stat('Speed error', nC ? `${fmtSpd(sumSpeed / nC)} km/h` : '—', 'average, planned vs actual')}
      ${stat('Within ± range', nC ? `${inRange}/${nC}` : '—', 'grades whose actual speed fell in the planned range')}
      ${stat('Finish error', nFinish ? formatSplit(sumFinish / nFinish) : '—', 'average, min:sec')}
    </div>
    ${nC ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Grade</th>${raceType === 'circuit' ? '<th>Laps ridden</th>' : ''}<th>Planned km/h</th><th>Actual km/h</th><th>Difference</th><th>Predicted finish</th><th>Actual finish</th><th>Off by</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<div class="callout warn"><span>No grades in the file are matched to grades in this race. Import again and choose a grade for each group.</span></div>'}
    <div class="rv-catches">
      <div><div class="scenario-result-head">Catches predicted by your plan (${simResult.events.length})</div>${catchList(simResult.events, grades)}</div>
      <div><div class="scenario-result-head">Catches predicted with the actual speeds (${actualSim.events.length})</div>${catchList(actualSim.events, actualGrades)}</div>
    </div>
    <p class="field-hint" style="margin:12px 0 0">The results file has finishing times only, so actual catches during the race can't be confirmed from it. The right-hand list is what the model predicts once it knows the real speeds.</p>
  `;
}
