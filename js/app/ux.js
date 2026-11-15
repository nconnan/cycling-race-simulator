/* Cycling Race Simulator: undo/redo, grouped tabs, race timeline, compact grade table,
   new-race wizard and accessibility helpers.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

// ---------- Undo / redo ----------

const undoStack = [];
const redoStack = [];
let lastSetupSnapshot = null;
let applyingHistoryStep = false;

// Called at the end of every setup change: remembers the previous setup for Undo.
function recordSetup() {
  const snap = JSON.stringify(buildRaceData({ lean: true }));
  if (!applyingHistoryStep && lastSetupSnapshot && snap !== lastSetupSnapshot) {
    undoStack.push(lastSetupSnapshot);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }
  lastSetupSnapshot = snap;
  updateUndoButtons();
}

function stepSetup(from, to, label) {
  if (!from.length) return;
  const target = from.pop();
  to.push(lastSetupSnapshot);
  applyingHistoryStep = true;
  try { applyRaceData(JSON.parse(target)); } finally { applyingHistoryStep = false; }
  lastSetupSnapshot = target;
  updateUndoButtons();
  showToast(`<span class="t-ico">↶</span><span>${label}</span>`);
}

function undoSetup() { stepSetup(undoStack, redoStack, 'Change undone'); }
function redoSetup() { stepSetup(redoStack, undoStack, 'Change redone'); }

function updateUndoButtons() {
  const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

// A toast with an Undo button, for bigger changes (applying a plan, importing speeds…)
function showUndoToast(html) {
  showToast(`${html}<button type="button" class="toast-undo" onclick="undoSetup(); this.closest('.toast').remove()">Undo</button>`);
}

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoSetup(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoSetup(); }
});

// Keep the playback position across setup changes instead of jumping back to the start.
function restorePlayhead(t) {
  raceElapsed = Math.max(0, Math.min(t, raceMaxElapsed));
  // Catches already passed shouldn't pop up again as notifications
  catchEvents.forEach(ev => { if (ev.catchTime - raceStartMinutes <= raceElapsed) catchesProcessed.add(ev.key); });
  setSliderValue(Math.floor(raceElapsed * 100));
  updateRaceToTime(raceElapsed);
  refreshRaceViews();
}

// ---------- Grouped tabs ----------

const TAB_GROUPS = {
  race: ['standings', 'catches', 'summary'],
  plan: ['planner', 'risk', 'whatif'],
  learn: ['review', 'history']
};
const lastTabInGroup = { race: 'standings', plan: 'planner', learn: 'review' };

function groupOfTab(name) {
  return Object.keys(TAB_GROUPS).find(g => TAB_GROUPS[g].includes(name)) || 'race';
}

function showGroup(group) {
  showTab(lastTabInGroup[group] || TAB_GROUPS[group][0]);
}

// Arrow keys move between tabs (and between groups), as screen-reader users expect.
function tabKeyNav(e) {
  const list = e.currentTarget;
  const items = [...list.querySelectorAll('[role="tab"]')].filter(t => !t.hidden);
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % items.length;
  else if (e.key === 'ArrowLeft') j = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = items.length - 1;
  if (j === null) return;
  e.preventDefault();
  items[j].focus();
  items[j].click();
}
document.querySelectorAll('.tabs, .tabgroups').forEach(l => l.addEventListener('keydown', tabKeyNav));

// ---------- Race timeline ----------

let trackView = 'track';
let tlDrag = null;

function setTrackView(view) {
  trackView = view === 'timeline' ? 'timeline' : 'track';
  document.getElementById('track-view').hidden = trackView !== 'track';
  document.getElementById('timeline').hidden = trackView !== 'timeline';
  document.querySelectorAll('.view-btn').forEach(b => {
    const on = b.dataset.view === trackView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
  document.getElementById('track-title').textContent = trackView === 'timeline' ? 'Race timeline' : 'Live track';
  try { localStorage.setItem('crs-view', trackView); } catch (e) {}
  if (trackView === 'timeline') renderTimeline(); else drawRace();
}

function timelineEnd(tr) {
  return tr.neutralisedAt !== null ? tr.neutralisedAt : tr.finishClock;
}

function niceMinuteStep(span, px) {
  const target = span / Math.max(2, px / 90);
  return [1, 2, 5, 10, 15, 20, 30, 60, 120].find(s => s >= target) || 120;
}

/*
 * The timeline as SVG markup. opts.print uses fixed colours (for the race sheet);
 * opts.preview = { idx, start } draws one grade at a trial start while it is dragged.
 */
