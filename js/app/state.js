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
