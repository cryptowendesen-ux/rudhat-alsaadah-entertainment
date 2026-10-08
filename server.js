const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

if (!SECRET || SECRET.length < 32) {
  throw new Error('Set JWT_SECRET (32+ chars)');
}

if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
}

if (!MONGODB_URI) {
  throw new Error('Set MONGODB_URI environment variable');
}

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  throw new Error(
    'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET'
  );
}

// Weak secrets only warn (a throw here could take the live site down after a deploy).
if (String(process.env.ADMIN_PASSWORD).length < 12) {
  console.warn('SECURITY: ADMIN_PASSWORD is shorter than 12 characters. Please use a longer password.');
}
if (process.env.ADMIN_PASSWORD === SECRET) {
  console.warn('SECURITY: ADMIN_PASSWORD and JWT_SECRET must not be the same value.');
}

/* =========================================================
   SETTINGS FROM ENVIRONMENT (all optional)
========================================================= */
const envNum = (name, def, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
// A pending request keeps its time slot only this long; after that the slot is free again.
const PENDING_HOLD_HOURS = envNum('PENDING_HOLD_HOURS', 24, 1, 720);
// Online bookings must start at least this many hours from now (0 = no minimum).
const MIN_LEAD_HOURS = envNum('BOOKING_MIN_LEAD_HOURS', 3, 0, 168);
const MAX_DAYS_AHEAD = envNum('BOOKING_MAX_DAYS_AHEAD', 365, 1, 730);
// Upcoming (pending/confirmed) requests one phone number may have at the same time.
const MAX_ACTIVE_PER_PHONE = envNum('MAX_ACTIVE_PER_PHONE', 3, 1, 50);
// Cloudflare Turnstile (free captcha). Both values are needed to switch it on.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const turnstileOn = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET);

/* =========================================================
   CLOUDINARY CONFIG
========================================================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* =========================================================
   IMAGE UPLOAD CONFIG (MULTER)
========================================================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (!file.mimetype || !allowedTypes.includes(file.mimetype.toLowerCase())) {
      return cb(new Error('Only JPG, JPEG, PNG, and WebP images are allowed'));
    }
    cb(null, true);
  }
});

// JPEG, PNG or WebP by their first bytes (the browser-reported type can be faked)
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return jpeg || png || webp;
}

function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image size exceeds 10MB limit' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (req.file && !looksLikeImage(req.file.buffer)) {
      return res.status(400).json({ error: 'This file is not a valid JPG, PNG or WebP image' });
    }
    next();
  });
}

/* =========================================================
   MONGODB SCHEMA
========================================================= */
const itemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    type: {
      type: String,
      required: true,
      enum: ['services', 'prices', 'gallery', 'birthday', 'hero', 'about', 'info']
    },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    titleAr: { type: String, default: '' },
    descriptionAr: { type: String, default: '' },
    price: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    publicId: { type: String, default: '' },
    published: { type: Boolean, default: true },
    featured: { type: Boolean, default: false }
  },
  { timestamps: true }
);

const Item = mongoose.model('Item', itemSchema);

/* =========================================================
   BOOKINGS + SETTINGS SCHEMAS
========================================================= */
const bookingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 100 },
    phone: { type: String, required: true, maxlength: 30 },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:MM (24h)
    children: { type: Number, required: true, min: 1, max: 100 },
    message: { type: String, default: '', maxlength: 1000 },
    packagePrice: { type: String, default: '' },
    packageName: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'pending'
    },
    // Owner e-mail notification: pending -> sent | failed (retried automatically) | skipped (mail not configured)
    notifyStatus: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
    notifyAttempts: { type: Number, default: 0 },
    notifyError: { type: String, default: '', maxlength: 300 },
    // Parent/guardian declaration collected on the booking form
    childName: { type: String, default: '', maxlength: 100 },
    childAge: { type: Number, min: 0, max: 17 },
    allergies: { type: String, default: '', maxlength: 500 },
    waiverAccepted: { type: Boolean, default: false },
    waiverAt: { type: Date },
    // Set when staff tapped "reminder sent" (WhatsApp reminder the day before)
    reminderSentAt: { type: Date }
  },
  { timestamps: true }
);
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ date: 1, status: 1 });
bookingSchema.index({ phone: 1, date: 1 });
const Booking = mongoose.model('Booking', bookingSchema);

/* ---- Play cards: prepaid hour packages (balance kept in minutes) ---- */
const cardSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 100 },
    childName: { type: String, default: '', maxlength: 100 },
    phone: { type: String, default: '', maxlength: 30 },
    packageTitle: { type: String, default: '', maxlength: 100 },
    price: { type: String, default: '', maxlength: 40 },
    totalMinutes: { type: Number, required: true, min: 1 },
    usedMinutes: { type: Number, default: 0, min: 0 },
    expiresAt: { type: String, default: '' }, // YYYY-MM-DD or '' (no expiry)
    note: { type: String, default: '', maxlength: 300 },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    ledger: [
      {
        at: { type: Date, default: Date.now },
        minutes: Number, // negative = time used, positive = time added
        note: { type: String, default: '', maxlength: 200 }
      }
    ]
  },
  { timestamps: true }
);
const PlayCard = mongoose.model('PlayCard', cardSchema);

/* ---- Admin sessions: a token only works while its session exists (logout / log out everywhere) ---- */
const adminSessionSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  exp: { type: Date, required: true },
  ip: { type: String, default: '' },
  ua: { type: String, default: '' },
  role: { type: String, default: 'owner' }, // 'owner' (full access) or 'staff' (bookings + play cards only)
  staffId: { type: String, default: '' },
  name: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
adminSessionSchema.index({ exp: 1 }, { expireAfterSeconds: 0 }); // MongoDB removes expired sessions itself
const AdminSession = mongoose.model('AdminSession', adminSessionSchema);

/* ---- Staff accounts (the owner signs in with ADMIN_EMAIL / ADMIN_PASSWORD from the environment) ---- */
const staffSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, maxlength: 120 },
    passHash: { type: String, required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);
const Staff = mongoose.model('Staff', staffSchema);

/* ---- Days the centre is closed (holidays, maintenance, private events) ---- */
const closedDateSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    reason: { type: String, default: '', maxlength: 120 },
    reasonAr: { type: String, default: '', maxlength: 120 }
  },
  { timestamps: true }
);
const ClosedDate = mongoose.model('ClosedDate', closedDateSchema);

/* ---- Anonymous daily counters (no cookies, no personal data): visits, WhatsApp taps, ... ---- */
const statSchema = new mongoose.Schema({
  day: { type: String, required: true }, // YYYY-MM-DD (Dubai)
  event: { type: String, required: true },
  n: { type: Number, default: 0 }
});
statSchema.index({ day: 1, event: 1 }, { unique: true });
const Stat = mongoose.model('Stat', statSchema);

/* ---- Activity log (who did what); entries are deleted automatically after 180 days ---- */
const auditSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  actor: { type: String, default: '' },
  role: { type: String, default: '' },
  action: { type: String, default: '' },
  target: { type: String, default: '' },
  detail: { type: String, default: '' },
  ip: { type: String, default: '' },
  ok: { type: Boolean, default: true }
});
auditSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 86400 });
const AuditLog = mongoose.model('AuditLog', auditSchema);

/* ---- Owner two-step verification (TOTP, works with Google Authenticator / Authy / Microsoft Authenticator) ---- */
const ownerAuthSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  secretEnc: { type: String, default: '' },
  enabled: { type: Boolean, default: false },
  lastStep: { type: Number, default: 0 }
});
const OwnerAuth = mongoose.model('OwnerAuth', ownerAuthSchema);

/* ---- Short lock per booking day: stops two server instances taking the same time slot ---- */
const bookingLockSchema = new mongoose.Schema({
  _id: { type: String },
  token: { type: String },
  expiresAt: { type: Date }
});
bookingLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const BookingLock = mongoose.model('BookingLock', bookingLockSchema);

const SETTINGS_DEFAULTS = {
  whatsapp: '971585187788',
  displayPhone: '+971 58 518 7788',
  weekdayOpen: '09:00',
  weekdayClose: '21:00',
  fridayOpen: '14:00',
  fridayClose: '22:00',
  instagram: '',
  tiktok: '',
  reviewUrl: '',
  mapUrl: 'https://maps.app.goo.gl/cr9KgWa9pnrv2HNLA',
  partyMinutes: 180,
  maxParallel: 1,
  maxPerDay: 5,
  bannerText: '',
  bannerTextAr: '',
  bannerUntil: ''
};
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    whatsapp: String,
    displayPhone: String,
    weekdayOpen: String,
    weekdayClose: String,
    fridayOpen: String,
    fridayClose: String,
    instagram: String,
    tiktok: String,
    reviewUrl: String,
    mapUrl: String,
    partyMinutes: Number,
    maxParallel: Number,
    maxPerDay: Number,
    bannerText: String,
    bannerTextAr: String,
    bannerUntil: String
  },
  { timestamps: true }
);
const Settings = mongoose.model('Settings', settingsSchema);

// These may be emptied by the admin (e.g. remove the Instagram link); every other field falls back to its default when empty.
const CLEARABLE_SETTINGS = ['instagram', 'tiktok', 'reviewUrl', 'bannerText', 'bannerTextAr', 'bannerUntil'];
async function getSettings() {
  const doc = await Settings.findOne({ key: 'main' }).lean();
  const out = { ...SETTINGS_DEFAULTS };
  if (doc) {
    Object.keys(SETTINGS_DEFAULTS).forEach((k) => {
      const v = doc[k];
      if (CLEARABLE_SETTINGS.includes(k) ? v !== undefined && v !== null : v) out[k] = v;
    });
  }
  return out;
}

/* =========================================================
   DEFAULT DATA
========================================================= */
const defaults = {
  services: [
    ['Art & Coloring', 'Creative drawing and coloring time.'],
    ['Zumba & Dancing', 'Music, movement and energetic fun.'],
    ['Educational Games', 'Play-based learning for curious minds.'],
    ['Skill Development', 'Activities that encourage new skills.'],
    ['Clean & Safe', 'A welcoming environment with a professional team.']
  ].map(([title, description], i) => ({
    id: 'svc' + i,
    type: 'services',
    title,
    description,
    published: true
  })),

  prices: [
    ['Per Hour', 'AED 20', '1 hour of play'],
    ['30 Hours', 'AED 520', 'Great value'],
    ['42 Hours', 'AED 620', 'More playtime'],
    ['64 Hours', 'AED 800', 'Best for regular visits'],
    ['UNLIMITED HOURS', 'AED 1,400', 'For maximum flexibility']
  ].map(([title, price, description], i) => ({
    id: 'p' + i,
    type: 'prices',
    title,
    price,
    description,
    published: true
  })),

  gallery: [],

  birthday: [
    {
      id: 'b1',
      type: 'birthday',
      title: 'Birthday Package',
      price: 'AED 300',
      description: 'Birthday enquiries via WhatsApp.',
      published: true
    }
  ]
};

