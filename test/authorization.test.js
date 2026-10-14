'use strict';
/* Who may call what.
   1) Route matrix: every /api/admin and /api/auth route in server.js is listed here with the access it must have.
      A new route that is not in the list, or one that lost `auth` / `requireOwner`, fails this test.
   2) The REAL `auth` and `requireOwner` middleware with a fake session store (401 / 403 behaviour).
   3) Staff limits on play cards (top-up cap, re-activating a cancelled card) using the REAL handlers.
   4) The activity log can be read by the owner only and has no route that edits or deletes it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const slice = (a, b) => {
  const i = server.indexOf(a), j = server.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, 'section not found: ' + a);
  return server.slice(i, j);
};

/* ---------- 1) route matrix ---------- */
// 'public' = no sign-in needed, 'staff' = any signed-in person, 'owner' = owner only
const MATRIX = {
  'POST /api/auth/login': 'public',
  'GET /api/auth/me': 'staff',
  'POST /api/auth/logout': 'staff',
  'POST /api/auth/logout-all': 'owner',
  'GET /api/admin/content': 'owner',
  'POST /api/admin/items': 'owner',
  'POST /api/admin/gallery/upload': 'owner',
  'PUT /api/admin/items/:type/:id': 'owner',
  'DELETE /api/admin/items/:type/:id': 'owner',
  'POST /api/admin/items/:type/:id/image': 'owner',
  'DELETE /api/admin/items/:type/:id/image': 'owner',
  'GET /api/admin/package-requests': 'staff',
  'PATCH /api/admin/package-requests/:id': 'staff',
  'DELETE /api/admin/package-requests/:id': 'owner',
  'GET /api/admin/bookings': 'staff',
  'PATCH /api/admin/bookings/:id': 'staff',
  'POST /api/admin/bookings/:id/resend': 'staff',
  'POST /api/admin/bookings/:id/reminded': 'staff',
  'DELETE /api/admin/bookings/:id': 'owner',
  'GET /api/admin/cards': 'staff',
  'POST /api/admin/cards': 'staff',
  'POST /api/admin/cards/:id/use': 'staff',
  'POST /api/admin/cards/:id/topup': 'staff',
  'PATCH /api/admin/cards/:id': 'staff',
  'DELETE /api/admin/cards/:id': 'owner',
  'GET /api/admin/settings': 'staff',
  'PUT /api/admin/settings': 'owner',
  'GET /api/admin/closed-dates': 'staff',
  'POST /api/admin/closed-dates': 'owner',
  'DELETE /api/admin/closed-dates/:date': 'owner',
  'GET /api/admin/staff': 'owner',
  'POST /api/admin/staff': 'owner',
  'PATCH /api/admin/staff/:id': 'owner',
  'DELETE /api/admin/staff/:id': 'owner',
  'GET /api/admin/stats': 'owner',
  'GET /api/admin/2fa': 'owner',
  'POST /api/admin/2fa/setup': 'owner',
  'POST /api/admin/2fa/enable': 'owner',
  'POST /api/admin/2fa/disable': 'owner',
  'GET /api/admin/audit': 'owner',
  'POST /api/admin/backup': 'owner'
};

