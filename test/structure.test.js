'use strict';
/* Project-level checks that need no database or network:
   missing files, undeclared packages, broken inline scripts, dashboard click wiring,
   Arabic coverage of booking messages, and a few regressions that were fixed on purpose. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinModules } = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const server = read('server.js');
const pkg = JSON.parse(read('package.json'));
const htmlFiles = ['public/index.html', 'public/card.html', 'public/privacy.html', 'public/404.html', 'public/admin/index.html', 'public/admin/dashboard.html'];

// all inline <script> blocks of a page (same rule the server uses for its CSP hashes)
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ attrs: m[1], code: m[2] });
  return out;
}

test('every local require() in server.js points to a file that exists', () => {
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m, n = 0;
  while ((m = re.exec(server))) {
    n++;
    const base = path.join(ROOT, m[1]);
    assert.ok([base, base + '.js', path.join(base, 'index.js')].some((p) => fs.existsSync(p)), 'missing file for require(' + m[1] + ')');
  }
  assert.ok(n >= 1, 'expected at least one local require (lib/logic)');
});

test('every package server.js requires is declared in package.json', () => {
  const re = /require\(\s*['"]([^'".\/][^'"]*)['"]\s*\)/g;
  const builtins = new Set(builtinModules.concat(builtinModules.map((b) => 'node:' + b)));
  const deps = Object.keys(pkg.dependencies || {});
  let m;
  while ((m = re.exec(server))) {
    const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
    if (builtins.has(m[1]) || builtins.has(name)) continue;
    assert.ok(deps.includes(name), name + ' is required in server.js but not listed in package.json');
  }
});

test('every name server.js takes from lib/logic is really exported', () => {
  const m = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]\.\/lib\/logic['"]\s*\)/.exec(server);
  assert.ok(m, 'server.js should destructure lib/logic');
  const exported = require('../lib/logic');
  const names = m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
  assert.ok(names.length >= 6);
  for (const n of names) assert.equal(typeof exported[n], 'function', n + ' is imported by server.js but not exported by lib/logic.js');
});

test('package.json has a test script and the lockfile matches the declared dependencies and Node version', () => {
  assert.ok(pkg.scripts && /node --test/.test(pkg.scripts.test), 'npm test must run node --test');
  const lock = JSON.parse(read('package-lock.json'));
  const root = lock.packages[''];
  assert.deepEqual(root.dependencies, pkg.dependencies);
  assert.equal(root.engines && root.engines.node, pkg.engines.node);
  for (const d of Object.keys(pkg.dependencies)) assert.ok(lock.packages['node_modules/' + d], d + ' missing from package-lock.json');
});

test('server.js and every inline script parse without syntax errors', () => {
  new vm.Script(server.replace(/^#!.*/, ''), { filename: 'server.js' });
  for (const f of htmlFiles) {
    const html = read(f);
    inlineScripts(html).forEach((s, i) => {
      if (/ld\+json/i.test(s.attrs)) return JSON.parse(s.code); // structured data must be valid JSON
      assert.doesNotThrow(() => new vm.Script(s.code, { filename: f + '#script' + (i + 1) }), f + ' script ' + (i + 1));
    });
  }
});