/* =========================================================
   CONNECT TO MONGODB
========================================================= */
mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB Atlas successfully.');
    const count = await Item.countDocuments();
    if (count === 0) {
      const initialItems = [
        ...defaults.services,
        ...defaults.prices,
        ...defaults.gallery,
        ...defaults.birthday
      ];
      await Item.insertMany(initialItems);
      console.log('Default content seeded to MongoDB database.');
    }
    await Settings.updateOne(
      { key: 'main' },
      { $setOnInsert: SETTINGS_DEFAULTS },
      { upsert: true }
    );
  })
  .catch((err) => console.error('MongoDB Connection Error:', err));

/* =========================================================
   AUTHENTICATION HELPERS
========================================================= */
function token(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');

  return body + '.' + signature;
}

function verify(t) {
  try {
    if (!t) return null;
    const parts = t.split('.');
    if (parts.length !== 2) return null;

    const [body, signature] = parts;
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(body)
      .digest('base64url');

    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp <= Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

async function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = verify(t);
    if (!payload || !payload.jti) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const session = await AdminSession.findOne({ jti: payload.jti }).lean();
    if (!session || new Date(session.exp).getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.adminJti = payload.jti;
    req.adminRole = session.role || 'owner'; // sessions created before staff accounts existed belong to the owner
    req.adminName = session.name || '';
    req.adminStaffId = session.staffId || '';
    next();
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
}

// Owner-only actions (website content, settings, staff, statistics, deleting data)
function requireOwner(req, res, next) {
  if (req.adminRole !== 'owner') return res.status(403).json({ error: 'Only the owner can do this.' });
  next();
}

// Staff passwords are stored as salted scrypt hashes, never in plain text
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function verifyPassword(pw, stored) {
  try {
    const [alg, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex')); // used so unknown e-mails take the same time

/* ---- Two-step verification helpers (RFC 6238 TOTP, SHA-1, 6 digits, 30 s) ---- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(str) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(str).toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const o = h[19] & 15;
  const num = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(num % 1000000).padStart(6, '0');
}
// Returns the matched 30-second step (> 0) or 0. A code can be used once (steps <= lastStep are refused).
function totpCheck(secretB32, code, lastStep) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const sec = b32dec(secretB32);
  const now = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) {
    const step = now + w;
    if (step <= lastStep) continue;
    if (safeEqual(hotp(sec, step), c)) return step;
  }
  return 0;
}
// The TOTP secret is stored encrypted (AES-256-GCM) with a key derived from JWT_SECRET
const totpKey = () => crypto.createHash('sha256').update('rudhat-totp:' + process.env.JWT_SECRET).digest();
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', totpKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decSecret(stored) {
  const [iv, tag, enc] = String(stored).split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', totpKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
// Five wrong codes block code entry for 15 minutes (the password alone is never enough)
const totpFails = [];
function totpLocked() {
  const cut = Date.now() - 15 * 60 * 1000;
  while (totpFails.length && totpFails[0] < cut) totpFails.shift();
  return totpFails.length >= 5;
}

/* =========================================================
   RESPONSE HELPERS
========================================================= */
// Cloudinary delivery optimisation for the PUBLIC site only:
// f_auto = best format (WebP/AVIF), q_auto = smart compression, w_1400 = max width.
// The original upload stays untouched (admin still sees it).
function optimizeImageUrl(url) {
  const u = String(url || '');
  if (!u.includes('res.cloudinary.com') || !u.includes('/image/upload/')) return u;
  return u.replace('/image/upload/', '/image/upload/f_auto,q_auto,w_1400,c_limit/');
}

function publicItemJson(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    titleAr: item.titleAr || '',
    descriptionAr: item.descriptionAr || '',
    price: item.price,
    imageUrl: optimizeImageUrl(item.imageUrl),
    published: item.published,
    featured: !!item.featured
  };
}

function adminItemJson(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    titleAr: item.titleAr || '',
    descriptionAr: item.descriptionAr || '',
    price: item.price,
    imageUrl: item.imageUrl || '',
    publicId: item.publicId || '',
    published: item.published,
    featured: !!item.featured
  };
}

/* =========================================================
   INPUT HELPERS
========================================================= */
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const toBool = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
};
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a == null ? '' : a)).digest(),
    crypto.createHash('sha256').update(String(b == null ? '' : b)).digest()
  );

/* =========================================================
   MIDDLEWARE
========================================================= */
app.disable('x-powered-by');
// Behind Render's proxy: without this every visitor shares ONE IP for rate limits.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Content-Security-Policy: the site loads scripts/styles from itself (inline blocks included),
// fonts from Google Fonts and photos from Cloudinary. Everything else is blocked.
const CF_HOST = turnstileOn ? ' https://challenges.cloudflare.com' : '';
const cspFor = (scriptHashes, attrInline) => [
  "default-src 'self'",
  // inline <script> blocks run only if their SHA-256 hash is listed here (computed from the exact page we send)
  "script-src 'self'" + (scriptHashes.length ? ' ' + scriptHashes.join(' ') : '') + CF_HOST,
  // inline event attributes (onclick=...) are off everywhere except the admin dashboard
  attrInline ? "script-src-attr 'unsafe-inline'" : "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://res.cloudinary.com",
  "media-src 'self' blob:",
  "connect-src 'self'" + CF_HOST,
  'frame-src ' + (turnstileOn ? 'https://challenges.cloudflare.com' : "'none'"),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests'
].join('; ');
const CSP = cspFor([], false); // default for API answers and files without inline scripts

function inlineScriptHashes(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/type\s*=\s*["']?application\/ld\+json/i.test(m[1])) continue; // data block, never executed
    const text = m[2].replace(/\r\n?/g, '\n'); // browsers normalise line breaks before hashing
    if (!text.trim()) continue;
    out.push("'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'");
  }
  return out;
}
const pageCsp = (html, attrInline) => cspFor(inlineScriptHashes(html), !!attrInline);
const htmlFileCache = new Map();
const homeCsp = new Map();
function sendHtmlFile(res, rel, opts = {}) {
  let c = htmlFileCache.get(rel);
  if (!c) {
    const html = fs.readFileSync(path.join(__dirname, 'public', rel), 'utf8');
    c = { html, csp: pageCsp(html, opts.attrInline) };
    htmlFileCache.set(rel, c);
  }
  if (opts.status) res.status(opts.status);
  if (opts.headers) res.set(opts.headers);
  res.set('Content-Security-Policy', c.csp);
  res.type('html').send(c.html);
}
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  // camera is only needed by the admin QR scanner (same origin); everything else is off
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});
// Admin pages and admin/auth API: never cached, never indexed
const noStoreNoIndex = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
};
const AUDIT_LABELS = {
  'POST /api/admin/items': 'Created website item',
  'PUT /api/admin/items/:type/:id': 'Edited website item',
  'DELETE /api/admin/items/:type/:id': 'Deleted website item',
  'POST /api/admin/gallery/upload': 'Uploaded a photo',
  'PATCH /api/admin/bookings/:id': 'Changed booking status',
  'POST /api/admin/bookings/:id/resend': 'Re-sent booking e-mail',
  'POST /api/admin/bookings/:id/reminded': 'Marked reminder as sent',
  'DELETE /api/admin/bookings/:id': 'Deleted a booking',
  'POST /api/admin/cards': 'Created a play card',
  'POST /api/admin/cards/:id/use': 'Used card hours',
  'POST /api/admin/cards/:id/topup': 'Topped up a card',
  'PATCH /api/admin/cards/:id': 'Edited a play card',
  'DELETE /api/admin/cards/:id': 'Deleted a play card',
  'PUT /api/admin/settings': 'Changed settings',
  'POST /api/admin/closed-dates': 'Closed a day',
  'DELETE /api/admin/closed-dates/:date': 'Re-opened a day',
  'POST /api/admin/staff': 'Created a staff account',
  'PATCH /api/admin/staff/:id': 'Changed a staff account',
  'DELETE /api/admin/staff/:id': 'Deleted a staff account',
  'POST /api/admin/2fa/enable': 'Turned on two-step verification',
  'POST /api/admin/2fa/disable': 'Turned off two-step verification',
  'POST /api/auth/logout': 'Signed out',
  'POST /api/auth/logout-all': 'Signed out all devices'
};
const AUDIT_BODY_KEYS = ['status', 'minutes', 'hours', 'note', 'active', 'type', 'title', 'date', 'reason', 'name', 'email', 'holder'];
function writeAudit(entry) {
  AuditLog.create(entry).catch((err) => console.error('Audit write failed:', err.message));
}
// Records every successful change made in the admin area (never passwords or tokens)
function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400 || !req.adminRole) return;
      const key = req.method + ' ' + (req.route ? req.route.path : req.path);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const detail = AUDIT_BODY_KEYS.filter((k) => body[k] !== undefined && typeof body[k] !== 'object')
        .map((k) => k + '=' + String(body[k]).slice(0, 60)).join('; ');
      writeAudit({
        actor: req.adminName || 'Owner',
        role: req.adminRole,
        action: AUDIT_LABELS[key] || key,
        target: String(req.params.id || req.params.date || '').slice(0, 60),
        detail,
        ip: String(req.ip || '').slice(0, 60)
      });
    } catch (e) {
      console.error('Audit middleware error:', e.message);
    }
  });
  next();
}

app.use('/admin', noStoreNoIndex);
app.use('/api/admin', noStoreNoIndex);
app.use('/api/auth', noStoreNoIndex);
app.use('/api/admin', auditMiddleware);
app.use('/api/auth', auditMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
// Only FAILED sign-ins count toward the limit (the owner is never locked out by successful logins)
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed attempts. Please try again in 15 minutes.' }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   HEALTH CHECK
========================================================= */
const dbUp = () => mongoose.connection.readyState === 1;
// Liveness: the server process is running (use this for the hosting health check).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'rudhat-alsaadah-api', db: dbUp() ? 'up' : 'down' });
});
// Readiness: the database is connected too (503 when it is not).
app.get('/api/ready', (req, res) => {
  const up = dbUp();
  res.status(up ? 200 : 503).set('Cache-Control', 'no-store').json({ ok: up, db: up ? 'up' : 'down' });
});
// Tells the booking form whether to show the security check.
app.get('/api/captcha-config', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ enabled: turnstileOn, siteKey: turnstileOn ? TURNSTILE_SITE_KEY : '' });
});