function routesInServer() {
  const re = /^app\.(get|post|put|patch|delete)\(\s*'(\/api\/(?:admin|auth)[^']*)',\s*([^\n]*)/gm;
  const out = {};
  let m;
  while ((m = re.exec(server))) {
    const mw = m[3].split(/async \(req|\(req, res/)[0];
    const level = /\brequireOwner\b/.test(mw) && /\bauth\b/.test(mw) ? 'owner' : /\bauth\b/.test(mw) ? 'staff' : 'public';
    out[m[1].toUpperCase() + ' ' + m[2]] = { level, mw, order: mw.indexOf('auth') < mw.indexOf('requireOwner') || !/requireOwner/.test(mw) };
  }
  return out;
}

test('every /api/admin and /api/auth route is in the access matrix, with exactly that access', () => {
  const found = routesInServer();
  for (const key of Object.keys(found)) {
    assert.ok(key in MATRIX, 'new route without an entry in the access matrix: ' + key);
    assert.equal(found[key].level, MATRIX[key], key + ' must be "' + MATRIX[key] + '" but its middleware is: ' + found[key].mw);
  }
  for (const key of Object.keys(MATRIX)) assert.ok(key in found, 'route in the matrix but not in server.js: ' + key);
});

test('only the sign-in route is public under /api/admin and /api/auth; auth always runs before requireOwner', () => {
  const found = routesInServer();
  const open = Object.keys(found).filter((k) => found[k].level === 'public');
  assert.deepEqual(open, ['POST /api/auth/login']);
  for (const k of Object.keys(found)) assert.ok(found[k].order, 'requireOwner must come after auth: ' + k);
  assert.ok(Object.keys(found).filter((k) => k.includes('/api/admin/')).every((k) => found[k].level !== 'public'));
});

test('the admin API is mounted behind auth-aware middleware that never caches (no-store) and records changes', () => {
  assert.match(server, /app\.use\('\/api\/admin', noStoreNoIndex\)/);
  assert.match(server, /app\.use\('\/api\/admin', auditMiddleware\)/);
});

/* ---------- 2) the real auth / requireOwner ---------- */
function authHarness(sessions) {
  const code = slice('function token(payload)', '// Staff passwords are stored');
  const ctx = {
    crypto, Buffer, Date, JSON, console: { error() {} },
    SECRET: 'x'.repeat(40),
    AdminSession: { findOne: (q) => ({ lean: async () => sessions.get(q.jti) || null }) }
  };
  return vm.runInNewContext(code + '\n({ token, verify, auth, requireOwner })', ctx);
}
const call = async (mw, req) => {
  const out = { status: 200, body: null, nextCalled: false };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  await mw(req, res, () => { out.nextCalled = true; });
  return out;
};

test('auth: no token, a forged token and an expired token are refused with 401', async () => {
  const sessions = new Map();
  const h = authHarness(sessions);
  assert.equal((await call(h.auth, { headers: {} })).status, 401);
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer abc.def' } })).status, 401);
  const jti = 'j1';
  sessions.set(jti, { role: 'owner', exp: new Date(Date.now() + 60000) });
  const good = h.token({ jti, exp: Date.now() + 60000 });
  const [body, sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ jti, exp: Date.now() + 60000, role: 'owner' })).toString('base64url') + '.' + sig;
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer ' + forged } })).status, 401);
  const expired = h.token({ jti, exp: Date.now() - 1000 });
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer ' + expired } })).status, 401);
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer ' + good } })).nextCalled, true);
});

test('auth: a valid token whose session was deleted (sign-out, staff removed) stops working at once', async () => {
  const sessions = new Map([['j2', { role: 'staff', exp: new Date(Date.now() + 60000) }]]);
  const h = authHarness(sessions);
  const t = h.token({ jti: 'j2', exp: Date.now() + 60000 });
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer ' + t } })).nextCalled, true);
  sessions.delete('j2');
  assert.equal((await call(h.auth, { headers: { authorization: 'Bearer ' + t } })).status, 401);
});

test('auth: the role comes from the stored session, never from the token; a role-less session is only "staff"', async () => {
  const sessions = new Map([
    ['o', { role: 'owner', exp: new Date(Date.now() + 60000) }],
    ['s', { role: 'staff', exp: new Date(Date.now() + 60000), name: 'Lina', staffId: 's1' }],
    ['old', { exp: new Date(Date.now() + 60000) }]
  ]);
  const h = authHarness(sessions);
  const roleOf = async (jti) => {
    const req = { headers: { authorization: 'Bearer ' + h.token({ jti, exp: Date.now() + 60000, role: 'owner' }) } };
    await call(h.auth, req);
    return req.adminRole;
  };
  assert.equal(await roleOf('o'), 'owner');
  assert.equal(await roleOf('s'), 'staff'); // a token that claims role "owner" does not make a staff session an owner
  assert.equal(await roleOf('old'), 'staff');
});

test('requireOwner: staff get 403, the owner passes, a request without a role is refused', async () => {
  const h = authHarness(new Map());
  const staff = await call(h.requireOwner, { adminRole: 'staff' });
  assert.equal(staff.status, 403);
  assert.equal(staff.nextCalled, false);
  assert.equal((await call(h.requireOwner, {})).status, 403);
  assert.equal((await call(h.requireOwner, { adminRole: 'owner' })).nextCalled, true);
});

/* ---------- 3) staff limits on play cards (real handlers) ---------- */
function cardHandlers(card) {
  const handlers = {};
  const calls = { updates: [] };
  const code =
    'const STAFF_MAX_TOPUP_HOURS = 70;\n' +
    slice("app.post('/api/admin/cards/:id/topup'", "app.delete('/api/admin/cards/:id'");
  const ctx = {
    Number, Math, String, Object, Date, console: { error() {} },
    app: { post: (p, _a, h) => { handlers.topup = h; }, patch: (p, _a, h) => { handlers.patch = h; } },
    auth: () => {},
    DATE_RE: /^\d{4}-\d{2}-\d{2}$/, isRealDate: () => true,
    cardJson: (c) => c,
    PlayCard: {
      findOne: () => ({ lean: async () => card, select() { return { lean: async () => card }; } }),
      findOneAndUpdate: async (q, u) => { calls.updates.push(u); return { ...card, ...(u.$set || u) }; }
    }
  };
  vm.runInNewContext(code, ctx);
  const run = async (name, role, params, body) => {
    const out = { status: 200, body: null };
    const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
    await handlers[name]({ adminRole: role, params, body }, res);
    return out;
  };
  return { run, calls };
}