function buildTimelineSVG(width, opts = {}) {
  if (!grades.length) return '';
  let gs = grades, sim = simResult;
  if (opts.preview) {
    gs = grades.map((g, i) => i === opts.preview.idx ? { ...g, start: opts.preview.start } : g);
    sim = SimCore.simulateRace({ grades: gs, raceType, lapLength, afterCatch });
  }
  const P = opts.print;
  const C = P
    ? { text: '#111', muted: '#555', grid: '#ddd', bar: '#222', catchFill: '#d43c3c', deadline: '#d43c3c', bell: '#a45b06', now: '#2459e0', lap: 'rgba(255,255,255,.75)' }
    : { text: 'var(--text)', muted: 'var(--muted)', grid: 'var(--border)', bar: 'var(--cv-ring)', catchFill: 'var(--danger)', deadline: 'var(--danger)', bell: 'var(--warn)', now: 'var(--accent)', lap: 'rgba(255,255,255,.7)' };
  const rowH = P ? 26 : 34, barH = P ? 14 : 18;
  const left = P ? 46 : 58, right = P ? 160 : 170, top = 34, bottom = 12;
  const H = top + bottom + rowH * gs.length;
  const starts = gs.map(g => g.start);
  const ends = sim.tracks.map(timelineEnd);
  const deadlineOn = document.getElementById('plan-deadline-on')?.checked;
  const deadline = deadlineOn ? fromClock(document.getElementById('plan-deadline').value) : null;
  const lo = Math.floor(Math.min(...starts)) - 2;
  const hi = Math.ceil(Math.max(...ends, deadline !== null && isFinite(deadline) ? deadline : -Infinity)) + 2;
  const plotW = Math.max(120, width - left - right);
  const X = t => left + (t - lo) / (hi - lo) * plotW;
  const Y = i => top + i * rowH + rowH / 2;
  const esc = escapeHtml;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${P ? width : '100%'}" role="img" aria-label="Race timeline: each grade's ride from start to finish, with laps and catches" font-family="Inter, system-ui, sans-serif">`;

  // Time axis and grid
  const step = niceMinuteStep(hi - lo, plotW);
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${top - 8}" y2="${H - bottom}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${X(t)}" y="${top - 14}" text-anchor="middle" font-size="10.5" fill="${C.muted}" font-variant-numeric="tabular-nums">${toClock(t)}</text>`;
  }
  if (deadline !== null && isFinite(deadline)) {
    s += `<line x1="${X(deadline)}" x2="${X(deadline)}" y1="${top - 8}" y2="${H - bottom}" stroke="${C.deadline}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    s += `<text x="${X(deadline) + 4}" y="${H - bottom - 2}" font-size="10" font-weight="700" fill="${C.deadline}">Finish by ${toClock(deadline)}</text>`;
  }

  // One bar per grade
  gs.forEach((g, i) => {
    const tr = sim.tracks[i];
    const end = timelineEnd(tr);
    const y = Y(i);
    const x0 = X(g.start), x1 = X(end);
    const fill = safeColor(g.color);
    const dragging = opts.preview && opts.preview.idx === i;
    s += `<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-size="12" font-weight="700" fill="${C.text}">${esc(g.name)}</text>`;
    const tip = `${g.name}: start ${toClock(g.start)}, ${tr.neutralisedAt !== null ? 'neutralised ' + toClock(tr.neutralisedAt) : 'finish ' + toClock(end)}${raceType === 'circuit' ? `, ${g.laps} laps` : ''} at ${fmtSpd(g.spd)} km/h`;
    s += `<g class="tl-bar${dragging ? ' dragging' : ''}" data-idx="${i}" ${P ? '' : `tabindex="0" role="slider" aria-label="${esc(g.name)} start time" aria-valuetext="${toClock(g.start)}" data-tip="${esc(tip)}"`}>`;
    s += `<rect x="${x0}" y="${y - barH / 2}" width="${Math.max(2, x1 - x0)}" height="${barH}" rx="${barH / 2}" fill="${fill}" stroke="${C.bar}" stroke-opacity=".55" stroke-width="1.2"/>`;
    if (raceType === 'circuit' && g.laps > 1) {
      for (let k = 1; k < g.laps; k++) {
        const t = SimCore.timeAtDistance(tr, k * lapLength);
        if (t === null || t > end) continue;
        s += `<line x1="${X(t)}" x2="${X(t)}" y1="${y - barH / 2 + 3}" y2="${y + barH / 2 - 3}" stroke="${textColorFor(fill) === '#fff' ? C.lap : 'rgba(0,0,0,.35)'}" stroke-width="1.2"/>`;
      }
      const bell = SimCore.timeAtDistance(tr, (g.laps - 1) * lapLength);
      if (bell !== null && tr.neutralisedAt === null) {
        // A small bell icon (vector, so it looks the same everywhere and in print), sitting on the bar
        const bx = X(bell) - 5, by = y - barH / 2 - 12;
        s += `<g transform="translate(${bx},${by})" fill="${C.bell}"${P ? '' : ` data-tip="${esc(g.name)}: bell (final lap) ${toClockSec(bell)}"`}>`
          + `<path d="M5 0.6C3.1 0.6 2 2.2 2 4.2V6.6L0.7 8.3H9.3L8 6.6V4.2C8 2.2 6.9 0.6 5 0.6Z"/>`
          + `<circle cx="5" cy="9.7" r="1.25"/>`
          + `<rect x="0" y="0" width="10" height="11" fill="transparent"/></g>`;
      }
    }
    if (tr.neutralisedAt !== null) {
      s += `<path d="M${x1 - 4},${y - 4} l8,8 M${x1 + 4},${y - 4} l-8,8" stroke="${C.catchFill}" stroke-width="2"/>`;
    }
    const endLabel = tr.neutralisedAt !== null ? `out ${toClock(end)}` : toClock(end);
    s += `<text x="${x1 + 8}" y="${y + 4}" font-size="11" fill="${C.text}" font-variant-numeric="tabular-nums"><tspan font-weight="700">${endLabel}</tspan><tspan fill="${C.muted}"> · ${raceType === 'circuit' ? g.laps + ' laps · ' : ''}${fmtSpd(g.spd)} km/h</tspan></text>`;
    if (dragging) {
      s += `<text x="${x0}" y="${y - barH / 2 - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="${C.now}">${toClock(g.start)} (${opts.preview.start - grades[i].start >= 0 ? '+' : '−'}${Math.abs(opts.preview.start - grades[i].start)} min)</text>`;
    }
    s += `</g>`;
  });

  // Catches: a line from the catcher's row to the caught grade's row
  for (const ev of sim.events) {
    const x = X(ev.catchTime), y1 = Y(ev.c1Index), y2 = Y(ev.c2Index);
    const a = gs[ev.c1Index], b = gs[ev.c2Index];
    const lapped = raceType === 'circuit' && ev.lapsUp > 0;
    const tip = `${a.name} ${lapped ? 'laps' : 'catches'} ${b.name} at ${toClock(ev.catchTime)}`;
    s += `<g class="tl-catch"${P ? '' : ` data-tip="${esc(tip)}"`}>`;
    s += `<line x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" stroke="${C.catchFill}" stroke-width="1.5" stroke-dasharray="${lapped ? '3 3' : 'none'}" opacity=".85"/>`;
    s += `<circle cx="${x}" cy="${y2}" r="5" fill="${C.catchFill}" stroke="#fff" stroke-width="1.5"/>`;
    s += `<circle cx="${x}" cy="${y1}" r="3" fill="${C.catchFill}"/>`;
    s += `</g>`;
  }

  if (!P) {
    const now = raceStartMinutes + raceElapsed;
    s += `<line id="tl-playhead" x1="${X(now)}" x2="${X(now)}" y1="${top - 8}" y2="${H - bottom}" stroke="${C.now}" stroke-width="2" data-lo="${lo}" data-hi="${hi}" data-left="${left}" data-plotw="${plotW}"/>`;
  }
  return s + `</svg>`;
}

