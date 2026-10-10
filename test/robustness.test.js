'use strict';
/* Failure behaviour: the site must answer (not hang or crash) when the database misbehaves,
   and a two-step code must work only once. These tests run the REAL code taken out of server.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const slice = (a, b) => {
  const i = server.indexOf(a), j = server.indexOf(b, i);
  assert.ok(i >= 0 && j > i, 'section not found: ' + a);
  return server.slice(i, j);
};
const tick = () => new Promise((r) => setImmediate(r));

/* ---------- async route handlers can no longer hang or crash the site ---------- */
function makeApp() {
  const calls = [];
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (...a) => { calls.push([m, ...a]); return 'orig-' + m; };
  vm.runInNewContext(slice('function wrapAsync(h)', 'const PORT'), { app });
  return { app, calls };
}

test('a rejected async handler is passed to next(err) instead of hanging', async () => {
  const { app, calls } = makeApp();
  const boom = new Error('db down');
  app.post('/x', async () => { throw boom; });
  const wrapped = calls[0][2];
  let got = null;
  wrapped({}, {}, (e) => { got = e; });
  await tick();
  assert.equal(got, boom);
});

test('a synchronous throw is passed to next(err) too', () => {
  const { app, calls } = makeApp();
  const boom = new Error('sync');
  app.get('/x', () => { throw boom; });
  let got = null;
  calls[0][2]({}, {}, (e) => { got = e; });
  assert.equal(got, boom);
});

test('a healthy handler still gets (req, res, next) and its result is untouched', async () => {
  const { app, calls } = makeApp();
  const seen = [];
  app.get('/ok', async (req, res, next) => { seen.push(req, res, next); });
  const next = () => {};
  calls[0][2]('REQ', 'RES', next);
  await tick();
  assert.deepEqual(seen, ['REQ', 'RES', next]);
});

test('several middlewares per route are all wrapped; error handlers and arrays are left alone', () => {
  const { app, calls } = makeApp();
  const errHandler = (err, req, res, next) => {};
  const arr = [() => {}];
  app.post('/p', async () => {}, async () => {}, errHandler, arr);
  const [, , a, b, c, d] = calls[0];
  assert.notEqual(a, b);
  assert.equal(typeof a, 'function');
  assert.equal(c, errHandler);
  assert.equal(d, arr);
});

test("app.get('setting') is still a settings lookup, and the original return value is kept", () => {
  const { app, calls } = makeApp();
  assert.equal(app.get('trust proxy'), 'orig-get');
  assert.deepEqual(calls[0], ['get', 'trust proxy']); // no handler argument was added
  assert.equal(app.post('/y', () => {}), 'orig-post');
});