test('play cards: staff can add a normal package, but not more than the cap; the owner can', async () => {
  const { run, calls } = cardHandlers({ id: 'c1', status: 'active', totalMinutes: 60, usedMinutes: 0 });
  assert.equal((await run('topup', 'staff', { id: 'c1' }, { hours: 30 })).status, 200);
  const big = await run('topup', 'staff', { id: 'c1' }, { hours: 71 });
  assert.equal(big.status, 403);
  assert.match(big.body.error, /needs the owner/);
  assert.equal(calls.updates.length, 1); // the refused request changed nothing
  assert.equal((await run('topup', 'owner', { id: 'c1' }, { hours: 500 })).status, 200);
});

test('play cards: invalid top-up amounts are refused for everybody', async () => {
  const { run } = cardHandlers({ id: 'c1', status: 'active', totalMinutes: 60, usedMinutes: 0 });
  for (const hours of [0, -5, 'abc', 1001, '']) {
    assert.equal((await run('topup', 'owner', { id: 'c1' }, { hours })).status, 400, 'hours=' + hours);
  }
});

test('play cards: only the owner can re-activate a cancelled card; staff can still cancel', async () => {
  const cancelled = cardHandlers({ id: 'c2', status: 'cancelled', code: 'ABCD2345' });
  const denied = await cancelled.run('patch', 'staff', { id: 'c2' }, { status: 'active' });
  assert.equal(denied.status, 403);
  assert.equal(cancelled.calls.updates.length, 0);
  assert.equal((await cancelled.run('patch', 'owner', { id: 'c2' }, { status: 'active' })).status, 200);
  const active = cardHandlers({ id: 'c3', status: 'active', code: 'ABCD2345' });
  assert.equal((await active.run('patch', 'staff', { id: 'c3' }, { status: 'cancelled' })).status, 200);
  assert.equal((await active.run('patch', 'staff', { id: 'c3' }, { status: 'active' })).status, 200); // already active: nothing to re-activate
});

/* ---------- 4) activity log ---------- */
test('the activity log can be read by the owner only, and no route edits or deletes it', () => {
  const uses = server.split('\n').filter((l) => /AuditLog\./.test(l));
  const writes = uses.filter((l) => /AuditLog\.(update|delete|remove|find.*(Update|Delete|Remove)|replace|bulkWrite|drop)/.test(l));
  assert.deepEqual(writes, [], 'AuditLog must only be created and read: ' + writes.join(' | '));
  const readers = server.split('\n').filter((l) => /AuditLog\.find\(/.test(l));
  assert.equal(readers.length, 1);
  assert.equal(routesInServer()['GET /api/admin/audit'].level, 'owner');
});

/* ---------- 5) play card balance under parallel requests (real handlers, fake database that applies each update atomically) ---------- */
function concurrentCardHarness(initial) {
  const doc = JSON.parse(JSON.stringify(initial));
  doc.ledger = doc.ledger || [];
  const handlers = {};
  const tick = () => new Promise((r) => setImmediate(r)); // lets other requests run between a read and its update
  const matches = (q) => Object.keys(q).every((k) => doc[k] === q[k]);
  const code =
    'const STAFF_MAX_TOPUP_HOURS = 70;\n' +
    slice('function cardRemaining', 'const cardViewLimit') +
    '\n' + slice("app.post('/api/admin/cards/:id/use'", "app.patch('/api/admin/cards/:id'");
  const ctx = {
    Math, Number, String, Object, Date, console: { error() {} },
    todayInDubai: () => '2026-10-13',
    PUBLIC_LEDGER_NOTES: new Set(),
    app: { post: (p, _a, h) => { handlers[p.endsWith('/use') ? 'use' : 'topup'] = h; } },
    auth: () => {},
    PlayCard: {
      findOne: () => ({ lean: async () => { const snap = JSON.parse(JSON.stringify(doc)); await tick(); return snap; } }),
      findOneAndUpdate: async (q, u) => {
        await tick();
        if (!matches(q)) return null; // somebody changed the balance first
        if (u.$inc) for (const k of Object.keys(u.$inc)) doc[k] = (doc[k] || 0) + u.$inc[k];
        if (u.$push && u.$push.ledger) doc.ledger.push(u.$push.ledger);
        return JSON.parse(JSON.stringify(doc));
      }
    }
  };
  vm.runInNewContext(code, ctx);
  const send = async (name, body) => {
    const out = { status: 200, body: null };
    const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
    await handlers[name]({ adminRole: 'staff', params: { id: doc.id }, body }, res);
    return out;
  };
  return { doc, send };
}

test('play cards: many staff deducting at the same moment can never take more time than the card holds', async () => {
  const { doc, send } = concurrentCardHarness({ id: 'k1', status: 'active', totalMinutes: 60, usedMinutes: 0, expiresAt: '' });
  const results = await Promise.all(Array.from({ length: 8 }, () => send('use', { minutes: 30 })));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(doc.usedMinutes <= doc.totalMinutes, 'used ' + doc.usedMinutes + ' of ' + doc.totalMinutes);
  assert.equal(doc.usedMinutes, ok * 30, 'every accepted request is in the balance, none is lost or counted twice');
  assert.equal(doc.ledger.length, ok);
  assert.ok(ok >= 1 && ok <= 2);
  for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.status, 409);
});