function renderTimeline(preview) {
  const box = document.getElementById('timeline-plot');
  if (!box || document.getElementById('timeline').hidden) return;
  const width = Math.max(320, Math.round(box.clientWidth || 900));
  box.innerHTML = buildTimelineSVG(width, preview ? { preview } : {});
  const n = simResult ? simResult.events.length : 0;
  document.getElementById('timeline-summary').textContent = preview
    ? `Drop to set ${grades[preview.idx].name}'s start to ${toClock(preview.start)}.`
    : `${n} catch${n === 1 ? '' : 'es'} predicted. Drag a grade's bar to change its start time.`;
}

function updateTimelinePlayhead() {
  const line = document.getElementById('tl-playhead');
  if (!line || document.getElementById('timeline').hidden) return;
  const lo = +line.dataset.lo, hi = +line.dataset.hi, left = +line.dataset.left, w = +line.dataset.plotw;
  const x = left + ((raceStartMinutes + raceElapsed) - lo) / (hi - lo) * w;
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
}

function setGradeStart(i, minutes) {
  const rows = document.getElementById('grade-form').querySelectorAll('.grade-row');
  const row = rows[i];
  if (!row) return;
  document.getElementById(`g${row.dataset.index}_start`).value = toClock(minutes);
  updateCourseSetup();
}

