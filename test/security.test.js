'use strict';
/* Sign-in hardening: (1) the owner's 2-step secret can use its own key (TOTP_ENC_KEY) and old secrets keep working,
   (2) staff sign-ins are limited per e-mail, never for the owner's e-mail.
   These tests run the REAL code taken out of server.js. */
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

const JWT_A = 'a'.repeat(40);
const JWT_B = 'b'.repeat(40);
const KEY_1 = 'k'.repeat(40);

function secrets(env) {
  const key = env.TOTP_ENC_KEY || '';
  const ctx = { crypto, Buffer, process: { env }, TOTP_ENC_KEY_OK: key.length >= 32, TOTP_ENC_KEY: key };
  const code = slice('const totpKeyFrom', '// Five wrong codes block');
  return vm.runInNewContext(code + '\n({ encSecret, decSecret, decSecretMeta })', ctx);
}

test('without TOTP_ENC_KEY nothing changes: the JWT_SECRET key is used', () => {
  const s = secrets({ JWT_SECRET: JWT_A });
  const enc = s.encSecret('JBSWY3DPEHPK3PXP');
  assert.equal(s.decSecret(enc), 'JBSWY3DPEHPK3PXP');
  assert.equal(s.decSecretMeta(enc).legacy, false);
  assert.throws(() => secrets({ JWT_SECRET: JWT_B }).decSecret(enc)); // old behaviour: a new JWT_SECRET cannot read it
});

test('with TOTP_ENC_KEY the secret survives a JWT_SECRET change', () => {
  const before = secrets({ JWT_SECRET: JWT_A, TOTP_ENC_KEY: KEY_1 });
  const enc = before.encSecret('JBSWY3DPEHPK3PXP');
  const after = secrets({ JWT_SECRET: JWT_B, TOTP_ENC_KEY: KEY_1 });
  assert.equal(after.decSecret(enc), 'JBSWY3DPEHPK3PXP');
  assert.equal(after.decSecretMeta(enc).legacy, false);
});

test('a secret saved before TOTP_ENC_KEY existed can still be read, and is flagged for re-saving', () => {
  const old = secrets({ JWT_SECRET: JWT_A }).encSecret('JBSWY3DPEHPK3PXP');
  const now = secrets({ JWT_SECRET: JWT_A, TOTP_ENC_KEY: KEY_1 });
  const meta = now.decSecretMeta(old);
  assert.equal(meta.plain, 'JBSWY3DPEHPK3PXP');
  assert.equal(meta.legacy, true);
  const moved = now.encSecret(meta.plain); // what the sign-in code saves
  assert.equal(now.decSecretMeta(moved).legacy, false);
  assert.equal(secrets({ JWT_SECRET: JWT_B, TOTP_ENC_KEY: KEY_1 }).decSecret(moved), 'JBSWY3DPEHPK3PXP');
});

test('a wrong key or damaged data is refused, not guessed', () => {
  const enc = secrets({ JWT_SECRET: JWT_A, TOTP_ENC_KEY: KEY_1 }).encSecret('JBSWY3DPEHPK3PXP');
  assert.throws(() => secrets({ JWT_SECRET: JWT_B, TOTP_ENC_KEY: 'z'.repeat(40) }).decSecret(enc));
  const parts = enc.split('.'); parts[2] = Buffer.from('tampered-data').toString('base64');
  assert.throws(() => secrets({ JWT_SECRET: JWT_A, TOTP_ENC_KEY: KEY_1 }).decSecret(parts.join('.')));
});

test('a TOTP_ENC_KEY shorter than 32 characters is ignored (and warned about at start-up)', () => {
  const s = secrets({ JWT_SECRET: JWT_A, TOTP_ENC_KEY: 'short' });
  const enc = s.encSecret('JBSWY3DPEHPK3PXP');
  assert.equal(secrets({ JWT_SECRET: JWT_A }).decSecret(enc), 'JBSWY3DPEHPK3PXP'); // same as no key at all
  assert.match(server, /TOTP_ENC_KEY is shorter than 32 characters/);
});

