/* Cycling Race Simulator: Start-up (runs last, once every other file has loaded).
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

// ---------- Start-up ----------

// Show the version and update date (the HTML carries the same text for first paint).
document.querySelectorAll('.app-version').forEach(el => { el.textContent = `v${APP_VERSION}`; el.title = `Version ${APP_VERSION}, updated ${appUpdatedLabel()}`; });
document.querySelectorAll('.app-version-line').forEach(el => { el.textContent = `Version ${APP_VERSION} · updated ${appUpdatedLabel()}`; });

setupCanvas();
updateAfterCatchHint();
setupGradeInputs();
updateCourseSetup();
restoreStartupRace();
(function restoreView() {
  let tab = null, view = null, layout = null;
  try { tab = localStorage.getItem('crs-tab'); view = localStorage.getItem('crs-view'); layout = localStorage.getItem('crs-grade-layout'); } catch (e) {}
  showTab(tab && document.getElementById(`tab-${tab}`) ? tab : 'standings');
  setGradeLayout(layout === 'table' ? 'table' : 'cards');
  setTrackView(view === 'timeline' ? 'timeline' : 'track');
})();
// Redraw once web fonts are ready so canvas labels use them.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawRace());