/* =========================================================
   PUBLIC CONTENT
========================================================= */
app.get('/api/content', async (req, res) => {
  try {
    const items = await Item.find({ published: true }).sort({ createdAt: 1 }).lean();
    const result = { services: [], prices: [], gallery: [], birthday: [], hero: [], about: [], info: [] };

    items.forEach((item) => {
      if (result[item.type]) {
        result[item.type].push(publicItemJson(item));
      }
    });

    result.settings = await getSettings();
    // The announcement banner switches itself off after its last day
    if (result.settings.bannerUntil && result.settings.bannerUntil < todayInDubai()) {
      result.settings.bannerText = '';
      result.settings.bannerTextAr = '';
    }
    const closed = await ClosedDate.find({ date: { $gte: todayInDubai() } }).sort({ date: 1 }).limit(200).lean();
    result.closedDates = closed.map((c) => ({ date: c.date, reason: c.reason || '', reasonAr: c.reasonAr || '' }));
    res.json(result);
  } catch (err) {
    console.error('Public content error:', err);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

/* =========================================================
   ADMIN LOGIN
========================================================= */
app.post('/api/auth/login', loginLimit, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const ownerOk =
      safeEqual(email, String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) &&
      safeEqual(password, process.env.ADMIN_PASSWORD);

    let role = '';
    let staff = null;
    if (ownerOk) {
      role = 'owner';
    } else {
      staff = await Staff.findOne({ email, active: true }).lean();
      const okPw = verifyPassword(password, staff ? staff.passHash : DUMMY_HASH);
      if (staff && okPw) role = 'staff';
    }
    // Owner two-step verification (switch off in an emergency with DISABLE_OWNER_2FA=true in Render)
    if (role === 'owner' && process.env.DISABLE_OWNER_2FA !== 'true') {
      const oa = await OwnerAuth.findOne({ key: 'owner', enabled: true }).lean();
      if (oa) {
        const code = String((req.body && req.body.code) || '').trim();
        if (!code) return res.json({ needCode: true });
        if (totpLocked()) return res.status(429).json({ error: 'Too many wrong codes. Please wait 15 minutes.' });
        let step = 0;
        try { step = totpCheck(decSecret(oa.secretEnc), code, oa.lastStep || 0); }
        catch (e) { console.error('2FA decrypt error (did JWT_SECRET change?):', e.message); }
        if (!step) {
          totpFails.push(Date.now());
          writeAudit({ actor: 'Owner', role: 'owner', action: 'Wrong 2-step code', ip: String(req.ip || '').slice(0, 60), ok: false });
          await sleep(600);
          return res.status(401).json({ error: 'Invalid code' });
        }
        await OwnerAuth.updateOne({ key: 'owner' }, { $set: { lastStep: step } });
      }
    }
    if (!role) {
      console.warn('Failed admin sign-in from ' + req.ip);
      writeAudit({ actor: email.slice(0, 60), role: '', action: 'Failed sign-in', ip: String(req.ip || '').slice(0, 60), ok: false });
      await sleep(600); // slows down guessing
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const jti = crypto.randomUUID();
    const exp = Date.now() + 8 * 60 * 60 * 1000;
    await new AdminSession({
      jti,
      exp: new Date(exp),
      ip: String(req.ip || '').slice(0, 60),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      role,
      staffId: staff ? staff.id : '',
      name: staff ? staff.name : 'Owner'
    }).save();

    writeAudit({ actor: staff ? staff.name : 'Owner', role, action: 'Signed in', ip: String(req.ip || '').slice(0, 60) });
    res.json({ token: token({ email, jti, exp }), role, name: staff ? staff.name : 'Owner' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Sign-in failed. Please try again.' });
  }
});

// Who am I? (the dashboard hides what the person is not allowed to use)
app.get('/api/auth/me', auth, (req, res) => {
  res.json({ role: req.adminRole, name: req.adminName || (req.adminRole === 'owner' ? 'Owner' : '') });
});

// Sign out this device (the token stops working immediately)
app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    await AdminSession.deleteOne({ jti: req.adminJti });
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to sign out' });
  }
});

// Sign out every device (use it if a phone is lost or the password was shared)
app.post('/api/auth/logout-all', auth, requireOwner, async (req, res) => {
  try {
    await AdminSession.deleteMany({});
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Failed to sign out all devices' });
  }
});

/* =========================================================
   ADMIN CONTENT
========================================================= */
app.get('/api/admin/content', auth, requireOwner, async (req, res) => {
  try {
    const items = await Item.find().sort({ createdAt: 1 }).lean();
    const result = { services: [], prices: [], gallery: [], birthday: [], hero: [], about: [], info: [] };

    items.forEach((item) => {
      if (result[item.type]) {
        result[item.type].push(adminItemJson(item));
      }
    });

    res.json(result);
  } catch (err) {
    console.error('Admin content error:', err);
    res.status(500).json({ error: 'Failed to fetch admin content' });
  }
});

/* =========================================================
   CREATE NORMAL ADMIN ITEM (SERVICES / PRICES / BIRTHDAY)
========================================================= */
app.post('/api/admin/items', auth, requireOwner, async (req, res) => {
  try {
    const { type, title, description = '', price = '', published = true, featured = false, titleAr = '', descriptionAr = '' } = req.body || {};

    if (
      !['services', 'prices', 'gallery', 'birthday', 'hero', 'about', 'info'].includes(type) ||
      !String(title || '').trim()
    ) {
      return res.status(400).json({ error: 'Invalid type/title' });
    }

    if (IMAGE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Use the gallery upload endpoint for images' });
    }

    const newItem = new Item({
      id: crypto.randomUUID(),
      type,
      title: clip(title, 200).trim(),
      description: clip(description, 1000),
      titleAr: clip(titleAr, 200).trim(),
      descriptionAr: clip(descriptionAr, 1000),
      price: clip(price, 100),
      published: toBool(published, true),
      featured: type === 'prices' ? toBool(featured, false) : false
    });

    await newItem.save();
    res.status(201).json(adminItemJson(newItem));
  } catch (err) {
    console.error('Create item error:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

/* =========================================================
   CLOUDINARY UPLOAD HELPER
========================================================= */
const IMAGE_TYPES = ['gallery', 'hero', 'about'];

function uploadToCloudinary(buffer, folderName = 'gallery') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'rudhat-alsaadah/' + folderName,
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/* =========================================================
   GALLERY IMAGE UPLOAD
========================================================= */
app.post('/api/admin/gallery/upload', auth, requireOwner, handleUpload, async (req, res) => {
  let uploadedPublicId = '';

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image file' });
    }

    const title =
      String(req.body?.title || '').trim() || path.parse(req.file.originalname).name;
    const description = String(req.body?.description || '');
    const titleAr = clip(req.body?.titleAr || '', 200).trim();
    const descriptionAr = clip(req.body?.descriptionAr || '', 1000);
    const published =
      req.body?.published === undefined
        ? true
        : req.body.published === true || req.body.published === 'true';

    const imgType = IMAGE_TYPES.includes(req.body?.type) ? req.body.type : 'gallery';

    const cloudResult = await uploadToCloudinary(req.file.buffer, imgType);
    uploadedPublicId = cloudResult.public_id || '';

    const newItem = new Item({
      id: crypto.randomUUID(),
      type: imgType,
      title: title.substring(0, 200),
      description: description.substring(0, 1000),
      titleAr,
      descriptionAr,
      imageUrl: cloudResult.secure_url,
      publicId: cloudResult.public_id,
      published
    });

    try {
      await newItem.save();
    } catch (dbError) {
      if (uploadedPublicId) {
        try {
          await cloudinary.uploader.destroy(uploadedPublicId, { resource_type: 'image' });
        } catch (cleanupError) {
          console.error('Cloudinary cleanup error:', cleanupError);
        }
      }
      throw dbError;
    }

    // Hero / About hold ONE photo: the new upload replaces the old one.
    if (imgType !== 'gallery') {
      try {
        const olds = await Item.find({ type: imgType, id: { $ne: newItem.id } });
        for (const old of olds) {
          if (old.publicId) {
            try {
              await cloudinary.uploader.destroy(old.publicId, { resource_type: 'image' });
            } catch (e) {
              console.error('Old ' + imgType + ' image cleanup error:', e.message);
            }
          }
          await Item.deleteOne({ id: old.id });
        }
      } catch (e) {
        console.error('Replace ' + imgType + ' photo error:', e.message);
      }
    }

    res.status(201).json(adminItemJson(newItem));
  } catch (err) {
    console.error('Gallery upload error:', err);
    res.status(500).json({ error: 'Failed to upload gallery image' });
  }
});

/* =========================================================
   UPDATE ADMIN ITEM
========================================================= */
app.put('/api/admin/items/:type/:id', auth, requireOwner, async (req, res) => {
  try {
    const { type, id } = req.params;
    const item = await Item.findOne({ type, id });

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const b = req.body || {};
    if (b.title !== undefined) {
      const t = clip(b.title, 200).trim();
      if (!t) return res.status(400).json({ error: 'Title is required' });
      item.title = t;
    }
    if (b.description !== undefined) item.description = clip(b.description, 1000);
    if (b.titleAr !== undefined) item.titleAr = clip(b.titleAr, 200).trim();
    if (b.descriptionAr !== undefined) item.descriptionAr = clip(b.descriptionAr, 1000);
    if (b.price !== undefined) item.price = clip(b.price, 100);
    if (b.published !== undefined) item.published = toBool(b.published, item.published);
    if (b.featured !== undefined && item.type === 'prices') item.featured = toBool(b.featured, false);

    await item.save();
    res.json(adminItemJson(item));
  } catch (err) {
    console.error('Update item error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

/* =========================================================
   DELETE ADMIN ITEM (STRICT CLOUDINARY CLEANUP)
========================================================= */
app.delete('/api/admin/items/:type/:id', auth, requireOwner, async (req, res) => {
  try {
    const { type, id } = req.params;
    const item = await Item.findOne({ type, id });

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    if (item.publicId) {
      try {
        const cloudRes = await cloudinary.uploader.destroy(item.publicId, { resource_type: 'image' });
        if (cloudRes.result !== 'ok' && cloudRes.result !== 'not found') {
          return res.status(500).json({ error: 'Failed to delete image from Cloudinary' });
        }
      } catch (cErr) {
        console.error('Cloudinary delete error:', cErr);
        return res.status(500).json({ error: 'Failed to delete image from Cloudinary' });
      }
    }

    await Item.deleteOne({ type, id });

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

/* =========================================================
   PUBLIC: CREATE BOOKING
========================================================= */
const bookingLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later or use WhatsApp.' }
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\+?[\d\s()-]{9,25}$/;

// Returns "+<digits>" (9–15 digits) or '' if invalid.
// UAE local formats are converted so the admin WhatsApp button works: 050 123 4567 -> +971501234567
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!plus && d.startsWith('00')) d = d.slice(2);
  else if (!plus && /^05\d{8}$/.test(d)) d = '971' + d.slice(1);
  if (d.length < 9 || d.length > 15) return '';
  return '+' + d;
}

function nowDubaiHM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
}
function todayInDubai() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
}
function isRealDate(d) {
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function isFridayDate(d) {
  return new Date(d + 'T00:00:00Z').getUTCDay() === 5;
}
function to12h(t) {
  const [h, m] = t.split(':').map(Number);
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
// Is "HH:MM" inside open..close? Handles closing after midnight (e.g. 14:00 -> 01:00).
function withinHours(t, open, close) {
  if (open === close) return true;
  if (open < close) return t >= open && t < close;
  return t >= open || t < close;
}
// ---- Availability: opening window, party length, parallel parties, parties per day ----
const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => {
  n = ((n % 1440) + 1440) % 1440;
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
};
function dayWindow(date, st) {
  const friday = isFridayDate(date);
  const open = toMin(friday ? st.fridayOpen : st.weekdayOpen);
  let close = toMin(friday ? st.fridayClose : st.weekdayClose);
  const wrapped = close <= open; // closes after midnight (or open 24h)
  if (wrapped) close += 1440;
  return { open, close, wrapped };
}
// UAE is UTC+4 all year (no daylight saving).
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
function addDaysDubai(n) {
  return new Date(Date.now() + DUBAI_OFFSET_MS + n * 86400000).toISOString().slice(0, 10);
}
// Bookings that currently hold a time slot: confirmed ones, and pending ones that are still inside the hold window.
function holdsSlot() {
  const cutoff = new Date(Date.now() - PENDING_HOLD_HOURS * 3600 * 1000);
  return { $or: [{ status: 'confirmed' }, { status: 'pending', createdAt: { $gt: cutoff } }] };
}
function overlapCount(date, time, st, others) {
  const { open, wrapped } = dayWindow(date, st);
  const dur = Number(st.partyMinutes) || 180;
  let start = toMin(time);
  if (wrapped && start < open) start += 1440;
  let n = 0;
  for (const b of others) {
    let bs = toMin(b.time);
    if (wrapped && bs < open) bs += 1440;
    if (bs < start + dur && start < bs + dur) n++;
  }
  return n;
}
// existing = bookings of that date that hold a slot (see holdsSlot)
function checkSlot(date, time, st, existing) {
  const { open, close, wrapped } = dayWindow(date, st);
  const dur = Number(st.partyMinutes) || 180;
  const parallel = Number(st.maxParallel) || 1;
  const perDay = Number(st.maxPerDay) || 5;
  let start = toMin(time);
  if (wrapped && start < open) start += 1440; // after-midnight part belongs to the same opening day
  if (start < open || start + dur > close) return { ok: false, reason: 'outside', close };
  // Too soon (or already past): compare in Dubai wall-clock minutes, so it also works for after-midnight slots.
  const nowMin = Math.floor((Date.now() + DUBAI_OFFSET_MS) / 60000);
  const slotMin = Date.parse(date + 'T00:00:00Z') / 60000 + start;
  if (slotMin < nowMin + MIN_LEAD_HOURS * 60) return { ok: false, reason: 'passed' };
  if (existing.length >= perDay) return { ok: false, reason: 'full' };
  if (overlapCount(date, time, st, existing) >= parallel) return { ok: false, reason: 'busy' };
  return { ok: true };
}
function slotMessage(chk) {
  return {
    outside: 'The party must finish before closing time (' + to12h(fromMin(chk.close || 0)) + '). Please choose an earlier start time.',
    passed: 'That time is too soon to book online. Please choose a later time, or contact us on WhatsApp.',
    full: 'Sorry, we are fully booked on this day. Please choose another date.',
    busy: 'That time is no longer available. Please choose another time.'
  }[chk.reason];
}
function bookingJson(b) {
  return {
    id: b.id,
    reference: b.id.slice(0, 8).toUpperCase(),
    name: b.name,
    phone: b.phone,
    date: b.date,
    time: b.time,
    children: b.children,
    message: b.message || '',
    packagePrice: b.packagePrice || '',
    packageName: b.packageName || '',
    status: b.status,
    createdAt: b.createdAt,
    childName: b.childName || '',
    childAge: b.childAge === undefined || b.childAge === null ? null : b.childAge,
    allergies: b.allergies || '',
    waiverAccepted: !!b.waiverAccepted,
    reminderSentAt: b.reminderSentAt || null,
    notifyStatus: b.notifyStatus || '',
    notifyError: b.notifyError || '',
    // a pending request older than the hold window no longer blocks its time slot
    holdExpired: b.status === 'pending' && new Date(b.createdAt).getTime() < Date.now() - PENDING_HOLD_HOURS * 3600 * 1000
  };
}

/* =========================================================
   BOOKING EMAIL NOTIFICATION
   Option A (recommended on Render FREE): RESEND_API_KEY  -> HTTPS API, no SMTP port needed
   Option B: GMAIL_USER + GMAIL_APP_PASSWORD -> Gmail SMTP (needs Render paid plan / other host,
             because Render free blocks SMTP ports 25/465/587)
   If neither is set, bookings still save; a warning is logged.
========================================================= */
const SITE_URL = (process.env.SITE_URL || 'https://rudhat-alsaadah-entertainment.onrender.com').replace(/\/$/, '');
const escHtml = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  return u ? u.slice(0, 2) + '***@' + (d || '?') : '(empty)';
}

function mailStatus() {
  if (process.env.RESEND_API_KEY) {
    return 'Resend ON, NOTIFY_EMAIL=' + maskEmail(process.env.NOTIFY_EMAIL || process.env.GMAIL_USER);
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'Gmail SMTP ON';
  return 'OFF (no RESEND_API_KEY / GMAIL settings found)';
}

function mailConfigured() {
  return !!(process.env.RESEND_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
}

async function sendMail({ subject, html, text }) {
  const to = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  if (!to) throw new Error('NOTIFY_EMAIL is not set');

  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Rudhat Bookings <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
        text
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('Resend error ' + r.status + ': ' + (await r.text()).slice(0, 300));
    console.log('Booking email SENT via Resend to ' + maskEmail(to));
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10000,
    socketTimeout: 15000
  });
  await transporter.sendMail({
    from: '"Rudhat Bookings" <' + process.env.GMAIL_USER + '>',
    to,
    subject,
    html,
    text
  });
  console.log('Booking email SENT via Gmail to ' + maskEmail(to));
}

async function notifyNewBooking(b) {
  const ref = b.id.slice(0, 8).toUpperCase();
  console.log('Booking email: sending for ' + ref + ' (' + mailStatus() + ')');
  const waLink = 'https://wa.me/' + b.phone.replace(/\D/g, '');
  const rows = [
    ['Reference', ref],
    ['Name', b.name],
    ['Phone', b.phone],
    ['Date', b.date],
    ['Time', b.time],
    ['Children', b.children],
    ['Birthday child', (b.childName || '-') + (b.childAge || b.childAge === 0 ? ' (' + b.childAge + ' yrs)' : '')],
    ['Allergies / medical', b.allergies || 'None stated'],
    ['Package', ((b.packageName ? b.packageName + ' – ' : '') + (b.packagePrice || '')) || '-'],
    ['Message', b.message || '-']
  ];
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">' +
    '<h2 style="margin:0 0 12px">🎂 New birthday booking</h2>' +
    '<table style="border-collapse:collapse;width:100%">' +
    rows
      .map(
        ([k, v]) =>
          '<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#64748b;width:110px">' +
          escHtml(k) +
          '</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">' +
          escHtml(v) +
          '</td></tr>'
      )
      .join('') +
    '</table>' +
    '<p style="margin-top:18px">' +
    '<a href="' + escHtml(waLink) + '" style="background:#25d366;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:bold">💬 WhatsApp customer</a> ' +
    '<a href="' + escHtml(SITE_URL + '/admin/') + '" style="background:#18324a;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:bold">Open dashboard</a>' +
    '</p></div>';
  const text =
    rows.map(([k, v]) => k + ': ' + v).join('\n') + '\n\nWhatsApp: ' + waLink + '\nDashboard: ' + SITE_URL + '/admin/';

  await sendMail({
    subject: '🎂 New booking ' + ref + ' – ' + b.name + ' (' + b.date + ' ' + b.time + ')',
    html,
    text
  });
}

// Sends the owner e-mail and records the result on the booking (sent / failed / skipped).
async function sendBookingEmail(b) {
  if (!mailConfigured()) {
    console.warn('Email notification skipped: set RESEND_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD.');
    await Booking.updateOne({ id: b.id }, { $set: { notifyStatus: 'skipped' } }).catch(() => {});
    return;
  }
  try {
    await notifyNewBooking(b);
    await Booking.updateOne({ id: b.id }, { $set: { notifyStatus: 'sent', notifyError: '' }, $inc: { notifyAttempts: 1 } });
  } catch (e) {
    console.error('Booking email failed (' + b.id.slice(0, 8).toUpperCase() + '):', e.message);
    await Booking.updateOne(
      { id: b.id },
      { $set: { notifyStatus: 'failed', notifyError: String(e.message).slice(0, 300) }, $inc: { notifyAttempts: 1 } }
    ).catch(() => {});
  }
}

// Every 5 minutes: retry e-mails that failed (or were never finished), at most 5 times, for 48 hours.
const MAX_NOTIFY_ATTEMPTS = 5;
async function retryFailedEmails() {
  if (!dbUp() || !mailConfigured()) return;
  const rows = await Booking.find({
    notifyAttempts: { $lt: MAX_NOTIFY_ATTEMPTS },
    createdAt: { $gt: new Date(Date.now() - 48 * 3600 * 1000) },
    $or: [
      { notifyStatus: 'failed' },
      { notifyStatus: 'pending', createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }
    ]
  }).limit(5);
  for (const b of rows) await sendBookingEmail(b);
}

// Cloudflare Turnstile check (only when TURNSTILE_SITE_KEY + TURNSTILE_SECRET are set).
// Runs BEFORE the booking lock so a slow check never delays other customers.
async function verifyTurnstile(req, res, next) {
  if (!turnstileOn) return next();
  const tok = String((req.body && req.body.turnstileToken) || '').slice(0, 2048);
  if (!tok) return res.status(400).json({ error: 'Please complete the security check and try again.' });
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: tok, remoteip: req.ip }),
      signal: AbortSignal.timeout(5000)
    });
    const d = await r.json();
    if (!d.success) return res.status(400).json({ error: 'Security check failed. Please try again.' });
  } catch (e) {
    // Cloudflare unreachable: do not block real customers (rate limits and the honeypot still apply).
    if (process.env.TURNSTILE_FAIL_CLOSED === 'true') {
      console.error('Turnstile check unavailable, blocking request:', e.message);
      return res.status(503).json({ error: 'The security check is temporarily unavailable. Please contact us on WhatsApp.' });
    }
    console.error('Turnstile check unavailable, allowing request:', e.message);
  }
  next();
}

// Bookings are processed one at a time, so two simultaneous requests cannot take the same slot.
// NOTE: this lock lives inside one Node process. Run ONE instance of the service (the default on Render);
// with several instances, add a database-level reservation first.
let bookingChain = Promise.resolve();
function withBookingLock(fn) {
  const run = bookingChain.then(fn, fn);
  bookingChain = run.catch(() => {});
  return run;
}
app.post('/api/bookings', bookingLimit, verifyTurnstile, (req, res) =>
  withBookingLock(() => createBooking(req, res))
);

// Distributed lock for one booking day (works even if the service runs on several instances)
async function withDateLock(date, fn) {
  const id = 'day:' + date;
  const tokenId = crypto.randomUUID();
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      await BookingLock.create({ _id: id, token: tokenId, expiresAt: new Date(Date.now() + 15000) });
      break;
    } catch (e) {
      if (!e || e.code !== 11000) throw e;
      await BookingLock.deleteOne({ _id: id, expiresAt: { $lt: new Date() } }); // a crashed holder never blocks for long
      if (Date.now() > deadline) throw new Error('lock-busy');
      await sleep(60 + Math.floor(Math.random() * 80));
    }
  }
  try {
    return await fn();
  } finally {
    await BookingLock.deleteOne({ _id: id, token: tokenId }).catch(() => {});
  }
}