/* ---------- per-account sign-in limit ---------- */
function throttleHelpers() {
  const code = slice('const THROTTLE_MAX', 'const throttleFail');
  return vm.runInNewContext(code + '\n({ THROTTLE_MAX, throttleKey, throttleLocked })', { crypto, Date });
}

test('the limit starts at 10 wrong passwords inside 15 minutes; older ones do not count', () => {
  const { THROTTLE_MAX, throttleLocked } = throttleHelpers();
  const now = Date.now();
  assert.equal(THROTTLE_MAX, 10);
  assert.equal(throttleLocked(null), false);
  assert.equal(throttleLocked({ fails: Array(9).fill(now) }), false);
  assert.equal(throttleLocked({ fails: Array(10).fill(now - 60 * 1000) }), true);
  assert.equal(throttleLocked({ fails: Array(10).fill(now - 16 * 60 * 1000) }), false);
});

test('the stored key is a hash: the e-mail itself is never saved, and it is stable', () => {
  const { throttleKey } = throttleHelpers();
  assert.equal(throttleKey('lina@example.com'), throttleKey('lina@example.com'));
  assert.notEqual(throttleKey('lina@example.com'), throttleKey('omar@example.com'));
  assert.ok(!throttleKey('lina@example.com').includes('lina'));
  assert.match(throttleKey('x'), /^[0-9a-f]{64}$/);
});

/* The real sign-in handler, with a fake database */
function loginHarness(opts = {}) {
  const store = new Map();
  const staffRow = { id: 's1', name: 'Lina', email: 'lina@example.com', passHash: 'h', active: true };
  const helpers = slice('const THROTTLE_MAX', 'const throttleFail');
  const code =
    helpers +
    '\nconst throttleFail = (email) => LoginThrottle.updateOne({ key: throttleKey(email) }, { $push: { fails: { $each: [Date.now()] } } }, { upsert: true });\n' +
    slice('function owner2faRequired', 'const LIMITED_OK') +
    slice("app.post('/api/auth/login'", '// Who am I?');
  let handler = null;
  const sessions = [];
  const ctx = {
    crypto, Date, Math, String, console: { warn() {}, error() {} },
    process: { env: { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'owner-pass', DISABLE_OWNER_2FA: 'true', ...(opts.env || {}) } },
    app: { post: (p, l, h) => { handler = h; } },
    loginLimit: (q, r, n) => n(),
    safeEqual: (a, b) => String(a) === String(b),
    sleep: () => Promise.resolve(),
    DUMMY_HASH_P: Promise.resolve('dummy'),
    verifyPassword: async (pw, hash) => hash === 'h' && pw === 'staff-pass',
    Staff: { findOne: (q) => ({ lean: async () => (q.email === staffRow.email ? staffRow : null) }) },
    OwnerAuth: { findOne: () => ({ lean: async () => opts.ownerAuth || null }) },
    totpCheck: () => 7, decSecretMeta: () => ({ plain: 'x', legacy: false }), totpIsLocked: () => false, totpFail: async () => {},
    claimTotpStep: async () => true, encSecret: (x) => x,
    LoginThrottle: {
      findOne: (q) => ({ lean: async () => store.get(q.key) || null }),
      updateOne: async (q, u) => {
        const d = store.get(q.key) || { fails: [] };
        d.fails.push(...u.$push.fails.$each); store.set(q.key, d);
        return { ok: 1 };
      }
    },
    AdminSession: class { constructor(d) { Object.assign(this, d); } async save() { sessions.push(this); return this; } },
    writeAudit: () => {},
    token: () => 'tok',
    mongoose: {}
  };
  vm.runInNewContext(code, ctx);
  const login = async (email, password, code) => {
    const out = { status: 200, body: null };
    const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
    await handler({ body: { email, password, code }, ip: '1.2.3.4', headers: {} }, res);
    return out;
  };
  return { login, store, sessions };
}

test('real sign-in: 10 wrong staff passwords lock that e-mail, even for the right password, and it is the same for unknown e-mails', async () => {
  const { login } = loginHarness();
  for (let i = 0; i < 10; i++) assert.equal((await login('lina@example.com', 'wrong' + i)).status, 401);
  const locked = await login('lina@example.com', 'staff-pass');
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many failed attempts for this account/);
  for (let i = 0; i < 10; i++) await login('nobody@example.com', 'x' + i);
  assert.equal((await login('nobody@example.com', 'x')).status, 429); // no hint whether the account exists
});

