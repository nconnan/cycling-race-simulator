#!/usr/bin/env node
/*
 * Used by the GitHub workflow. The weekly Sporthive refresh no longer writes to the repository;
 * its latest results are kept in the workflow cache (.sporthive-cache/history-data.js).
 * This picks whichever is newer — the cached copy or the one in the repository — and puts it
 * in js/history-data.js for testing, building and publishing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readHistory } = require('./sporthive-sync.js');

const repoFile = path.join(__dirname, '..', 'js', 'history-data.js');
const cacheFile = path.join(__dirname, '..', '.sporthive-cache', 'history-data.js');
const repo = readHistory(repoFile);
const cached = fs.existsSync(cacheFile) ? readHistory(cacheFile) : null;
const score = h => h ? [String(h.fetched || ''), (h.races || []).length] : ['', -1];
const [rf, rn] = score(repo), [cf, cn] = score(cached);
if (cached && (cf > rf || (cf === rf && cn > rn))) {
  fs.copyFileSync(cacheFile, repoFile);
  console.log(`Using cached club results (${cn} races, ${cf}) over the repository's (${rn} races, ${rf}).`);
} else {
  console.log(`Using the repository's club results (${rn} races, ${rf}).`);
}
