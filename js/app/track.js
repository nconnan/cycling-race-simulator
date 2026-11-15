/* Cycling Race Simulator: Catch snapshots and drawing the track.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

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
  updateTimelinePlayhead();
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
