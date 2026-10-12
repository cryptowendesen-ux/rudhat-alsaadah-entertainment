'use strict';
// Terms & Conditions page, and the removal of repeated blocks on the home page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const server = read('server.js');
const index = read('public', 'index.html');
const terms = read('public', 'terms.html');

test('terms page: English and Arabic versions, a language switch, a way back and the WhatsApp contact', () => {
  assert.match(terms, /<article id="en">[\s\S]*Terms &amp; Conditions[\s\S]*<\/article>/);
  assert.match(terms, /<article id="ar" hidden>[\s\S]*\u0627\u0644\u0634\u0631\u0648\u0637 \u0648\u0627\u0644\u0623\u062d\u0643\u0627\u0645[\s\S]*<\/article>/);
  assert.match(terms, /id="langBtn"/);
  assert.match(terms, /id="phoneEn"/);
  assert.match(terms, /id="phoneAr"/);
  assert.match(terms, /href="\/privacy"/);
});

test('terms page: no inline event handlers (the strict page policy would block them) and nothing visible is left to fill in', () => {
  assert.doesNotMatch(terms.replace(/<script[\s\S]*?<\/script>/g, ''), /\son[a-z]+=/);
  const visible = terms.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(visible, /\[(OWNER|TODO|TBD|FILL)[^\]]*\]|lorem ipsum/i);
});

test('terms page: only says what the website already says (no invented prices, hours or fees)', () => {
  const visible = terms.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(visible, /AED\s*\d|\d\s*AED/); // prices come from the website, never typed into the terms
  assert.match(visible, /nothing is paid online/);
  assert.match(visible, /Socks are required/);
});

test('terms page: served at /terms, the raw file redirects there, it is in the sitemap and linked from the footer', () => {
  assert.match(server, /app\.get\('\/terms', \(req, res\) => sendHtmlFile\(res, 'terms\.html'\)\)/);
  assert.match(server, /app\.get\('\/terms\.html', \(req, res\) => res\.redirect\(301, '\/terms'\)\)/);
  assert.match(server, /SITE_URL \+ '\/terms<\/loc>/);
  assert.match(index, /<a href="\/terms">Terms<\/a>/);
  assert.match(index, /'Terms': '\u0627\u0644\u0634\u0631\u0648\u0637 \u0648\u0627\u0644\u0623\u062d\u0643\u0627\u0645'/);
});

test('home page: one closing call to action, and the birthday line that repeated the next paragraph is gone', () => {
  assert.equal((index.match(/class="container cta"/g) || []).length, 0);
  assert.equal((index.match(/Ready to book\?/g) || []).length >= 1, true);
  assert.doesNotMatch(index.split('<script>')[0], /<p>Celebrate with fun, games and happy memories at Rudhat Alsaadah\.<\/p>/);
  assert.doesNotMatch(index.split('<script>')[0], /id="why-us"/);
});

test('home page: hour prices are shown cheapest first, and only when every price has a number', () => {
  assert.match(index, /function byPrice\(list\)/);
  assert.match(index, /if \(isNaN\(priceNum\(list\[i\]\.price\)\)\) return list;/);
});

/* ---------- business e-mail (set in the dashboard, shown at the bottom of the website) ---------- */
const dashboard = read('public', 'admin', 'dashboard.html');
const privacy = read('public', 'privacy.html');

test('business email: a setting the owner can change; empty means it is not shown; a wrong address is refused', () => {
  assert.match(server, /SETTINGS_DEFAULTS = \{[\s\S]*?\n  email: '',/);
  assert.match(server, /CLEARABLE_SETTINGS = \['email',/);
  assert.match(server, /if \(b\.email !== undefined\) \{[\s\S]*?Please enter a valid email address\.[\s\S]*?update\.email = em;/);
  assert.match(server, /if \(st\.email\) ld\.email = st\.email;/); // Google business data
});

test('business email: the dashboard has the field and saves it with the other settings', () => {
  assert.match(dashboard, /id="sEmail" type="email"/);
  assert.match(dashboard, /email:'sEmail'/);
});

test('business email: shown once on the home page, in the footer, only when it is valid - hidden by default', () => {
  assert.equal((index.match(/data-mail-wrap hidden/g) || []).length, 1);
  assert.equal((index.match(/<a data-mail>/g) || []).length, 1);
  const footer = index.slice(index.indexOf('<footer'), index.indexOf('</footer>'));
  assert.match(footer, /data-mail-wrap hidden/);
  assert.match(index, /mailOk = em\.length <= 120 && \/\^\[\^\\s@<>"'\]\+@/);
  assert.match(index, /a\.href = 'mailto:' \+ em;/);
  assert.doesNotMatch(index.split('<script>')[0], /mailto:[a-z]/i); // no address is written into the page itself
});

test('business email: also under the contact line of the terms and privacy pages, in both languages', () => {
  for (const page of [terms, privacy]) {
    assert.match(page, /id="mailEn" hidden/);
    assert.match(page, /id="mailAr" hidden/);
    assert.match(page, /a\.href = 'mailto:' \+ em;/);
  }
});
