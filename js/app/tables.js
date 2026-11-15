/* Cycling Race Simulator: Notifications, live tables and file save/load.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

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