(function wireTimeline() {
  const wrap = document.getElementById('timeline-plot');
  const tip = document.getElementById('timeline-tip');
  if (!wrap) return;
  const pxPerMin = () => {
    const line = document.getElementById('tl-playhead');
    const svg = wrap.querySelector('svg');
    if (!line || !svg) return 1;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return (+line.dataset.plotw / (+line.dataset.hi - +line.dataset.lo)) * scale;
  };
  wrap.addEventListener('pointerdown', e => {
    const bar = e.target.closest('.tl-bar');
    if (!bar) return;
    const idx = +bar.dataset.idx;
    tlDrag = { idx, x0: e.clientX, orig: grades[idx].start, start: grades[idx].start, ppm: pxPerMin() };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
    tip.hidden = true;
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', e => {
    if (tlDrag) {
      const start = tlDrag.orig + Math.round((e.clientX - tlDrag.x0) / tlDrag.ppm);
      if (start !== tlDrag.start) {
        tlDrag.start = start;
        renderTimeline({ idx: tlDrag.idx, start });
      }
      return;
    }
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    const r = document.getElementById('timeline').getBoundingClientRect();
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
  });
  const end = () => {
    if (!tlDrag) return;
    const { idx, orig, start } = tlDrag;
    tlDrag = null;
    wrap.classList.remove('dragging');
    if (start !== orig) {
      setGradeStart(idx, start);
      showUndoToast(`<span class="t-ico">✓</span><span>${escapeHtml(grades[idx].name)} now starts at <strong>${toClock(start)}</strong></span>`);
    } else {
      renderTimeline();
    }
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('pointerleave', () => { if (!tlDrag) tip.hidden = true; });
  // Keyboard: arrow keys move the focused grade's start by a minute (Shift: 5)
  wrap.addEventListener('keydown', e => {
    const bar = e.target.closest && e.target.closest('.tl-bar');
    if (!bar || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = +bar.dataset.idx;
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1);
    setGradeStart(idx, grades[idx].start + d);
    const again = wrap.querySelector(`.tl-bar[data-idx="${idx}"]`);
    if (again) again.focus();
  });
})();

window.addEventListener('resize', () => { if (trackView === 'timeline') renderTimeline(); });

// ---------- Compact grade table ----------

let gradeLayout = 'cards';

function setGradeLayout(layout) {
  gradeLayout = layout === 'table' ? 'table' : 'cards';
  document.getElementById('grade-form').classList.toggle('compact', gradeLayout === 'table');
  document.getElementById('grade-table-head').hidden = gradeLayout !== 'table';
  document.getElementById('grade-table-head').classList.toggle('no-laps', raceType !== 'circuit');
  document.querySelectorAll('.layout-btn').forEach(b => {
    const on = b.dataset.layout === gradeLayout;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
  try { localStorage.setItem('crs-grade-layout', gradeLayout); } catch (e) {}
}

// Paste rows from a spreadsheet into the grades: name, start, laps, speed, ± (from the cell you paste into).
function parsePastedStart(v) {
  const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1];
  if (m[3]) { if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0; }
  return h * 60 + +m[2];
}

document.getElementById('grade-form').addEventListener('paste', e => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || !input.closest('.grade-row')) return;
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!/[\t\n]/.test(text.trim())) return; // a single value: normal paste
  e.preventDefault();
  const fields = raceType === 'circuit' ? ['name', 'start', 'laps', 'spd', 'range'] : ['name', 'start', 'spd', 'range'];
  const field = (input.id.match(/_(name|start|laps|spd|range)$/) || [])[1];
  const col0 = Math.max(0, fields.indexOf(field));
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  const form = document.getElementById('grade-form');
  let rows = [...form.querySelectorAll('.grade-row')];
  const row0 = rows.indexOf(input.closest('.grade-row'));
  let changed = 0, skipped = 0;
  lines.forEach((line, k) => {
    const cells = line.split('\t');
    while (row0 + k >= rows.length && rows.length < MAX_GRADES) {
      const index = gradeCounter++;
      addGradeRow(form, index, String.fromCharCode(65 + (rows.length % 26)), defaultColor(rows.length), defaultClock(rows.length), raceType === 'circuit' ? 1 : 1, 30, '', false, 1);
      rows = [...form.querySelectorAll('.grade-row')];
    }
    const row = rows[row0 + k];
    if (!row) { skipped++; return; }
    cells.forEach((cell, j) => {
      const f = fields[col0 + j];
      if (!f) return;
      const el = document.getElementById(`g${row.dataset.index}_${f}`);
      if (!el) return;
      const v = cell.trim();
      if (f === 'name') { if (v) { el.value = v.slice(0, 12); changed++; } }
      else if (f === 'start') { const t = parsePastedStart(v); if (t !== null) { el.value = toClock(t); changed++; } else skipped++; }
      else { const n = parseFloat(v.replace(',', '.').replace(/[^\d.\-]/g, '')); if (isFinite(n)) { el.value = n; changed++; } else if (v) skipped++; }
    });
  });
  updateMoveButtons();
  updateAddButton();
  updateCourseSetup();
  showUndoToast(`<span class="t-ico">✓</span><span>Pasted ${lines.length} row${lines.length === 1 ? '' : 's'} (${changed} values${skipped ? `, ${skipped} skipped` : ''})</span>`);
});