test('play cards: a top-up and deductions at the same moment all end up in the balance', async () => {
  const { doc, send } = concurrentCardHarness({ id: 'k2', status: 'active', totalMinutes: 120, usedMinutes: 0, expiresAt: '' });
  const results = await Promise.all([
    send('use', { minutes: 30 }), send('topup', { hours: 1 }), send('use', { minutes: 30 }), send('topup', { hours: 1 })
  ]);
  const uses = results.filter((r, i) => (i === 0 || i === 2) && r.status === 200).length;
  const tops = results.filter((r, i) => (i === 1 || i === 3) && r.status === 200).length;
  assert.equal(tops, 2, 'top-ups never conflict (they only add)');
  assert.equal(doc.totalMinutes, 120 + tops * 60);
  assert.equal(doc.usedMinutes, uses * 30);
  assert.equal(doc.ledger.length, uses + tops);
});

/* ---------- 6) REQUIRE_OWNER_2FA: the limited "set up two-step first" session ---------- */
function limitedAuth(env, session) {
  const code = slice('function owner2faRequired', '// Owner-only actions');
  const ctx = {
    crypto, Buffer, Date, JSON, console: { error() {} }, SECRET: 'x'.repeat(40),
    process: { env },
    AdminSession: { findOne: () => ({ lean: async () => session }) }
  };
  const h = vm.runInNewContext('function verify(){ return { jti: "j" }; }\n' + code + '\n({ auth })', ctx);
  return async (url) => call(h.auth, { headers: { authorization: 'Bearer t' }, originalUrl: url });
}
const LIMITED = { role: 'owner', limited: true, exp: new Date(Date.now() + 60000) };

test('limited owner session: only the two-step setup, "me" and sign-out work; everything else is 403 with setup2fa', async () => {
  const req = limitedAuth({ REQUIRE_OWNER_2FA: 'true' }, LIMITED);
  for (const ok of ['/api/auth/me', '/api/auth/logout', '/api/admin/2fa', '/api/admin/2fa/setup', '/api/admin/2fa/enable', '/api/admin/2fa?x=1']) {
    assert.equal((await req(ok)).nextCalled, true, ok + ' must work');
  }
  for (const no of ['/api/admin/bookings', '/api/admin/cards', '/api/admin/staff', '/api/admin/backup', '/api/admin/settings',
    '/api/admin/2fa/disable', '/api/auth/logout-all', '/api/admin/2fa/setup/../bookings', '/api/admin/audit']) {
    const r = await req(no);
    assert.equal(r.status, 403, no + ' must be refused');
    assert.equal(r.body.setup2fa, true);
    assert.equal(r.nextCalled, false);
  }
});

test('limited owner session: when the requirement is switched off or the emergency switch is on, the session is a normal one', async () => {
  for (const env of [{}, { REQUIRE_OWNER_2FA: 'true', DISABLE_OWNER_2FA: 'true' }]) {
    const r = await limitedAuth(env, LIMITED)('/api/admin/bookings');
    assert.equal(r.nextCalled, true, JSON.stringify(env));
  }
});

test('turning two-step on closes every other owner session and frees only the current one; it cannot be turned off while required', () => {
  const enable = slice("app.post('/api/admin/2fa/enable'", "app.post('/api/admin/2fa/disable'");
  assert.match(enable, /AdminSession\.deleteMany\(\{ role: 'owner', jti: \{ \$ne: req\.adminJti \} \}\)/);
  assert.match(enable, /AdminSession\.updateOne\(\{ jti: req\.adminJti \}, \{ \$set: \{ limited: false \} \}\)/);
  const disable = slice("app.post('/api/admin/2fa/disable'", '/* ====');
  assert.ok(disable.indexOf('owner2faRequired()') >= 0 && disable.indexOf('owner2faRequired()') < disable.indexOf('OwnerAuth.findOne'));
});