async function createBooking(req, res) {
  const d = String((req.body && req.body.date) || '').trim();
  if (!DATE_RE.test(d)) return createBookingInner(req, res);
  try {
    return await withDateLock(d, () => createBookingInner(req, res));
  } catch (e) {
    if (e && e.message === 'lock-busy') {
      return res.status(503).json({ error: 'The booking system is busy. Please try again in a moment.' });
    }
    throw e;
  }
}

async function createBookingInner(req, res) {
  try {
    const body = req.body || {};

    // Honeypot: bots fill hidden fields. Pretend success, store nothing.
    if (String(body.website || '').trim()) {
      return res.status(201).json({ ok: true, reference: 'OK' });
    }

    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const date = String(body.date || '').trim();
    const time = String(body.time || '').trim();
    const children = Number(body.children);
    const message = String(body.message || '').trim();

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    const phoneNorm = PHONE_RE.test(phone) ? normalizePhone(phone) : '';
    if (!phoneNorm) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    if (!DATE_RE.test(date) || !isRealDate(date)) {
      return res.status(400).json({ error: 'Please choose a valid date.' });
    }
    if (date < todayInDubai()) {
      return res.status(400).json({ error: 'The date cannot be in the past.' });
    }
    if (date > addDaysDubai(MAX_DAYS_AHEAD)) {
      return res.status(400).json({ error: 'Online bookings can be made up to ' + MAX_DAYS_AHEAD + ' days ahead.' });
    }
    if (!TIME_RE.test(time)) {
      return res.status(400).json({ error: 'Please choose a valid time.' });
    }
    const closedDay = await ClosedDate.findOne({ date }).lean();
    if (closedDay) {
      return res.status(409).json({
        error: 'We are closed on this date' + (closedDay.reason ? ' (' + closedDay.reason + ')' : '') + '. Please choose another day.'
      });
    }
    const st = await getSettings();
    const friday = isFridayDate(date);
    const open = friday ? st.fridayOpen : st.weekdayOpen;
    const close = friday ? st.fridayClose : st.weekdayClose;
    if (!withinHours(time, open, close)) {
      return res.status(400).json({
        error:
          'We are open ' + to12h(open) + ' – ' + to12h(close) +
          (friday ? ' on Fridays' : ' on this day') + '. Please choose a time within opening hours.'
      });
    }
    // Availability: not in the past, party fits before closing, not double-booked, daily limit
    // Same phone number: limit open upcoming requests (stops one person filling the calendar)
    const openForPhone = await Booking.countDocuments({
      phone: phoneNorm,
      date: { $gte: todayInDubai() },
      ...holdsSlot()
    });
    if (openForPhone >= MAX_ACTIVE_PER_PHONE) {
      return res.status(429).json({
        error: 'You already have several open booking requests. Please contact us on WhatsApp to change or add a booking.'
      });
    }
    const existing = await Booking.find({ date, ...holdsSlot() }).select('time').lean();
    const chk = checkSlot(date, time, st, existing);
    if (!chk.ok) {
      return res
        .status(chk.reason === 'busy' || chk.reason === 'full' ? 409 : 400)
        .json({ error: slotMessage(chk) });
    }
    if (!Number.isInteger(children) || children < 1 || children > 100) {
      return res.status(400).json({ error: 'Number of children must be between 1 and 100.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    // Birthday child + parent/guardian declaration
    const childName = clip(String(body.childName || '').trim(), 100);
    const ageRaw = body.childAge;
    const childAge = ageRaw === undefined || ageRaw === null || String(ageRaw).trim() === '' ? null : Number(ageRaw);
    const allergies = clip(String(body.allergies || '').trim(), 500);
    const waiverAccepted = body.waiverAccepted === true || String(body.waiverAccepted).toLowerCase() === 'true';
    if (process.env.WAIVER_REQUIRED !== 'false') {
      if (childName.length < 1) return res.status(400).json({ error: "Please enter the birthday child's name." });
      if (!waiverAccepted) return res.status(400).json({ error: 'Please confirm the parent / guardian declaration.' });
    }
    if (childAge !== null && (!Number.isInteger(childAge) || childAge < 0 || childAge > 17)) {
      return res.status(400).json({ error: "The child's age must be between 0 and 17." });
    }

    // Chosen package (when the site offers several); otherwise the first published one
    const pkgId = String(body.packageId || '').trim();
    let bday = null;
    if (pkgId) {
      bday = await Item.findOne({ type: 'birthday', published: true, id: pkgId }).lean();
      if (!bday) return res.status(400).json({ error: 'Please choose a valid package.' });
    }
    if (!bday) {
      bday = await Item.findOne({ type: 'birthday', published: true }).sort({ createdAt: 1 }).lean();
    }

    const booking = new Booking({
      id: crypto.randomUUID(),
      name,
      phone: phoneNorm,
      date,
      time,
      children,
      message,
      childName,
      childAge: childAge === null ? undefined : childAge,
      allergies,
      waiverAccepted,
      waiverAt: waiverAccepted ? new Date() : undefined,
      packagePrice: bday ? bday.price : '',
      packageName: bday ? bday.title : ''
    });
    await booking.save();

    // Fire-and-forget: a mail failure must never fail the customer's booking (status is stored and retried).
    sendBookingEmail(booking).catch((e) => console.error('Booking email error:', e.message));

    res.status(201).json({ ok: true, reference: booking.id.slice(0, 8).toUpperCase() });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: 'Failed to save booking' });
  }
}

/* =========================================================
   PUBLIC: AVAILABLE TIMES FOR A DATE
   Returns only yes/no per start time (no customer data).
========================================================= */
app.get('/api/availability', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!DATE_RE.test(date) || !isRealDate(date)) {
      return res.status(400).json({ error: 'Please choose a valid date.' });
    }
    if (date < todayInDubai()) {
      return res.status(400).json({ error: 'The date cannot be in the past.' });
    }
    if (date > addDaysDubai(MAX_DAYS_AHEAD)) {
      return res.status(400).json({ error: 'Online bookings can be made up to ' + MAX_DAYS_AHEAD + ' days ahead.' });
    }
    const closedDay = await ClosedDate.findOne({ date }).lean();
    if (closedDay) {
      return res.set('Cache-Control', 'no-store').json({
        date, closed: true, reason: closedDay.reason || '', reasonAr: closedDay.reasonAr || '', full: false, slots: []
      });
    }
    const st = await getSettings();
    const existing = await Booking.find({ date, ...holdsSlot() }).select('time').lean();
    const { open, close } = dayWindow(date, st);
    const dur = Number(st.partyMinutes) || 180;
    const slots = [];
    let full = false;
    for (let t = open; t + dur <= close; t += 30) {
      const time = fromMin(t);
      const c = checkSlot(date, time, st, existing);
      if (c.reason === 'passed') continue;
      if (c.reason === 'full') full = true;
      slots.push({ time, available: c.ok });
    }
    res.set('Cache-Control', 'no-store').json({ date, full, partyMinutes: dur, slots });
  } catch (err) {
    console.error('Availability error:', err);
    res.status(500).json({ error: 'Failed to load available times' });
  }
});