// ---------- New-race wizard ----------

let wiz = null;
const WIZ_STEPS = ['Course', 'Grades', 'Plan', 'Check'];

function openWizard() {
  const courses = historyCourses();
  wiz = {
    step: 0,
    name: 'Club race',
    course: historyCourse || (courses[0] ? courses[0][0] : ''),
    type: 'circuit',
    lap: lapLength,
    start: toClock(raceStartMinutes),
    grades: null,
    order: 'slowest', gap: 1, rule: 'final', n: 2, ranges: true, deadlineOn: false, deadline: '11:00'
  };
  wizCourseDefaults();
  renderWizard();
}

// Pick up the course's usual lap and grades from the history
function wizCourseDefaults() {
  const races = wiz.course ? allHistory().filter(r => r.c === wiz.course) : [];
  if (races.length) {
    const laps = races.map(r => r.l).sort((a, b) => a - b);
    wiz.lap = laps[Math.floor(laps.length / 2)];
  }
  const order = ['A', 'B', 'C', 'D', 'E', 'OPEN', 'WA', 'WB', 'WC', 'WD'];
  const recent = races.slice(0, 10);
  const keys = order.filter(k => recent.some(r => r.g.some(g => SimCore.gradeKey(g[0]) === k)));
  // Men's graded racing (A–E, or Open where it has replaced A) is ticked by default
  const main = keys.filter(k => ['A', 'B', 'C', 'D', 'E', 'OPEN'].includes(k));
  const defaults = [42, 40, 38, 36, 34];
  wiz.grades = (keys.length ? keys : ['A', 'B', 'C', 'D', 'E']).map((k, i) => {
    const recs = wiz.course ? historyFor(wiz.course, k) : [];
    const sug = SimCore.historySuggestion(recs, 6);
    const laps = typicalLaps(recs.slice(0, 6));
    return {
      name: k === 'OPEN' ? 'Open' : k,
      include: keys.length ? main.includes(k) || (main.length === 0) : true,
      spd: sug ? sug.speed : defaults[i] || 32,
      range: sug ? sug.range : 1,
      laps: laps || Math.max(1, 6 - i),
      races: sug ? sug.races : 0
    };
  });
}

