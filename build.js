// Builds dist/Professional_Cycling_Race_Simulator_v11.html: one self-contained file
// (styles, scripts, fonts and icon inlined) that works when opened straight from disk.
// Usage: node build.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = p => fs.readFileSync(path.join(root, p));
const dataUri = (p, type) => `data:${type};base64,${read(p).toString('base64')}`;

function replaceOnce(s, find, repl) {
  const i = s.indexOf(find);
  if (i < 0 || s.indexOf(find, i + 1) >= 0) throw new Error(`build: expected exactly one "${find.slice(0, 60)}"`);
  return s.slice(0, i) + repl + s.slice(i + find.length);
}

let html = read('index.html').toString();
let css = read('css/app.css').toString()
  .replace('url("../fonts/inter-latin.woff2")', `url("${dataUri('fonts/inter-latin.woff2', 'font/woff2')}")`)
  .replace('url("../fonts/jetbrains-mono-latin.woff2")', `url("${dataUri('fonts/jetbrains-mono-latin.woff2', 'font/woff2')}")`);

const script = p => {
  const src = read(p).toString();
  if (/<\/script/i.test(src)) throw new Error(`build: ${p} contains a closing script tag`);
  return `<script>\n${src}\n</script>`;
};

html = replaceOnce(html, '<link rel="stylesheet" href="css/app.css">', `<style>\n${css}\n</style>`);
html = replaceOnce(html, '<script src="js/core.js"></script>', script('js/core.js'));
html = replaceOnce(html, '<script src="js/app.js"></script>', script('js/app.js'));
html = replaceOnce(html, '<link rel="manifest" href="manifest.webmanifest">\n', '');
html = replaceOnce(html, 'href="icons/icon-192.png"', `href="${dataUri('icons/icon-192.png', 'image/png')}"`);
html = replaceOnce(html, 'href="icons/apple-touch-icon.png"', `href="${dataUri('icons/apple-touch-icon.png', 'image/png')}"`);
// No service worker in the single-file build.
html = html.replace(/<script>\s*\/\/ Offline support[\s\S]*?<\/script>\n/, '');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'Professional_Cycling_Race_Simulator_v11.html');
fs.writeFileSync(out, html);
console.log(`Built ${path.relative(root, out)} (${Math.round(html.length / 1024)} KB)`);