/* =========================================================
   ADMIN: BOOKINGS
========================================================= */
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled'];

app.get('/api/admin/bookings', auth, async (req, res) => {
  try {
    const filter = {};
    if (BOOKING_STATUSES.includes(req.query.status)) filter.status = req.query.status;

    const [rows, grouped] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).limit(500).lean(),
      Booking.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);

    const counts = { pending: 0, confirmed: 0, cancelled: 0, total: 0 };
    grouped.forEach((g) => {
      if (counts[g._id] !== undefined) counts[g._id] = g.n;
      counts.total += g.n;
    });

    res.json({ bookings: rows.map(bookingJson), counts });
  } catch (err) {
    console.error('Admin bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.patch('/api/admin/bookings/:id', auth, async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const prev = await Booking.findOne({ id: req.params.id });
    if (!prev) return res.status(404).json({ error: 'Booking not found' });
    const apply = async () => {
      if (status === 'confirmed' && prev.status !== 'confirmed') {
        // A cancelled or expired request is being confirmed: make sure nobody else took the time meanwhile.
        const stNow = await getSettings();
        const others = await Booking.find({ date: prev.date, id: { $ne: prev.id }, ...holdsSlot() }).select('time').lean();
        if (overlapCount(prev.date, prev.time, stNow, others) >= (Number(stNow.maxParallel) || 1)) return 'conflict';
      }
      prev.status = status;
      await prev.save();
      return 'ok';
    };
    let outcome;
    try {
      outcome = status === 'confirmed' ? await withDateLock(prev.date, apply) : await apply();
    } catch (e) {
      if (e && e.message === 'lock-busy') return res.status(503).json({ error: 'The booking system is busy. Please try again.' });
      throw e;
    }
    if (outcome === 'conflict') {
      return res.status(409).json({ error: 'Another booking now holds this time. Choose a different time with the customer first.' });
    }
    res.json(bookingJson(prev));
  } catch (err) {
    console.error('Update booking error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

app.post('/api/admin/bookings/:id/resend', auth, async (req, res) => {
  try {
    if (!mailConfigured()) return res.status(400).json({ error: 'E-mail is not configured on the server.' });
    const b = await Booking.findOne({ id: req.params.id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    await sendBookingEmail(b);
    const fresh = await Booking.findOne({ id: b.id }).lean();
    res.json(bookingJson(fresh));
  } catch (err) {
    console.error('Resend booking email error:', err);
    res.status(500).json({ error: 'Failed to resend the e-mail' });
  }
});

// Staff tapped "reminder sent" after sending the day-before WhatsApp reminder
app.post('/api/admin/bookings/:id/reminded', auth, async (req, res) => {
  try {
    const on = req.body && req.body.undo ? undefined : new Date();
    const b = await Booking.findOneAndUpdate(
      { id: req.params.id },
      on ? { $set: { reminderSentAt: on } } : { $unset: { reminderSentAt: 1 } },
      { new: true }
    );
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    res.json(bookingJson(b));
  } catch (err) {
    console.error('Reminder mark error:', err);
    res.status(500).json({ error: 'Failed to update the reminder' });
  }
});

app.delete('/api/admin/bookings/:id', auth, requireOwner, async (req, res) => {
  try {
    const r = await Booking.deleteOne({ id: req.params.id });
    if (!r.deletedCount) return res.status(404).json({ error: 'Booking not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete booking error:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

/* =========================================================
   PLAY CARDS (prepaid hours)
   Public: the customer opens /card/CODE (QR code) and sees the balance.
   Admin: create, deduct time, top up, cancel, extend, delete.
========================================================= */
const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I (easy to read and type)
const CARD_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
function genCardCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += CARD_ALPHABET[crypto.randomInt(CARD_ALPHABET.length)];
  return c;
}
const normCardCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function cardRemaining(c) {
  return Math.max(0, (c.totalMinutes || 0) - (c.usedMinutes || 0));
}
function cardState(c) {
  if (c.status === 'cancelled') return 'cancelled';
  if (c.expiresAt && c.expiresAt < todayInDubai()) return 'expired';
  if (cardRemaining(c) <= 0) return 'used_up';
  return 'active';
}
// The public card page only shows these standard labels; staff notes stay private to the admin.
const PUBLIC_LEDGER_NOTES = new Set(['Card created', 'Play time', 'Hours added']);
function cardJson(c, forAdmin) {
  const ledger = (c.ledger || [])
    .map((l) => ({
      at: l.at,
      minutes: l.minutes,
      note: forAdmin
        ? l.note || ''
        : PUBLIC_LEDGER_NOTES.has(l.note) ? l.note : l.minutes > 0 ? 'Hours added' : 'Play time'
    }))
    .reverse()
    .slice(0, forAdmin ? 200 : 15);
  const out = {
    code: c.code,
    holder: c.childName || String(c.name || '').trim().split(/\s+/)[0] || '',
    packageTitle: c.packageTitle || '',
    totalMinutes: c.totalMinutes,
    usedMinutes: c.usedMinutes || 0,
    remainingMinutes: cardRemaining(c),
    expiresAt: c.expiresAt || '',
    state: cardState(c),
    ledger
  };
  if (forAdmin) {
    Object.assign(out, {
      id: c.id,
      name: c.name,
      childName: c.childName || '',
      phone: c.phone || '',
      price: c.price || '',
      note: c.note || '',
      status: c.status,
      createdAt: c.createdAt
    });
  }
  return out;
}

const cardViewLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please try again in a few minutes.' }
});

app.get('/api/cards/:code', cardViewLimit, async (req, res) => {
  try {
    const code = normCardCode(req.params.code);
    if (!CARD_CODE_RE.test(code)) return res.status(404).json({ error: 'Card not found' });
    const card = await PlayCard.findOne({ code }).lean();
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.set('Cache-Control', 'no-store').json(cardJson(card, false));
  } catch (err) {
    console.error('Card view error:', err);
    res.status(500).json({ error: 'Failed to load the card' });
  }
});

function sendCardPage(req, res) {
  sendHtmlFile(res, 'card.html', { headers: { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache' } });
}
app.get(['/card', '/card/:code'], sendCardPage);
app.get('/privacy', (req, res) => sendHtmlFile(res, 'privacy.html'));

app.get('/api/admin/cards', auth, async (req, res) => {
  try {
    const rows = await PlayCard.find({}).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ cards: rows.map((c) => cardJson(c, true)) });
  } catch (err) {
    console.error('Admin cards error:', err);
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

app.post('/api/admin/cards', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Customer name is required.' });
    let phone = '';
    if (String(b.phone || '').trim()) {
      phone = normalizePhone(b.phone);
      if (!phone) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const hours = Number(b.hours);
    const totalMinutes = Math.round(hours * 60);
    if (!(hours > 0) || hours > 1000 || totalMinutes < 1) {
      return res.status(400).json({ error: 'Hours must be a number between 0.5 and 1000.' });
    }
    const expiresAt = String(b.expiresAt || '').trim();
    if (expiresAt && (!DATE_RE.test(expiresAt) || !isRealDate(expiresAt))) {
      return res.status(400).json({ error: 'Expiry must be a valid date.' });
    }
    if (expiresAt && expiresAt < todayInDubai()) {
      return res.status(400).json({ error: 'Expiry date cannot be in the past.' });
    }
    const doc = {
      id: crypto.randomUUID(),
      name,
      childName: String(b.childName || '').trim().slice(0, 100),
      phone,
      packageTitle: String(b.packageTitle || '').trim().slice(0, 100),
      price: String(b.price || '').trim().slice(0, 40),
      totalMinutes,
      usedMinutes: 0,
      expiresAt,
      note: String(b.note || '').trim().slice(0, 300),
      ledger: [{ at: new Date(), minutes: totalMinutes, note: 'Card created' }]
    };
    let saved = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      try {
        saved = await new PlayCard({ ...doc, code: genCardCode() }).save();
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // duplicate code: try another one
      }
    }
    if (!saved) return res.status(500).json({ error: 'Could not generate a card code. Please try again.' });
    res.status(201).json(cardJson(saved, true));
  } catch (err) {
    console.error('Create card error:', err);
    res.status(500).json({ error: 'Failed to create the card' });
  }
});

// Deduct played time. Optimistic concurrency: the update only applies if nobody changed the balance meanwhile.
app.post('/api/admin/cards/:id/use', auth, async (req, res) => {
  try {
    const minutes = Math.round(Number((req.body || {}).minutes));
    if (!(minutes >= 1 && minutes <= 1440)) {
      return res.status(400).json({ error: 'Minutes must be between 1 and 1440.' });
    }
    const note = String((req.body || {}).note || 'Play time').trim().slice(0, 200);
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await PlayCard.findOne({ id: req.params.id }).lean();
      if (!c) return res.status(404).json({ error: 'Card not found' });
      const state = cardState(c);
      if (state === 'cancelled') return res.status(409).json({ error: 'This card is cancelled.' });
      if (state === 'expired') return res.status(409).json({ error: 'This card has expired (' + c.expiresAt + '). Extend the expiry first.' });
      const left = cardRemaining(c);
      if (minutes > left) {
        return res.status(409).json({ error: 'Only ' + left + ' minutes are left on this card.' });
      }
      const updated = await PlayCard.findOneAndUpdate(
        { id: c.id, usedMinutes: c.usedMinutes || 0, totalMinutes: c.totalMinutes, status: 'active' },
        { $inc: { usedMinutes: minutes }, $push: { ledger: { at: new Date(), minutes: -minutes, note } } },
        { new: true }
      );
      if (updated) return res.json(cardJson(updated, true));
    }
    res.status(409).json({ error: 'The card was just updated. Please try again.' });
  } catch (err) {
    console.error('Use card error:', err);
    res.status(500).json({ error: 'Failed to update the card' });
  }
});

app.post('/api/admin/cards/:id/topup', auth, async (req, res) => {
  try {
    const hours = Number((req.body || {}).hours);
    const minutes = Math.round(hours * 60);
    if (!(hours > 0) || hours > 1000 || minutes < 1) {
      return res.status(400).json({ error: 'Hours must be a number between 0.5 and 1000.' });
    }
    const note = String((req.body || {}).note || 'Hours added').trim().slice(0, 200);
    const c = await PlayCard.findOne({ id: req.params.id }).lean();
    if (!c) return res.status(404).json({ error: 'Card not found' });
    if (c.status === 'cancelled') return res.status(409).json({ error: 'This card is cancelled.' });
    const updated = await PlayCard.findOneAndUpdate(
      { id: c.id },
      { $inc: { totalMinutes: minutes }, $push: { ledger: { at: new Date(), minutes, note } } },
      { new: true }
    );
    res.json(cardJson(updated, true));
  } catch (err) {
    console.error('Top-up card error:', err);
    res.status(500).json({ error: 'Failed to update the card' });
  }
});

app.patch('/api/admin/cards/:id', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.status !== undefined) {
      if (!['active', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
      update.status = b.status;
    }
    if (b.expiresAt !== undefined) {
      const e = String(b.expiresAt || '').trim();
      if (e && (!DATE_RE.test(e) || !isRealDate(e))) return res.status(400).json({ error: 'Expiry must be a valid date.' });
      update.expiresAt = e;
    }
    if (b.note !== undefined) update.note = String(b.note || '').trim().slice(0, 300);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const card = await PlayCard.findOneAndUpdate({ id: req.params.id }, update, { new: true });
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json(cardJson(card, true));
  } catch (err) {
    console.error('Update card error:', err);
    res.status(500).json({ error: 'Failed to update the card' });
  }
});

app.delete('/api/admin/cards/:id', auth, requireOwner, async (req, res) => {
  try {
    const r = await PlayCard.deleteOne({ id: req.params.id });
    if (!r.deletedCount) return res.status(404).json({ error: 'Card not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete card error:', err);
    res.status(500).json({ error: 'Failed to delete the card' });
  }
});

/* =========================================================
   ADMIN: SETTINGS (phone + opening hours)
========================================================= */
app.get('/api/admin/settings', auth, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/admin/settings', auth, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};

    if (b.whatsapp !== undefined) {
      const digits = String(b.whatsapp).replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        return res.status(400).json({ error: 'WhatsApp number must be 8–15 digits (with country code, no +).' });
      }
      update.whatsapp = digits;
    }
    if (b.displayPhone !== undefined) {
      const dp = String(b.displayPhone).trim();
      if (!dp || dp.length > 30) {
        return res.status(400).json({ error: 'Display phone is required (max 30 characters).' });
      }
      update.displayPhone = dp;
    }
    for (const k of ['instagram', 'tiktok', 'reviewUrl', 'mapUrl']) {
      if (b[k] !== undefined) {
        const v = String(b[k]).trim();
        if (v && (v.length > 300 || !/^https:\/\/[^\s]+$/i.test(v))) {
          return res.status(400).json({ error: k + ' must be a full link starting with https://' });
        }
        update[k] = v;
      }
    }
    for (const k of ['bannerText', 'bannerTextAr']) {
      if (b[k] !== undefined) update[k] = clip(String(b[k]).trim(), 200);
    }
    if (b.bannerUntil !== undefined) {
      const u = String(b.bannerUntil).trim();
      if (u && (!DATE_RE.test(u) || !isRealDate(u))) {
        return res.status(400).json({ error: 'Banner end date is not valid.' });
      }
      update.bannerUntil = u;
    }
    const NUM = { partyMinutes: [30, 720], maxParallel: [1, 20], maxPerDay: [1, 50] };
    for (const k of Object.keys(NUM)) {
      if (b[k] !== undefined && String(b[k]).trim() !== '') {
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < NUM[k][0] || n > NUM[k][1]) {
          return res.status(400).json({ error: k + ' must be a whole number between ' + NUM[k][0] + ' and ' + NUM[k][1] + '.' });
        }
        update[k] = n;
      }
    }
    for (const k of ['weekdayOpen', 'weekdayClose', 'fridayOpen', 'fridayClose']) {
      if (b[k] !== undefined) {
        if (!TIME_RE.test(String(b[k]))) {
          return res.status(400).json({ error: 'Invalid time for ' + k });
        }
        update[k] = String(b[k]);
      }
    }

    await Settings.updateOne({ key: 'main' }, { $set: update }, { upsert: true });
    res.json(await getSettings());
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/* =========================================================
   ADMIN: CLOSED DATES
========================================================= */
app.get('/api/admin/closed-dates', auth, async (req, res) => {
  try {
    const rows = await ClosedDate.find({ date: { $gte: todayInDubai() } }).sort({ date: 1 }).limit(300).lean();
    res.json(rows.map((c) => ({ date: c.date, reason: c.reason || '', reasonAr: c.reasonAr || '' })));
  } catch (err) {
    console.error('Closed dates list error:', err);
    res.status(500).json({ error: 'Failed to load closed dates' });
  }
});

app.post('/api/admin/closed-dates', auth, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const date = String(b.date || '').trim();
    if (!DATE_RE.test(date) || !isRealDate(date)) return res.status(400).json({ error: 'Please choose a valid date.' });
    if (date < todayInDubai()) return res.status(400).json({ error: 'The date cannot be in the past.' });
    await ClosedDate.updateOne(
      { date },
      { $set: { reason: clip(String(b.reason || '').trim(), 120), reasonAr: clip(String(b.reasonAr || '').trim(), 120) } },
      { upsert: true }
    );
    // Warn the owner about bookings that already exist on that day (they are NOT cancelled automatically)
    const existing = await Booking.countDocuments({ date, status: { $ne: 'cancelled' } });
    res.status(201).json({ ok: true, existingBookings: existing });
  } catch (err) {
    console.error('Closed date add error:', err);
    res.status(500).json({ error: 'Failed to save the closed date' });
  }
});

app.delete('/api/admin/closed-dates/:date', auth, requireOwner, async (req, res) => {
  try {
    await ClosedDate.deleteOne({ date: String(req.params.date) });
    res.json({ ok: true });
  } catch (err) {
    console.error('Closed date delete error:', err);
    res.status(500).json({ error: 'Failed to remove the closed date' });
  }
});

/* =========================================================
   ADMIN: STAFF ACCOUNTS (owner only)
========================================================= */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const staffJson = (x) => ({ id: x.id, name: x.name, email: x.email, active: !!x.active, createdAt: x.createdAt });

app.get('/api/admin/staff', auth, requireOwner, async (req, res) => {
  try {
    const rows = await Staff.find({}).sort({ createdAt: 1 }).lean();
    res.json(rows.map(staffJson));
  } catch (err) {
    console.error('Staff list error:', err);
    res.status(500).json({ error: 'Failed to load staff' });
  }
});

app.post('/api/admin/staff', auth, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const name = clip(String(b.name || '').trim(), 60);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'Please enter the staff name.' });
    if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid e-mail.' });
    if (email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'This e-mail belongs to the owner account.' });
    }
    if (password.length < 10 || password.length > 100) {
      return res.status(400).json({ error: 'The password must be 10–100 characters.' });
    }
    if (await Staff.exists({ email })) return res.status(409).json({ error: 'A staff account with this e-mail already exists.' });
    const created = await new Staff({ id: crypto.randomUUID(), name, email, passHash: hashPassword(password) }).save();
    res.status(201).json(staffJson(created));
  } catch (err) {
    console.error('Staff create error:', err);
    res.status(500).json({ error: 'Failed to create the staff account' });
  }
});