function wizRead() {
  const v = id => document.getElementById(id);
  if (wiz.step === 0) {
    wiz.name = v('wz-name').value.trim() || 'Club race';
    wiz.type = v('wz-type').value;
    wiz.lap = +v('wz-lap').value > 0 ? +v('wz-lap').value : wiz.lap;
    wiz.start = v('wz-start').value || wiz.start;
  } else if (wiz.step === 1) {
    wiz.grades.forEach((g, i) => {
      g.include = v(`wz-g${i}-on`).checked;
      g.name = v(`wz-g${i}-name`).value.trim().slice(0, 12) || g.name;
      g.spd = +v(`wz-g${i}-spd`).value || g.spd;
      g.range = +v(`wz-g${i}-rng`).value >= 0 ? +v(`wz-g${i}-rng`).value : g.range;
      if (v(`wz-g${i}-laps`)) g.laps = Math.max(1, Math.round(+v(`wz-g${i}-laps`).value) || g.laps);
    });
  } else if (wiz.step === 2) {
    wiz.order = v('wz-order').value;
    wiz.gap = Math.max(0, Math.round(+v('wz-gap').value) || 0);
    wiz.rule = v('wz-rule').value;
    wiz.n = Math.max(1, Math.round(+v('wz-n').value) || 1);
    wiz.ranges = v('wz-ranges').checked;
    wiz.deadlineOn = v('wz-deadline-on').checked;
    wiz.deadline = v('wz-deadline').value || wiz.deadline;
  }
}

function wizGo(delta) {
  wizRead();
  if (wiz.step === 1 && delta > 0 && !wiz.grades.some(g => g.include)) { alert('Choose at least one grade.'); return; }
  wiz.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, wiz.step + delta));
  renderWizard();
}

function wizCourseChanged(value) {
  wizRead();
  wiz.course = value;
  wizCourseDefaults();
  renderWizard();
}

function wizPlan() {
  const chosen = wiz.grades.filter(g => g.include);
  const lapKm = wiz.lap;
  const gs = chosen.map(g => ({
    ...g,
    laps: wiz.type === 'circuit' ? g.laps : 1,
    totalDistance: wiz.type === 'circuit' ? g.laps * lapKm : wiz.type === 'outback' ? 2 * lapKm : lapKm
  }));
  const raceStart = fromClock(wiz.start);
  const plan = SimCore.planStarts({
    grades: gs, raceType: wiz.type, lapLength: lapKm, raceStart,
    order: wiz.order, minGap: wiz.gap, objective: 'compact',
    rule: wiz.rule === 'final' ? { type: 'final', n: wiz.n } : { type: 'none' },
    useRanges: wiz.ranges,
    finishBy: wiz.deadlineOn ? fromClock(wiz.deadline) : null, allowLapCuts: true
  });
  const planned = gs.map((g, i) => ({ ...g, start: plan.starts[i], laps: wiz.type === 'circuit' ? plan.laps[i] : 1,
    totalDistance: wiz.type === 'circuit' ? plan.laps[i] * lapKm : g.totalDistance }));
  const sim = SimCore.simulateRace({ grades: planned, raceType: wiz.type, lapLength: lapKm, afterCatch });
  return { plan, planned, sim };
}

