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
      enum: ['services', 'prices', 'gallery', 'birthday', 'hero', 'about']
    },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    price: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    publicId: { type: String, default: '' },
    published: { type: Boolean, default: true }
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
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'pending'
    }
  },
  { timestamps: true }
);
bookingSchema.index({ status: 1, createdAt: -1 });
const Booking = mongoose.model('Booking', bookingSchema);

const SETTINGS_DEFAULTS = {
  whatsapp: '971585187788',
  displayPhone: '+971 58 518 7788',
  weekdayOpen: '09:00',
  weekdayClose: '21:00',
  fridayOpen: '14:00',
  fridayClose: '22:00'
};
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    whatsapp: String,
    displayPhone: String,
    weekdayOpen: String,
    weekdayClose: String,
    fridayOpen: String,
    fridayClose: String
  },
  { timestamps: true }
);
const Settings = mongoose.model('Settings', settingsSchema);

async function getSettings() {
  const doc = await Settings.findOne({ key: 'main' }).lean();
  const out = { ...SETTINGS_DEFAULTS };
  if (doc) {
    Object.keys(SETTINGS_DEFAULTS).forEach((k) => {
      if (doc[k]) out[k] = doc[k];
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

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verify(t)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
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
    price: item.price,
    imageUrl: optimizeImageUrl(item.imageUrl),
    published: item.published
  };
}

function adminItemJson(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    price: item.price,
    imageUrl: item.imageUrl || '',
    publicId: item.publicId || '',
    published: item.published
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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/* =========================================================
   HEALTH CHECK
========================================================= */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'rudhat-alsaadah-api' });
});

/* =========================================================
   PUBLIC CONTENT
========================================================= */
app.get('/api/content', async (req, res) => {
  try {
    const items = await Item.find({ published: true }).sort({ createdAt: 1 }).lean();
    const result = { services: [], prices: [], gallery: [], birthday: [], hero: [], about: [] };

    items.forEach((item) => {
      if (result[item.type]) {
        result[item.type].push(publicItemJson(item));
      }
    });

    result.settings = await getSettings();
    res.json(result);
  } catch (err) {
    console.error('Public content error:', err);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

/* =========================================================
   ADMIN LOGIN
========================================================= */
app.post('/api/auth/login', loginLimit, (req, res) => {
  const emailOk = safeEqual(req.body?.email, process.env.ADMIN_EMAIL);
  const passOk = safeEqual(req.body?.password, process.env.ADMIN_PASSWORD);
  if (!(emailOk && passOk)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const authToken = token({
    email: req.body.email,
    exp: Date.now() + 8 * 60 * 60 * 1000
  });

  res.json({ token: authToken });
});

/* =========================================================
   ADMIN CONTENT
========================================================= */
app.get('/api/admin/content', auth, async (req, res) => {
  try {
    const items = await Item.find().sort({ createdAt: 1 }).lean();
    const result = { services: [], prices: [], gallery: [], birthday: [], hero: [], about: [] };

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
app.post('/api/admin/items', auth, async (req, res) => {
  try {
    const { type, title, description = '', price = '', published = true } = req.body || {};

    if (
      !['services', 'prices', 'gallery', 'birthday', 'hero', 'about'].includes(type) ||
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
      price: clip(price, 100),
      published: toBool(published, true)
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
app.post('/api/admin/gallery/upload', auth, handleUpload, async (req, res) => {
  let uploadedPublicId = '';

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image file' });
    }

    const title =
      String(req.body?.title || '').trim() || path.parse(req.file.originalname).name;
    const description = String(req.body?.description || '');
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
app.put('/api/admin/items/:type/:id', auth, async (req, res) => {
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
    if (b.price !== undefined) item.price = clip(b.price, 100);
    if (b.published !== undefined) item.published = toBool(b.published, item.published);

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
app.delete('/api/admin/items/:type/:id', auth, async (req, res) => {
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
    status: b.status,
    createdAt: b.createdAt
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
  if (!mailConfigured()) {
    console.warn('Email notification skipped: set RESEND_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD.');
    return;
  }
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
    ['Package', b.packagePrice || '-'],
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

app.post('/api/bookings', bookingLimit, async (req, res) => {
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
    if (!TIME_RE.test(time)) {
      return res.status(400).json({ error: 'Please choose a valid time.' });
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
    if (!Number.isInteger(children) || children < 1 || children > 100) {
      return res.status(400).json({ error: 'Number of children must be between 1 and 100.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    const bday = await Item.findOne({ type: 'birthday', published: true })
      .sort({ createdAt: 1 })
      .lean();

    const booking = new Booking({
      id: crypto.randomUUID(),
      name,
      phone: phoneNorm,
      date,
      time,
      children,
      message,
      packagePrice: bday ? bday.price : ''
    });
    await booking.save();

    // Fire-and-forget: a mail failure must never fail the customer's booking.
    notifyNewBooking(booking).catch((e) => console.error('Booking email failed:', e.message));

    res.status(201).json({ ok: true, reference: booking.id.slice(0, 8).toUpperCase() });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: 'Failed to save booking' });
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
    const booking = await Booking.findOneAndUpdate(
      { id: req.params.id },
      { status },
      { new: true }
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(bookingJson(booking));
  } catch (err) {
    console.error('Update booking error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

app.delete('/api/admin/bookings/:id', auth, async (req, res) => {
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

app.put('/api/admin/settings', auth, async (req, res) => {
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
    '@id': 'https://rudhat-alsaadah-entertainment.onrender.com/#business',
    name: 'RUDHAT ALSAADAH ENTERTAINMENT',
    url: 'https://rudhat-alsaadah-entertainment.onrender.com/',
    image: 'https://rudhat-alsaadah-entertainment.onrender.com/og-image.png?v=2',
    description: "Children's entertainment and play center in Al Majaz 3, Sharjah, UAE.",
    telephone: '+' + st.whatsapp,
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Sarab Tower, Al Majaz 3',
      addressLocality: 'Sharjah',
      addressCountry: 'AE'
    },
    geo: { '@type': 'GeoCoordinates', latitude: 25.325012, longitude: 55.379532 },
    hasMap: 'https://maps.google.com/?q=25.325012,55.379532',
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

async function sendIndex(req, res) {
  let st = SETTINGS_DEFAULTS;
  try {
    st = await getSettings();
  } catch (err) {
    console.error('Index settings error:', err);
  }
  res
    .type('html')
    .set('Cache-Control', 'no-cache')
    .send(withJsonLd(indexTemplate, buildJsonLd(st)));
}

app.get('/', sendIndex);
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('*', sendIndex);

app.listen(PORT, () => {
  console.log(`Rudhat running on port ${PORT}`);
  console.log('Email notifications: ' + mailStatus());
});