app.patch('/api/admin/staff/:id', auth, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    let kickOut = false;
    if (b.active !== undefined) {
      set.active = b.active === true || String(b.active) === 'true';
      if (!set.active) kickOut = true;
    }
    if (b.name !== undefined) {
      const name = clip(String(b.name).trim(), 60);
      if (name.length < 2) return res.status(400).json({ error: 'Please enter the staff name.' });
      set.name = name;
    }
    if (b.password !== undefined && String(b.password) !== '') {
      const pw = String(b.password);
      if (pw.length < 10 || pw.length > 100) return res.status(400).json({ error: 'The password must be 10–100 characters.' });
      set.passHash = hashPassword(pw);
      kickOut = true; // a new password signs the person out everywhere
    }
    const updated = await Staff.findOneAndUpdate({ id: req.params.id }, { $set: set }, { new: true });
    if (!updated) return res.status(404).json({ error: 'Staff account not found' });
    if (kickOut) await AdminSession.deleteMany({ staffId: updated.id });
    res.json(staffJson(updated));
  } catch (err) {
    console.error('Staff update error:', err);
    res.status(500).json({ error: 'Failed to update the staff account' });
  }
});

app.delete('/api/admin/staff/:id', auth, requireOwner, async (req, res) => {
  try {
    const gone = await Staff.findOneAndDelete({ id: req.params.id });
    if (!gone) return res.status(404).json({ error: 'Staff account not found' });
    await AdminSession.deleteMany({ staffId: gone.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Staff delete error:', err);
    res.status(500).json({ error: 'Failed to delete the staff account' });
  }
});

/* =========================================================
   VISITOR STATISTICS (anonymous counters, no cookies, no personal data)
========================================================= */
const TRACK_EVENTS = ['visit', 'wa', 'call', 'map', 'book'];
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|uptime/i;
const trackLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

app.post('/api/track', trackLimit, async (req, res) => {
  try {
    const ev = String((req.body && req.body.e) || '');
    if (TRACK_EVENTS.includes(ev) && !BOT_UA.test(String(req.headers['user-agent'] || ''))) {
      await Stat.updateOne({ day: todayInDubai(), event: ev }, { $inc: { n: 1 } }, { upsert: true });
    }
  } catch (err) {
    console.error('Track error:', err.message);
  }
  res.status(204).end(); // never slows down or breaks the page
});

app.get('/api/admin/stats', auth, requireOwner, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const from = addDaysDubai(-(days - 1));
    const [stats, created] = await Promise.all([
      Stat.find({ day: { $gte: from } }).lean(),
      Booking.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - (days + 1) * 86400000) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Dubai' } }, n: { $sum: 1 } } }
      ])
    ]);
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const d = addDaysDubai(-(days - 1) + i);
      byDay[d] = { day: d, visit: 0, wa: 0, call: 0, map: 0, book: 0, requests: 0 };
    }
    stats.forEach((x) => { if (byDay[x.day]) byDay[x.day][x.event] = x.n; });
    created.forEach((x) => { if (byDay[x._id]) byDay[x._id].requests = x.n; });
    const list = Object.values(byDay);
    const totals = { visit: 0, wa: 0, call: 0, map: 0, book: 0, requests: 0 };
    list.forEach((d) => Object.keys(totals).forEach((k) => { totals[k] += d[k]; }));
    res.set('Cache-Control', 'no-store').json({ days, list, totals });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load statistics' });
  }
});

