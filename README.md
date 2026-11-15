# Cycling Race Simulator v11

Plan graded cycling races: predict when grades catch each other, plan start gaps that avoid catches, and print a race-day sheet for the commissaire.

## What's in v11

- **After-catch rules** (Race setup → *When a grade is caught*): both grades carry on, the caught grade is neutralised, or the caught grade joins the catching bunch.
- **Speed ranges** (each grade's *± Range*): how far a grade's speed may vary either way.
- **Catch risk** tab: runs the race 300 times with speeds varied within their ranges. It shows how likely each catch is, the time window for the first meeting, and the lap or distance where it happens.
- **Start planner** tab: suggests start times that keep a rule ("no catches", or "no catches in the final N laps/km"). It can aim for the shortest overall race or for grades finishing close together, and can allow for speed ranges. *Apply to race* writes the start times into the grades.
- **Race sheet** button: a printable A4 sheet (or *Save as PDF*). It has the start list, lap times, bell-lap times, expected finishes, predicted catches, and catch risk, plus lap-by-lap clock times for circuits.
- **Installable app**: works offline, with its own icon on the iPhone or Android home screen.
- **Direction of travel** (Race setup): clockwise or anticlockwise for circuits and out-and-back courses. It changes only the drawing, not timings or catches. It's saved with the race and shown on the race sheet.
- **Smooth playback**: markers are redrawn in step with the screen's refresh rate and leave a short fading trail. At 1×, playback slows down for short courses so the fastest grade takes about 8 seconds per lap (15 seconds per course for other race types). Long courses keep the old maximum rate. Speeds are ½×, 1×, 2×, 4× and 8×, and a line under the speed buttons shows how long the whole race takes to play.
- **"On course" strip**: one fixed-height row that scrolls sideways, so the track no longer jumps when many grades are racing.

## New in v11.7: automatic club results from Sporthive

- **Weekly update:** every Monday at about 5:15 am Perth time, GitHub runs `tools/sporthive-sync.js`.
  - It reads each listed club's new races from Sporthive (MYLAPS) and adds their grade speeds to `js/history-data.js` (speeds only, no names).
  - It runs the tests, saves the data and republishes the app.
  - A week with nothing new makes about 6 requests to Sporthive. Races published twice (same day, course and results) are kept once.
  - If Sporthive can't be read, the run fails, GitHub emails the repository owner, and the app keeps the last data.
- **Update now:** in the repository's **Actions** tab, choose **Test and deploy**, then **Run workflow**.
- **Clubs:** choose the club in **Race setup → Club** or in the History tab. Course lists, suggested speeds, the wizard and the latest races all follow the chosen club. The list starts with Peel District Cycling Club and Midland Cycle Club.
- **Add a club:** choose **Club → Add your club…**, paste the club's Sporthive page address (`sporthive.com/organizations/<number>`) and its name, and copy the line the app makes into `tools/sporthive.config.json` on GitHub. The club's results arrive at the next update. The app itself can't read Sporthive (MYLAPS blocks other websites), so the list lives in the repository.
- **Latest club races** (History tab): each recent graded race has **Use these speeds** and **Review against plan**, with no CSV download needed.
- Run the sync yourself with `npm run sync`. Behind a proxy, use Node 22.21+ with `NODE_USE_ENV_PROXY=1`.

This uses MYLAPS' public results service, the one their own website uses. It isn't an official interface for other apps and could change. The CSV import (Grades → Import results) remains as a fallback.

## New in v11.6: professional UI pass

- **Race timeline** (Live track → *Timeline*): one bar per grade from start to finish, with lap ticks, the bell lap (▲), catches (a red line from catcher to caught; dashed when lapping), the finish-by deadline and the playhead. **Drag a bar** to change that grade's start and watch the catches move, or focus a bar and use ← → (Shift for 5 minutes). The timeline is also printed on the race sheet.
- **Grouped tabs:** **Race** (Standings, Catch log, Summary), **Plan** (Start planner, Catch risk, What-if) and **Learn** (Review, History). On phones the three groups are a bottom bar. Arrow keys move between tabs.
- **Undo / Redo** (above Race setup, or Ctrl/⌘ Z and Ctrl/⌘ Shift Z) for every setup change. Bigger actions (applying a plan, speeds from history or results, a pasted table, the wizard, reset) show a confirmation with an **Undo** button.
- **Calmer editing:** changing the setup keeps the playback position instead of jumping back to the start.
- **Compact grade table** (Grades → *Table*): one line per grade (colour, name, start, laps, km/h, ±). **Paste rows from a spreadsheet** into any cell, with columns name, start, laps, speed and ±, starting from the cell you paste into; extra rows add grades.
- **New race wizard** (header → *New race*): course (with its history), then grades (speeds, ± and laps prefilled from that course), then the planner's rule, then a check of the plan before creating the race.
- **Accessibility:** grade labels pick dark or white text by WCAG contrast (yellow and white grades now get dark text). Dialogs keep keyboard focus inside and return it on close. Tabs use proper tab roles. View and layout choices are remembered.

## New in v11.5: course speed history

- **Built-in club history:** speeds from 195 of Peel District Cycling Club's lap races on Sporthive, 2016–2026, across about 30 courses. It holds finishing speeds only, with no names (`js/history-data.js`).
- **Course for speed history** (Race setup) and the **History** tab show, for each grade on a course:
  - the suggested speed (median of the latest 3/6/10/20 races)
  - a ± range that covers race-to-race variation as well as the spread within one race
  - the trend, typical laps, the share of riders lapped or pulled, and a mini chart of recent races
- **Speeds from history…** (under the grades) applies those speeds and ranges, and optionally the typical laps, to your grades. Grade names are matched across seasons: A = MA = "A Grade", and WA = "Womens A".
- **Review** gains an **Actual start** time for each grade, so finish comparisons are right when a grade went off late, and **Add to course history** so your own reviewed races join the history. These are stored in your browser.

Why the range matters: in the club's results a grade finishes within about ±0.5 km/h in one race, but varies about **±2 km/h from race to race**. Plan on the second figure.

## New in v11.4: post-race review

1. After the race, open the event on **Sporthive / Speedhive** and download the results CSV. MyLaps Orbits exports work too, as does any results file with a grade and a time column.
2. Under the grades, choose **Import results (CSV)**. The importer is built around real MyLaps Orbits Cycling exports:
   - It uses **Total Time**, not *Best Speed*, which is a best lap.
   - It skips DNF, DNS and DQ riders.
   - It leaves lapped or pulled riders (fewer laps than their grade) out of the speeds.
   - It works out the **lap length** from best lap × best speed and offers to use it.
   - It matches club grades like **MA, MB, MC** to grades **A, B, C**.
3. **Compare with plan** opens the **Review** tab, with plan against actual for each grade:
   - laps ridden
   - planned and actual speed, and whether the actual fell in your ± range
   - predicted and actual finish time
   - the catches predicted with your planned speeds versus with the real speeds

   **Update speeds from results** then feeds the real speeds and ranges into the next plan.

The review is saved with the race as speeds and times only, with no riders' names. Sporthive's CSV has finishing times but no lap-by-lap times, so actual catches can't be confirmed from it. *Actual finish* assumes each grade started at its planned time.

## New in v11.3

- **Races library** (header → *Races*): save races in this browser, then open, duplicate or delete them. The race you're working on is saved automatically and comes back when you reopen the app. Opening and downloading files has moved here too.
- **Share link** (header → *Share*): the whole race is packed into a link (nothing is uploaded). Anyone opening it gets your grades, start times, settings and course map. Links work for other people once the app is hosted.
- **Planner rules**:
  - *Finish deadline*: everyone must have finished by a set time. On circuits it can cut laps from the latest finishers to fit; with speed ranges it plans for the slowest speeds.
  - *Keep the current start for*: lock chosen grades to their start; the others are planned around them.
  - *Method → Fixed gap, choose laps* (circuits): starts are a fixed number of minutes apart, and each grade gets the most laps (up to its current number) that keep the rule.
- **Import results (CSV)** (under the grades): set each grade's speed and ± range from a past race. The importer recognises grade/category, time/elapsed, speed, distance, laps and status columns (DNF, DNS and DSQ rows are skipped). Speed is the median rider, and the ± range covers the middle 80% of the field. See `docs/sample-results.csv`.
- **Course map (GPX)** (Race setup → *Course map*): draw the real course from a GPX route, with distance markers and an elevation profile. With *Slower on climbs, faster on descents*, riders slow on hills and speed up downhill. Every grade meets the same hills, so **catch times don't change**; only where on the course things happen moves. The map is stretched to your set lap length, or you can use the map's own length. See `docs/sample-circuit.gpx`.

## Two ways to use it

| | File | How |
|---|---|---|
| Single file | `dist/Professional_Cycling_Race_Simulator_v11.html` | Double-click to open in any browser. Everything, fonts included, is inside the file. |
| Installable app | the whole folder | Host it on any HTTPS static host (see below), open it on the phone, then *Share → Add to Home Screen* (iPhone, Safari) or *Install app* (Android/desktop Chrome). |

Installing as an app needs the folder to be served over **https**. Browsers don't allow service workers for files opened from disk.

### Hosting (free options)

- **GitHub Pages:** push this folder to a GitHub repository's `main` branch and set *Settings → Pages → Source* to **GitHub Actions**. The included workflow (`.github/workflows/pages.yml`) runs the tests and publishes on every push. The app appears at `https://<user>.github.io/<repo>/`.
- **Netlify Drop:** drag this folder onto <https://app.netlify.com/drop>.

### Releasing a new version

The app shows its version and update date in the header (the badge next to the title), in the footer and on the race sheet. To release:

1. In `js/app/state.js`, set `APP_VERSION` (major.minor.patch) and `APP_UPDATED` (YYYY-MM-DD).
2. Set the same version in `package.json` and in `VERSION` in `sw.js`. The new cache version is what makes installed copies update.
3. Update the version text in `index.html` (the `<title>`, the header badge and the footer line).
4. Run `npm test`. It fails if any of these disagree.

## Project layout

```
index.html               page markup
css/app.css              styles (light/dark, print sheet)
js/core.js               race engine: no DOM, fully tested (SimCore)
js/history-data.js       built-in club speed history (no names)
js/app/                  page scripts, loaded in this order by index.html:
  state.js                 shared state, helpers, theme, tabs
  race.js                  race setup, grades, what-if, playback
  track.js                 catch snapshots and drawing the track
  tables.js                notifications, live tables, file save/load
  planning.js              after-catch rules, catch risk, planner, race sheet, direction
  library.js               race data, dialogs, library, share links, results import
  course-map.js            GPX course maps and hills
  review.js                post-race review and course history
  ux.js                    undo/redo, grouped tabs, timeline, compact grades, wizard
  startup.js               start-up (must stay last)
sw.js                    offline cache (service worker)
manifest.webmanifest     install metadata
fonts/                   Inter and JetBrains Mono (SIL Open Font License)
icons/                   app icons
tests/core.test.js       engine tests (node:test)
docs/                    sample GPX course, sample results CSV, example race sheet
tests/fixtures/          real MyLaps/Sporthive exports (riders anonymised) used by the tests
tests/ui.smoke.js        browser test of the whole app (Playwright)
build.js                 makes the single-file version in dist/
tools/sporthive-sync.js  weekly Sporthive results update (clubs in tools/sporthive.config.json)
```

## Commands

```bash
npm test          # engine tests (no install needed, Node 18+)
npm run build     # rebuild dist/ single file
npm run test:ui   # browser checks of the served app and the single file (needs Playwright + Chromium)
npm run serve     # local server on http://localhost:8080
```

## Model notes

- Grades ride at steady speeds. Catches on circuits include every on-road meeting: catching a grade that is laps ahead, drawing level, and lapping.
- With *neutralise*, a caught grade stops at the catch and gets no finish time. With *join the bunch*, it rides on at the catchers' speed.
- Catch risk varies each grade's speed uniformly within its range. It uses a fixed random seed, so results are repeatable.
- The planner uses whole-minute starts. It checks every pair of grades at their nominal speeds and, when ranges are allowed for, at the fastest and slowest speed in each range. Under the "final N laps" rule, catches earlier in the race are allowed. With the neutralise or join-the-bunch rules, those earlier catches can change later timings, so check the Catch log after applying a plan.

Predictions are for planning only. They don't account for terrain, weather, crashes or tactics.
