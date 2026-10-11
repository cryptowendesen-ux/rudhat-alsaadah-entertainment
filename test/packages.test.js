'use strict';
// Package cards (hour prices + birthday), optional package photos and package requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const server = read('server.js');
const index = read('public', 'index.html');
const dash = read('public', 'admin', 'dashboard.html');
const privacy = read('public', 'privacy.html');
const region = server.slice(server.indexOf('PACKAGE REQUESTS\n'), server.indexOf('PUBLIC: CREATE BOOKING'));

test('package request: the package name and price come from the database, never from the visitor', () => {
  assert.match(region, /Item\.findOne\(\{ type: 'prices', id: String\(b\.packageId \|\| ''\), published: true \}\)/);
  assert.match(region, /packageTitle: clip\(item\.title, 200\)/);
  assert.doesNotMatch(region, /packageTitle: clip\(b\./);
});

test('package request: hidden trap field, per-connection limits, a site-wide daily cap, no duplicates', () => {
  assert.match(region, /String\(b\.website \|\| ''\)\.trim\(\)\) return res\.status\(201\)/);
  assert.match(region, /app\.post\('\/api\/package-requests', requestLimit, requestDailyLimit/);
  assert.match(region, /REQUESTS_PER_DAY_CAP = 60/);
  assert.match(region, /status: 'new' \}\)\.lean\(\)/); // the same open request is not stored twice
});

test('package requests are erased automatically after 90 days and the owner can export them', () => {
  assert.match(server, /packageRequestSchema\.index\(\{ createdAt: 1 \}, \{ expireAfterSeconds: 90 \* 86400 \}\)/);
  assert.match(server, /PackageRequest\.find\(\{\}\)\.lean\(\)/);
});

test('package photo: only for prices and birthday, only the owner can set or remove it', () => {
  assert.match(server, /PHOTO_OPTIONAL_TYPES = \['prices', 'birthday'\]/);
  assert.match(server, /app\.post\('\/api\/admin\/items\/:type\/:id\/image', auth, requireOwner, handleUpload/);
  assert.match(server, /app\.delete\('\/api\/admin\/items\/:type\/:id\/image', auth, requireOwner/);
});

test('every message the package-request form can show has an Arabic text on the website', () => {
  const msgs = [...region.matchAll(/error: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(msgs.length >= 6, 'found ' + msgs.length);
  const map = index.slice(index.indexOf('var ERR_AR = {'), index.indexOf('var errText'));
  for (const m of msgs) {
    if (/^Failed to|not found|Invalid status|Request not found/.test(m)) continue; // dashboard-only messages
    assert.ok(map.includes("'" + m.replace(/'/g, "\\'") + "'"), 'no Arabic text for: ' + m);
  }
});

test('website: gallery, hour prices and birthday packages are sliders with dots; the sheet exists; no inline handlers', () => {
  assert.match(index, /makeSlider\(gal, \{ card: '\.gallery-card'/);
  assert.match(index, /makeSlider\(document\.getElementById\('pricesList'\), \{ card: '\.pcard'/);
  assert.match(index, /makeSlider\(document\.getElementById\('birthdayPackages'\), \{ card: '\.pcard'/);
  assert.match(index, /id="pkDialog"[\s\S]*?data-pkclose/);
  assert.match(index, /class="prices slider" id="pricesList"/);
  assert.match(index, /class="packages slider" id="birthdayPackages"/);
  assert.doesNotMatch(index.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, ''), /\son(click|change|submit)=/);
});

test('website: the request form never sends a price or title (only the package id)', () => {
  const body = index.slice(index.indexOf("body: JSON.stringify({ packageId"), index.indexOf("body: JSON.stringify({ packageId") + 200);
  assert.doesNotMatch(body, /price|title/);
});

test('website: the card text is escaped before it is put into the page', () => {
  const cardFn = index.slice(index.indexOf('function cardHtml'), index.indexOf('function renderCards'));
  assert.match(cardFn, /esc\(p\.price\)/);
  assert.match(cardFn, /esc\(title\)/);
  assert.doesNotMatch(cardFn, /\+ p\.(title|price|description)\b/);
});

test('dashboard: package requests panel and package photo upload exist and use the new routes', () => {
  assert.match(dash, /id="requestsPanel"/);
  assert.match(dash, /\/api\/admin\/package-requests/);
  assert.match(dash, /\/api\/admin\/items\/\$\{type\}\/\$\{id\}\/image/);
  for (const fn of ['loadRequests', 'setRequestStatus', 'requestToCard']) {
    assert.ok(new RegExp("var ALLOWED = \\[[^\\]]*'" + fn + "'").test(dash), fn + ' is not in ALLOWED');
  }
});

test('privacy page: package requests are mentioned in English and Arabic, with the 90 days', () => {
  assert.match(privacy, /package request[\s\S]{0,200}erased automatically after 90 days/);
  assert.match(privacy, /\u0637\u0644\u0628 \u0627\u0644\u0628\u0627\u0642\u0629[\s\S]{0,200}90/);
  assert.equal((privacy.match(/Turnstile/g) || []).length, 2); // the existing wording is untouched
});