function renderWizard() {
  const s = wiz.step;
  const steps = WIZ_STEPS.map((n, i) => `<li class="${i === s ? 'on' : i < s ? 'done' : ''}" ${i === s ? 'aria-current="step"' : ''}><span>${i + 1}</span>${n}</li>`).join('');
  let body = '';
  if (s === 0) {
    const courses = historyCourses();
    body = `
      <div class="field-grid">
        <label class="field full"><span class="field-label">Race name</span><input type="text" id="wz-name" value="${escapeHtml(wiz.name)}"></label>
        <label class="field full"><span class="field-label">Course</span>
          <select id="wz-course" onchange="wizCourseChanged(this.value)">
            <option value="">A new course (no history)</option>
            ${courses.map(([c, n]) => `<option value="${escapeHtml(c)}" ${c === wiz.course ? 'selected' : ''}>${escapeHtml(c)} (${n} races)</option>`).join('')}
          </select>
          <span class="field-hint">With a course from the history, the next step fills in each grade's usual speed and laps.</span>
        </label>
        <label class="field"><span class="field-label">Race type</span>
          <select id="wz-type">${Object.entries(RACE_TYPE_LABELS).map(([k, l]) => `<option value="${k}" ${k === wiz.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span class="field-label">Lap or race length</span><span class="input-unit"><input type="number" id="wz-lap" value="${wiz.lap}" min="0.1" step="0.01"><span class="unit">km</span></span></label>
        <label class="field"><span class="field-label">First start</span><input type="time" id="wz-start" value="${wiz.start}" step="60"></label>
      </div>`;
  } else if (s === 1) {
    const circuit = wiz.type === 'circuit';
    body = `
      <p class="wz-lead">${wiz.course ? `Speeds are each grade's suggestion from the latest races at <strong>${escapeHtml(wiz.course)}</strong>.` : 'No history for this course, so these are starting values.'} Tick the grades racing and adjust anything.</p>
      <div class="table-wrap"><table class="data wz-grades">
        <thead><tr><th></th><th>Grade</th><th>km/h</th><th>±</th>${circuit ? '<th>Laps</th>' : ''}<th>History</th></tr></thead>
        <tbody>${wiz.grades.map((g, i) => `<tr>
          <td><input type="checkbox" id="wz-g${i}-on" ${g.include ? 'checked' : ''} aria-label="Include grade ${escapeHtml(g.name)}"></td>
          <td><input type="text" id="wz-g${i}-name" value="${escapeHtml(g.name)}" maxlength="12" aria-label="Grade name"></td>
          <td><input type="number" id="wz-g${i}-spd" value="${g.spd}" step="0.1" min="10" max="70" aria-label="Speed"></td>
          <td><input type="number" id="wz-g${i}-rng" value="${g.range}" step="0.5" min="0" max="10" aria-label="± range"></td>
          ${circuit ? `<td><input type="number" id="wz-g${i}-laps" value="${g.laps}" min="1" max="99" aria-label="Laps"></td>` : ''}
          <td class="muted">${g.races ? `${g.races} races` : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`;
  } else if (s === 2) {
    body = `
      <div class="field-grid">
        <label class="field"><span class="field-label">Start order</span><select id="wz-order">
          <option value="slowest" ${wiz.order === 'slowest' ? 'selected' : ''}>Slowest first (handicap)</option>
          <option value="fastest" ${wiz.order === 'fastest' ? 'selected' : ''}>Fastest first</option>
          <option value="current" ${wiz.order === 'current' ? 'selected' : ''}>As listed</option></select></label>
        <label class="field"><span class="field-label">Minimum start gap</span><span class="input-unit"><input type="number" id="wz-gap" value="${wiz.gap}" min="0" max="30"><span class="unit">min</span></span></label>
        <label class="field"><span class="field-label">Rule</span><select id="wz-rule">
          <option value="final" ${wiz.rule === 'final' ? 'selected' : ''}>No catches in the final…</option>
          <option value="none" ${wiz.rule === 'none' ? 'selected' : ''}>No catches at all</option></select></label>
        <label class="field"><span class="field-label">Final</span><span class="input-unit"><input type="number" id="wz-n" value="${wiz.n}" min="1"><span class="unit">${wiz.type === 'circuit' ? 'laps' : 'km'}</span></span></label>
        <div class="field full">
          <label class="check"><input type="checkbox" id="wz-ranges" ${wiz.ranges ? 'checked' : ''}> Plan for each grade's ± range</label>
          <div class="rule-row"><label class="check" style="flex:none"><input type="checkbox" id="wz-deadline-on" ${wiz.deadlineOn ? 'checked' : ''}> Everyone finished by</label><input type="time" id="wz-deadline" value="${wiz.deadline}" step="60" style="flex:1"></div>
        </div>
      </div>`;
  } else {
    const { plan, planned, sim } = wizPlan();
    const ends = sim.tracks.map(t => t.finishClock).filter(v => v !== null);
    body = `
      ${plan.feasible ? '' : `<div class="callout warn"><span>${escapeHtml(plan.notes[0].message)} You can go back and loosen the rule, or create the race and adjust it.</span></div>`}
      <div class="stat-row">
        <div class="stat"><div class="k">Predicted catches</div><div class="v">${sim.events.length}</div></div>
        <div class="stat"><div class="k">First start</div><div class="v mono">${toClock(Math.min(...plan.starts))}</div></div>
        <div class="stat"><div class="k">Last finish</div><div class="v mono">${ends.length ? toClock(Math.max(...ends)) : '—'}</div></div>
      </div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Grade</th><th>Start</th>${wiz.type === 'circuit' ? '<th>Laps</th>' : ''}<th>km/h</th><th>Finish</th></tr></thead><tbody>
        ${planned.map((g, i) => ({ g, i })).sort((a, b) => a.g.start - b.g.start).map(({ g, i }) => `<tr><td><strong>${escapeHtml(g.name)}</strong></td><td class="mono">${toClock(g.start)}</td>${wiz.type === 'circuit' ? `<td class="mono">${g.laps}</td>` : ''}<td class="mono">${fmtSpd(g.spd)} ±${g.range}</td><td class="mono">${sim.tracks[i].finishClock !== null ? toClock(sim.tracks[i].finishClock) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  openDialog('New race', `<ol class="wz-steps" aria-label="Steps">${steps}</ol>${body}`, `
    <button class="btn" onclick="closeDialog()">Cancel</button>
    <span style="flex:1"></span>
    ${s > 0 ? '<button class="btn" onclick="wizGo(-1)">Back</button>' : ''}
    ${s < WIZ_STEPS.length - 1 ? '<button class="btn primary" onclick="wizGo(1)">Next</button>' : '<button class="btn primary" onclick="wizCreate()">Create race</button>'}
  `);
}

function wizCreate() {
  const { plan, planned } = wizPlan();
  const data = {
    raceName: wiz.name,
    raceType: wiz.type,
    raceStartMinutes: Math.min(fromClock(wiz.start), ...plan.starts),
    lapLength: wiz.lap,
    afterCatch,
    direction: { ...directionByType },
    course,
    hillEffect,
    historyCourse: wiz.course,
    grades: planned.map((g, i) => ({ name: g.name, color: defaultColor(i), start: g.start, laps: g.laps, spd: g.spd, range: g.range })),
    scenarioAdjustments: []
  };
  // Carry the wizard's rule into the planner tab
  document.getElementById('plan-order').value = wiz.order;
  document.getElementById('plan-gap').value = wiz.gap;
  document.getElementById('plan-rule').value = wiz.rule;
  document.getElementById('plan-n').value = wiz.n;
  document.getElementById('plan-ranges').checked = wiz.ranges;
  document.getElementById('plan-deadline-on').checked = wiz.deadlineOn;
  document.getElementById('plan-deadline').value = wiz.deadline;
  raceElapsed = 0;
  applyRaceData(data);
  closeDialog();
  showUndoToast(`<span class="t-ico">✓</span><span>Created <strong>${escapeHtml(wiz.name)}</strong> with ${planned.length} grades</span>`);
}

// ---------- Accessibility: dialogs keep focus ----------

let dialogReturnFocus = null;
const openDialogBase = openDialog;
openDialog = function (title, body, foot) {
  if (!document.getElementById('dialog').classList.contains('active')) dialogReturnFocus = document.activeElement;
  openDialogBase(title, body, foot);
  const first = document.querySelector('#dialog .modal-content input:not([type=hidden]), #dialog .modal-content select, #dialog .modal-content button:not(.icon)');
  if (first) first.focus({ preventScroll: true });
};
const closeDialogBase = closeDialog;
closeDialog = function () {
  const wasOpen = document.getElementById('dialog').classList.contains('active');
  closeDialogBase();
  if (wasOpen && dialogReturnFocus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus({ preventScroll: true });
  dialogReturnFocus = null;
};
// Tab stays inside an open dialog
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dlg = document.querySelector('.modal-overlay.active .modal-content');
  if (!dlg) return;
  const items = [...dlg.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
