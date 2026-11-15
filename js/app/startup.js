/* Cycling Race Simulator: Start-up (runs last, once every other file has loaded).
   One of the page scripts in js/app/, loaded in order by index.html (see README). */

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