/* =========================================================
   ADMIN: TWO-STEP VERIFICATION (owner only)
========================================================= */
app.get('/api/admin/2fa', auth, requireOwner, async (req, res) => {
  const oa = await OwnerAuth.findOne({ key: 'owner' }).lean();
  res.json({ enabled: !!(oa && oa.enabled), emergencyOff: process.env.DISABLE_OWNER_2FA === 'true' });
});

app.post('/api/admin/2fa/setup', auth, requireOwner, async (req, res) => {
  try {
    const oa = await OwnerAuth.findOne({ key: 'owner' }).lean();
    if (oa && oa.enabled) return res.status(400).json({ error: 'Two-step verification is already on.' });
    const secret = b32enc(crypto.randomBytes(20));
    await OwnerAuth.updateOne({ key: 'owner' }, { $set: { secretEnc: encSecret(secret), enabled: false, lastStep: 0 } }, { upsert: true });
    const label = encodeURIComponent('Rudhat Admin:' + String(process.env.ADMIN_EMAIL || 'owner'));
    res.json({ secret, otpauth: 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=Rudhat%20Admin&digits=6&period=30' });
  } catch (err) {
    console.error('2FA setup error:', err);
    res.status(500).json({ error: 'Could not start the setup.' });
  }
});

app.post('/api/admin/2fa/enable', auth, requireOwner, async (req, res) => {
  try {
    const oa = await OwnerAuth.findOne({ key: 'owner' }).lean();
    if (!oa || !oa.secretEnc) return res.status(400).json({ error: 'Start the setup first.' });
    if (oa.enabled) return res.status(400).json({ error: 'Two-step verification is already on.' });
    const step = totpCheck(decSecret(oa.secretEnc), req.body && req.body.code, 0);
    if (!step) return res.status(400).json({ error: 'That code is not correct. Check the app and try again.' });
    await OwnerAuth.updateOne({ key: 'owner' }, { $set: { enabled: true, lastStep: step } });
    res.json({ enabled: true });
  } catch (err) {
    console.error('2FA enable error:', err);
    res.status(500).json({ error: 'Could not turn on two-step verification.' });
  }
});

app.post('/api/admin/2fa/disable', auth, requireOwner, async (req, res) => {
  try {
    const oa = await OwnerAuth.findOne({ key: 'owner', enabled: true }).lean();
    if (!oa) return res.status(400).json({ error: 'Two-step verification is not on.' });
    if (totpLocked()) return res.status(429).json({ error: 'Too many wrong codes. Please wait 15 minutes.' });
    const step = totpCheck(decSecret(oa.secretEnc), req.body && req.body.code, oa.lastStep || 0);
    if (!step) { totpFails.push(Date.now()); return res.status(400).json({ error: 'That code is not correct.' }); }
    await OwnerAuth.deleteOne({ key: 'owner' });
    res.json({ enabled: false });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ error: 'Could not turn off two-step verification.' });
  }
});

