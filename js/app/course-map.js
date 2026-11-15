/* Cycling Race Simulator: GPX course maps and hills; planner lock chips.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

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