test('no page uses inline event attributes (the CSP forbids them)', () => {
  for (const f of htmlFiles) {
    const html = read(f).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const bad = html.match(/\son[a-z]+\s*=\s*["']/gi);
    assert.equal(bad, null, f + ' has inline handlers: ' + bad);
  }
});

test('admin dashboard: every data-click function is allowed and defined', () => {
  const html = read('public/admin/dashboard.html');
  const allowed = JSON.parse(/var ALLOWED = (\[[^\]]*\])/.exec(html)[1].replace(/'/g, '"'));
  const used = new Set();
  const re = /data-click=\\?"([A-Za-z_$][\w$]*)\(/g;
  let m;
  while ((m = re.exec(html))) used.add(m[1]);
  assert.ok(used.size >= 15, 'expected many data-click handlers, found ' + used.size);
  for (const fn of used) assert.ok(allowed.includes(fn), fn + ' is used in data-click but not in ALLOWED');
  for (const fn of allowed) assert.match(html, new RegExp('^(async )?function ' + fn + '\\b', 'm'), fn + ' is allowed but not defined as a global function');
});

test('QR/card page and public pages carry no external script sources', () => {
  for (const f of htmlFiles) assert.doesNotMatch(read(f), /<script[^>]+src\s*=\s*["']https?:/i, f);
});

/* ---------- Arabic coverage of booking messages ---------- */
function loadArabic() {
  const html = read('public/index.html');
  const ar = /var AR = (\{[\s\S]*?\n  \});\n  var RX/.exec(html);
  const rx = /var RX = (\[[\s\S]*?\n  \]);\n  var PH/.exec(html);
  assert.ok(ar && rx, 'could not find the Arabic dictionary in index.html');
  return { AR: vm.runInNewContext('(' + ar[1] + ')'), RX: vm.runInNewContext('(' + rx[1] + ')') };
}
function translate({ AR, RX }, msg) {
  if (AR[msg]) return AR[msg];
  let out = msg;
  RX.forEach((r) => { out = out.replace(r[0], r[1]); });
  return out;
}

test('every fixed booking message the server can send to a visitor has an Arabic translation', () => {
  const dict = loadArabic();
  const start = server.indexOf('const bookingLimit = rateLimit');
  const end = server.indexOf("app.get('/api/availability'");
  assert.ok(start > 0 && end > start);
  const region = server.slice(start, end);
  const msgs = new Set();
  const re = /error:\s*(["'])((?:\\.|(?!\1).)*)\1\s*(?=[}\)])/g;
  let m;
  while ((m = re.exec(region))) msgs.add(m[2].replace(/\\'/g, "'"));
  for (const k of ['passed', 'full', 'busy']) { // slotMessage()
    const r = new RegExp('\\b' + k + ":\\s*'((?:\\\\.|[^'])*)'\\s*[,}\\n]").exec(region);
    assert.ok(r, 'slotMessage ' + k + ' not found');
    msgs.add(r[1].replace(/\\'/g, "'"));
  }
  msgs.delete('Failed to save booking'); // 500: the page falls back to WhatsApp and never shows it
  assert.ok(msgs.size >= 20, 'found only ' + msgs.size + ' messages');
  const missing = [...msgs].filter((x) => !dict.AR[x]);
  assert.deepEqual(missing, [], 'no Arabic translation for: ' + missing.join(' | '));
  for (const x of msgs) assert.match(dict.AR[x], /[\u0600-\u06FF]/);
});

test('booking messages that contain times, days or reasons are translated by the patterns', () => {
  const dict = loadArabic();
  const samples = [
    'We are open 9:00 AM – 9:00 PM on this day. Please choose a time within opening hours.',
    'We are open 2:00 PM – 10:00 PM on Fridays. Please choose a time within opening hours.',
    'Online bookings can be made up to 365 days ahead.',
    'The party must finish before closing time (9:00 PM). Please choose an earlier start time.',
    'We are closed on this date (Eid holiday). Please choose another day.'
  ];
  for (const s of samples) {
    const out = translate(dict, s);
    assert.match(out, /[\u0600-\u06FF]/, s);
    assert.doesNotMatch(out, /Please|choose|open|closing|ahead/i, 'still English: ' + out);
  }
  assert.match(translate(dict, samples[0]), /9:00 ص.*9:00 م/);
  assert.match(translate(dict, samples[4]), /Eid holiday/); // the owner's free-text reason is kept as written
  assert.match(translate(dict, samples[2]), /365/);
});

/* ---------- regressions fixed on purpose ---------- */
test('offline price fallback card escapes the price text before innerHTML', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /<strong>' \+ txt\(/, 'price text must not go into innerHTML unescaped');
  assert.match(html, /String\(txt\('\[data-bind=hourlyPrice\]'[\s\S]{0,120}\.replace\(\/\[&<>/);
});

test('privacy page mentions Cloudflare Turnstile and the 90-day child-data erasure in English and Arabic', () => {
  const html = read('public/privacy.html');
  assert.equal((html.match(/Turnstile/g) || []).length, 2);
  assert.match(html, /erased automatically about 90 days/);
  assert.match(html, /بعد نحو 90 يوماً/);
  assert.match(server, /SENSITIVE_RETENTION_DAYS[\s\S]{0,120}\|\| 90/); // the policy text and the default must agree
});

test('server.js no longer carries the outdated comments', () => {
  assert.doesNotMatch(server, /Run ONE instance/);
  assert.doesNotMatch(server, /dashboard needs inline event attributes/);
});

test('README only promises files that exist', () => {
  const readme = read('README.md');
  for (const f of ['lib/logic.js', 'test/logic.test.js']) if (readme.includes(f)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});
