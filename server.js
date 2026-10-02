const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
require('dotenv').config();
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

if (!SECRET || SECRET.length < 32) throw new Error('Set JWT_SECRET (32+ chars)');
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
if (!MONGODB_URI) throw new Error('Set MONGODB_URI environment variable');
// MongoDB Schema & Model
const itemSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  type: { type: String, required: true, enum: ['services', 'prices', 'gallery', 'birthday'] },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  publicId: { type: String, default: '' },
  published: { type: Boolean, default: true }
}, { timestamps: true });

const Item = mongoose.model('Item', itemSchema);

// Initial Default Data
const defaults = {
  services: [
    ['Art & Coloring', 'Creative drawing and coloring time.'],
    ['Zumba & Dancing', 'Music, movement and energetic fun.'],
    ['Educational Games', 'Play-based learning for curious minds.'],
    ['Skill Development', 'Activities that encourage new skills.'],
    ['Clean & Safe', 'A welcoming environment with a professional team.']
  ].map(([title, description], i) => ({ id: 'svc' + i, type: 'services', title, description, published: true })),
  prices: [
    ['Per Hour', 'AED 20', '1 hour of play'],
    ['30 Hours', 'AED 520', 'Great value'],
    ['42 Hours', 'AED 620', 'More playtime'],
    ['64 Hours', 'AED 800', 'Best for regular visits'],
    ['UNLIMITED HOURS', 'AED 1,400', 'For maximum flexibility']
  ].map(([title, price, description], i) => ({ id: 'p' + i, type: 'prices', title, price, description, published: true })),
  gallery: [],
  birthday: [
    { id: 'b1', type: 'birthday', title: 'Birthday Package', price: 'AED 300', description: 'Birthday enquiries via WhatsApp.', published: true }
  ]
};

// Connect to MongoDB & Seed Defaults
mongoose.connect(MONGODB_URI)
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
  })
  .catch(err => console.error('MongoDB Connection Error:', err));

// Auth & Security Helpers
function token(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return b + '.' + s;
}

function verify(t) {
  try {
    const [a, s] = t.split('.');
    const e = crypto.createHmac('sha256', SECRET).update(a).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const p = JSON.parse(Buffer.from(a, 'base64url'));
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verify(t)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Middleware
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Routes
app.get('/api/health', (q, r) => r.json({ ok: true, service: 'rudhat-alsaadah-api' }));

app.get('/api/content', async (req, res) => {
  try {
    const items = await Item.find({ published: true }).lean();
    const result = { services: [], prices: [], gallery: [], birthday: [] };
    items.forEach(item => {
      if (result[item.type]) {
        result[item.type].push({
          id: item.id,
          title: item.title,
          description: item.description,
          price: item.price,
          published: item.published
        });
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

app.post('/api/auth/login', loginLimit, (req, res) => {
  if (req.body?.email !== process.env.ADMIN_EMAIL || req.body?.password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: token({ email: req.body.email, exp: Date.now() + 8 * 60 * 60 * 1000 }) });
});

app.get('/api/admin/content', auth, async (req, res) => {
  try {
    const items = await Item.find().lean();
    const result = { services: [], prices: [], gallery: [], birthday: [] };
    items.forEach(item => {
      if (result[item.type]) {
        result[item.type].push({
          id: item.id,
          title: item.title,
          description: item.description,
          price: item.price,
          published: item.published
        });
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin content' });
  }
});

app.post('/api/admin/items', auth, async (req, res) => {
  try {
    const { type, title, description = '', price = '', published = true } = req.body || {};
    if (!['services', 'prices', 'gallery', 'birthday'].includes(type) || !String(title || '').trim()) {
      return res.status(400).json({ error: 'Invalid type/title' });
    }
    const newItem = new Item({
      id: crypto.randomUUID(),
      type,
      title: String(title).trim(),
      description: String(description),
      price: String(price),
      published: Boolean(published)
    });
    await newItem.save();
    res.status(201).json({
      id: newItem.id,
      title: newItem.title,
      description: newItem.description,
      price: newItem.price,
      published: newItem.published
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create item' });
  }
});

app.put('/api/admin/items/:type/:id', auth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const item = await Item.findOne({ type, id });
    if (!item) return res.status(404).json({ error: 'Not found' });

    for (const k of ['title', 'description', 'price', 'published']) {
      if (req.body[k] !== undefined) item[k] = req.body[k];
    }
    await item.save();
    res.json({
      id: item.id,
      title: item.title,
      description: item.description,
      price: item.price,
      published: item.published
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

app.delete('/api/admin/items/:type/:id', auth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const deleted = await Item.findOneAndDelete({ type, id });
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// Serve Static Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (q, r) => r.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Rudhat running on ' + PORT));
