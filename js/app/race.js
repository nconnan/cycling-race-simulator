/* Cycling Race Simulator: Race setup, grades, what-if analysis and playback.
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

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
    historyCourse = '';

    gradeCounter = 5;
    setupGradeInputs();

    // Rebuild the race from the default grades, as on first load.
    updateCourseSetup();
  }
}

function addGradeButtonHTML() {
  return `<button type="button" class="add-grade-btn" id="addGradeBtn" onclick="addNewGrade()">+ Add grade</button>
    <div class="grade-tools">
      <button type="button" class="import-btn" onclick="openHistorySuggest()" title="Set speeds and ± ranges from past races on this course">Speeds from history…</button>
      <button type="button" class="import-btn" onclick="importResults()" title="Set speeds and ± ranges from a results file (CSV)">Import results (CSV)…</button>
    </div>`;
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
  document.title = `${raceName} · Cycling Race Simulator v${APP_VERSION}`;
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
  renderHistoryCourseSelect();
  renderHistory();
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