/* =========================================================
   ADMIN: ACTIVITY LOG + BACKUP (owner only)
========================================================= */
app.get('/api/admin/audit', auth, requireOwner, async (req, res) => {
  try {
    const limit = Math.min(300, Math.max(20, parseInt(req.query.limit, 10) || 100));
    const filter = req.query.failed === '1' ? { ok: false } : {};
    const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean();
    res.json(rows.map((r) => ({
      at: r.at, actor: r.actor, role: r.role, action: r.action, target: r.target, detail: r.detail, ip: r.ip, ok: r.ok !== false
    })));
  } catch (err) {
    console.error('Audit list error:', err);
    res.status(500).json({ error: 'Failed to load the activity log' });
  }
});

// One JSON file with everything important (staff password hashes and sessions are left out)
app.get('/api/admin/backup', auth, requireOwner, async (req, res) => {
  try {
    const [items, bookings, cards, settings, closedDates, staff] = await Promise.all([
      Item.find({}).lean(),
      Booking.find({}).lean(),
      PlayCard.find({}).lean(),
      Settings.find({}).lean(),
      ClosedDate.find({}).lean(),
      Staff.find({}).select('-passHash').lean()
    ]);
    writeAudit({ actor: req.adminName || 'Owner', role: 'owner', action: 'Downloaded a backup', ip: String(req.ip || '').slice(0, 60) });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rudhat-backup-' + stamp + '.json"',
      'Cache-Control': 'no-store'
    });
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), items, bookings, cards, settings, closedDates, staff }, null, 1));
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Failed to create the backup' });
  }
});

/* =========================================================
   SERVE FRONTEND
   index.html is a template: the JSON-LD block (what Google reads)
   is generated from the same settings the admin edits.
========================================================= */
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const indexTemplate = fs.readFileSync(INDEX_PATH, 'utf8');

function buildJsonLd(st) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': SITE_URL + '/#business',
    name: 'RUDHAT ALSAADAH ENTERTAINMENT',
    url: SITE_URL + '/',
    image: SITE_URL + '/og-image.jpg?v=3',
    description: "Children's entertainment and play center in Al Majaz 3, Sharjah, UAE.",
    telephone: '+' + st.whatsapp,
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Sarab Tower, Al Majaz 3',
      addressLocality: 'Sharjah',
      addressCountry: 'AE'
    },
    priceRange: process.env.PRICE_RANGE || 'AED 20+',
    hasMap: st.mapUrl || 'https://maps.app.goo.gl/cr9KgWa9pnrv2HNLA',
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
        opens: st.weekdayOpen,
        closes: st.weekdayClose
      },
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: 'Friday',
        opens: st.fridayOpen,
        closes: st.fridayClose
      }
    ]
  };
  const sameAs = [st.instagram, st.tiktok].filter(Boolean);
  if (sameAs.length) ld.sameAs = sameAs;
  return (
    '<script type="application/ld+json">' +
    JSON.stringify(ld).replace(/</g, '\\u003c') +
    '</script>'
  );
}

// Works with the placeholder OR with a page that already has a static JSON-LD block.
function withJsonLd(html, ld) {
  if (html.includes('<!--JSONLD-->')) return html.replace('<!--JSONLD-->', () => ld);
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => ld);
}

/* ---- Home page: English at "/" and Arabic at "/ar" (own address, own meta tags, hreflang) ---- */
const zlib = require('zlib');
const AR_META = {
  title: 'روضة السعادة | ترفيه الأطفال',
  description: 'روضة السعادة للترفيه — مركز ترفيه وألعاب آمن وممتع للأطفال في المجاز 3، الشارقة، الإمارات.',
  ogDescription: 'مكان سعيد للمستكشفين الصغار في المجاز 3، الشارقة، الإمارات.',
  twDescription: 'مركز ترفيه وألعاب للأطفال في المجاز 3، الشارقة، الإمارات.'
};
const DEFAULT_BASE = 'https://rudhat-alsaadah-entertainment.onrender.com';
const gzCache = new Map(); // lang -> { html, gz }

function pageHtml(lang, st) {
  let html = withJsonLd(indexTemplate, buildJsonLd(st));
  if (SITE_URL !== DEFAULT_BASE) html = html.split(DEFAULT_BASE).join(SITE_URL);
  const url = SITE_URL + (lang === 'ar' ? '/ar' : '/');
  const alt =
    '<link rel="alternate" hreflang="en" href="' + SITE_URL + '/">\n' +
    '<link rel="alternate" hreflang="ar" href="' + SITE_URL + '/ar">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + SITE_URL + '/">\n' +
    '<meta property="og:locale" content="' + (lang === 'ar' ? 'ar_AE' : 'en_US') + '">\n' +
    '<meta property="og:locale:alternate" content="' + (lang === 'ar' ? 'en_US' : 'ar_AE') + '">\n';
  let head = alt;
  if (lang === 'ar') {
    html = html
      .replace('<html lang="en">', '<html lang="ar" dir="rtl">')
      .replace(/<title>[^<]*<\/title>/, '<title>' + AR_META.title + '</title>')
      .replace(/(<meta name="description" content=")[^"]*(")/, '$1' + AR_META.description + '$2')
      .replace(/(<meta property="og:title" content=")[^"]*(")/, '$1' + AR_META.title + '$2')
      .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + AR_META.ogDescription + '$2')
      .replace(/(<meta property="og:url" content=")[^"]*(")/, '$1' + url + '$2')
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, '$1' + AR_META.title + '$2')
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, '$1' + AR_META.twDescription + '$2')
      .replace(/(<link rel="canonical" href=")[^"]*(")/, '$1' + url + '$2');
    head += '<script>window.__LANG__="ar";</script>\n';
  }
  return html.replace('</head>', () => head + '</head>');
}

async function sendHome(lang, req, res) {
  let st = SETTINGS_DEFAULTS;
  try {
    st = await getSettings();
  } catch (err) {
    console.error('Index settings error:', err);
  }
  const html = pageHtml(lang, st);
  res.type('html').set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
  let hc = homeCsp.get(lang);
  if (!hc || hc.html !== html) { hc = { html, csp: pageCsp(html, false) }; homeCsp.set(lang, hc); }
  res.set('Content-Security-Policy', hc.csp);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let c = gzCache.get(lang);
    if (!c || c.html !== html) {
      c = { html, gz: zlib.gzipSync(html, { level: 6 }) };
      gzCache.set(lang, c);
    }
    res.set('Content-Encoding', 'gzip');
    return res.end(c.gz);
  }
  res.send(html);
}

app.get('/', (req, res) => sendHome('en', req, res));
app.get('/ar', (req, res) => sendHome('ar', req, res));
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// robots.txt and sitemap.xml follow SITE_URL, so they stay correct if you buy a domain later
app.get('/robots.txt', (req, res) => {
  res
    .type('text/plain')
    .send(
      'User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /card\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n'
    );
});
app.get('/sitemap.xml', (req, res) => {
  const alt =
    '    <xhtml:link rel="alternate" hreflang="en" href="' + SITE_URL + '/"/>\n' +
    '    <xhtml:link rel="alternate" hreflang="ar" href="' + SITE_URL + '/ar"/>\n' +
    '    <xhtml:link rel="alternate" hreflang="x-default" href="' + SITE_URL + '/"/>\n';
  res
    .type('application/xml')
    .send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        '  <url>\n    <loc>' + SITE_URL + '/</loc>\n' + alt + '  </url>\n' +
        '  <url>\n    <loc>' + SITE_URL + '/ar</loc>\n' + alt + '  </url>\n' +
        '  <url>\n    <loc>' + SITE_URL + '/privacy</loc>\n  </url>\n' +
        '</urlset>\n'
    );
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Admin pages: the dashboard needs inline event attributes (onclick), the login page does not
app.get(['/admin', '/admin/', '/admin/index.html'], (req, res) => sendHtmlFile(res, 'admin/index.html'));
app.get('/admin/dashboard.html', (req, res) => sendHtmlFile(res, 'admin/dashboard.html', { attrInline: true }));

// The clean addresses are /card and /privacy; the raw files redirect there (no duplicate pages for Google).
app.get('/card.html', (req, res) => res.redirect(301, '/card'));
app.get('/privacy.html', (req, res) => res.redirect(301, '/privacy'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Unknown address: a real 404 (not the home page with status 200)
app.get('*', (req, res) => {
  sendHtmlFile(res, '404.html', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache' } });
});

// Always answer with JSON on /api (e.g. a malformed request body), never an HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled error:', err);
  const msg = status === 413 ? 'Request too large' : status < 500 ? 'Invalid request' : 'Server error';
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  res.status(status).type('text/plain').send(msg);
});

app.listen(PORT, () => {
  console.log(`Rudhat running on port ${PORT}`);
  console.log('Email notifications: ' + mailStatus());
  console.log('Booking security check (Turnstile): ' + (turnstileOn ? 'ON' : 'OFF'));
  setInterval(() => retryFailedEmails().catch((e) => console.error('Email retry error:', e.message)), 5 * 60 * 1000).unref();
});