test('real sign-in: a correct staff password works while under the limit, and other accounts are not affected', async () => {
  const { login } = loginHarness();
  for (let i = 0; i < 9; i++) await login('lina@example.com', 'wrong' + i);
  const ok = await login('lina@example.com', 'staff-pass');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'staff');
  for (let i = 0; i < 12; i++) await login('other@example.com', 'bad');
  assert.equal((await login('lina@example.com', 'staff-pass')).status, 200);
});

test('real sign-in: the owner e-mail is never locked by wrong passwords, so nobody can lock the owner out', async () => {
  const { login, store } = loginHarness();
  for (let i = 0; i < 30; i++) assert.equal((await login('owner@example.com', 'wrong' + i)).status, 401);
  assert.equal(store.size, 0); // nothing was recorded for the owner e-mail
  const ok = await login('owner@example.com', 'owner-pass');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'owner');
});

test('the limit is checked before any password work (cheap) and failures are recorded on the failure path only', () => {
  const h = slice("app.post('/api/auth/login'", '// Who am I?');
  assert.ok(h.indexOf('throttleLocked(th)') < h.indexOf('verifyPassword'), 'check must come before the scrypt work');
  assert.equal((h.match(/throttleFail\(email\)/g) || []).length, 1);
  assert.ok(h.indexOf('throttleFail(email)') > h.indexOf('if (!role) {'));
  assert.ok(/LoginThrottle[\s\S]{0,40}expireAfterSeconds|expireAfterSeconds: 86400/.test(server), 'old records expire by themselves');
});

/* REQUIRE_OWNER_2FA: the owner's password alone only opens a "set up two-step first" session */
test('REQUIRE_OWNER_2FA: owner with no two-step yet gets a limited session and is told to set it up', async () => {
  const { login, sessions } = loginHarness({ env: { REQUIRE_OWNER_2FA: 'true', DISABLE_OWNER_2FA: 'false' } });
  const ok = await login('owner@example.com', 'owner-pass');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.setup2fa, true);
  assert.equal(sessions.at(-1).limited, true);
});

test('REQUIRE_OWNER_2FA: with two-step already on and a correct code the session is a normal one; without a code it asks for one', async () => {
  const { login, sessions } = loginHarness({ env: { REQUIRE_OWNER_2FA: 'true', DISABLE_OWNER_2FA: 'false' }, ownerAuth: { enabled: true, secretEnc: 'x', lastStep: 0 } });
  assert.equal((await login('owner@example.com', 'owner-pass')).body.needCode, true);
  const ok = await login('owner@example.com', 'owner-pass', '123456');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.setup2fa, false);
  assert.equal(sessions.at(-1).limited, false);
});

test('REQUIRE_OWNER_2FA: the emergency switch DISABLE_OWNER_2FA still gives the owner a normal session; staff are never limited', async () => {
  const emergency = loginHarness({ env: { REQUIRE_OWNER_2FA: 'true', DISABLE_OWNER_2FA: 'true' } });
  const o = await emergency.login('owner@example.com', 'owner-pass');
  assert.equal(o.body.setup2fa, false);
  assert.equal(emergency.sessions.at(-1).limited, false);
  const normal = loginHarness({ env: { REQUIRE_OWNER_2FA: 'true', DISABLE_OWNER_2FA: 'false' } });
  const st = await normal.login('lina@example.com', 'staff-pass');
  assert.equal(st.status, 200);
  assert.equal(normal.sessions.at(-1).limited, false);
});

test('without REQUIRE_OWNER_2FA nothing changes: the owner gets a normal session', async () => {
  const { login, sessions } = loginHarness({ env: { DISABLE_OWNER_2FA: 'false' } });
  const ok = await login('owner@example.com', 'owner-pass');
  assert.equal(ok.body.setup2fa, false);
  assert.equal(sessions.at(-1).limited, false);
});