test('the wrapper is installed before the first route is registered', () => {
  const w = server.indexOf('function wrapAsync');
  const first = server.search(/^app\.(get|post|put|patch|delete)\(/m);
  assert.ok(w > 0 && first > w, 'wrapAsync must come before the first app.get/post/...');
});

/* ---------- booking: database trouble gives a clean answer ---------- */
function loadBooking({ create, now } = {}) {
  const log = { inner: 0, deleted: 0 };
  const realNow = Date.now;
  const ctx = vm.createContext({
    crypto, console: { error() {}, log() {} },
    DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    sleep: () => Promise.resolve(),
    BookingLock: {
      create: create || (async () => ({})),
      deleteOne: async () => { log.deleted++; return {}; },
      updateOne: async () => ({ matchedCount: 1 })
    },
    createBookingInner: async (req, res) => { log.inner++; res.status(201).json({ ok: true }); },
    Date: now ? Object.assign(class extends Date {}, { now }) : Date,
    setInterval, clearInterval, Promise, Math, String, Error
  });
  const fns = vm.runInContext(slice('async function withDateLock', 'async function createBookingInner(') + '\n({ createBooking })', ctx);
  return { createBooking: fns.createBooking, log, realNow };
}
function fakeRes() {
  const r = { code: 200, body: null, headersSent: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

test('booking: an unexpected database error answers 500 (it used to hang and crash)', async () => {
  const { createBooking, log } = loadBooking({ create: async () => { throw new Error('connection lost'); } });
  const res = fakeRes();
  await createBooking({ body: { date: '2026-10-10' } }, res); // must resolve, not throw
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'Failed to save booking');
  assert.equal(log.inner, 0);
});

test('booking: a busy day answers 503 after the wait', async () => {
  let t = 0; // first call = start, then jump far past the 8 s deadline
  const { createBooking } = loadBooking({
    create: async () => { const e = new Error('dup'); e.code = 11000; throw e; },
    now: () => (t++ === 0 ? 0 : 99999)
  });
  const res = fakeRes();
  await createBooking({ body: { date: '2026-10-10' } }, res);
  assert.equal(res.code, 503);
  assert.match(res.body.error, /busy/);
});

test('booking: normal flow takes the day lock, runs the booking, then releases the lock', async () => {
  const { createBooking, log } = loadBooking();
  const res = fakeRes();
  await createBooking({ body: { date: '2026-10-10' } }, res);
  assert.equal(res.code, 201);
  assert.equal(log.inner, 1);
  assert.equal(log.deleted, 1);
});

test('booking: a request without a valid date skips the lock and is judged by the booking code', async () => {
  const { createBooking, log } = loadBooking({ create: async () => { throw new Error('must not be called'); } });
  const res = fakeRes();
  await createBooking({ body: { date: 'tomorrow' } }, res);
  assert.equal(log.inner, 1);
  assert.equal(res.code, 201);
});

/* ---------- a two-step code works only once, even with two requests at the same moment ---------- */
function loadClaim(initial) {
  const doc = { key: 'owner', ...initial };
  const matches = (f) => f.key === doc.key && f.$or.some((c) => {
    const v = c.lastStep;
    if ('$lt' in v) return doc.lastStep !== undefined && doc.lastStep < v.$lt;
    if ('$exists' in v) return (doc.lastStep !== undefined) === v.$exists;
    return false;
  });
  const OwnerAuth = {
    updateOne: (filter, update) => new Promise((resolve) => setImmediate(() => { // atomic like MongoDB: check and set in one step
      if (!matches(filter)) return resolve({ matchedCount: 0 });
      Object.assign(doc, update.$set);
      resolve({ matchedCount: 1 });
    }))
  };
  const ctx = vm.createContext({ OwnerAuth });
  const claim = vm.runInContext(slice('async function claimTotpStep', '// Returns the matched 30-second step') + '\nclaimTotpStep', ctx);
  return { claim, doc };
}

test('2FA: a step can be claimed once; the same or an older step is refused afterwards', async () => {
  const { claim, doc } = loadClaim({ lastStep: 5 });
  assert.equal(await claim(10), true);
  assert.equal(doc.lastStep, 10);
  assert.equal(await claim(10), false);
  assert.equal(await claim(9), false);
  assert.equal(await claim(11), true);
});

test('2FA: two requests with the same code at the same moment - exactly one wins', async () => {
  const { claim } = loadClaim({ lastStep: 0 });
  const results = await Promise.all([claim(20), claim(20), claim(20)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('2FA: works when no step was ever stored; failed attempts are cleared on success', async () => {
  const { claim, doc } = loadClaim({ fails: [1, 2, 3] });
  assert.equal(await claim(7), true);
  assert.deepEqual([...doc.fails], []);
});

test('2FA: sign-in and backup both use the one-time claim, and the old unconditional update is gone', () => {
  assert.ok((server.match(/await claimTotpStep\(step\)/g) || []).length >= 2);
  assert.doesNotMatch(server, /updateOne\(\{ key: 'owner' \}, \{ \$set: \{ lastStep: step, fails: \[\] \} \}\)/);
});

/* ---------- safety net and documentation ---------- */
test('stray rejections are logged and the 2FA status route is guarded', () => {
  assert.match(server, /process\.on\('unhandledRejection'/);
  const start = server.indexOf("app.get('/api/admin/2fa'");
  const route = server.slice(start, server.indexOf('\n});', start)); // this route only, not the next one
  assert.match(route, /try \{/);
  assert.match(route, /catch \(err\)/);
});

test('every environment variable server.js reads is documented in the README table', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const used = [...new Set([...server.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
  const missing = used.filter((v) => !new RegExp('^\\|[^\\n]*`' + v + '`', 'm').test(readme));
  assert.deepEqual(missing, [], 'not in the README table: ' + missing.join(', '));
});
