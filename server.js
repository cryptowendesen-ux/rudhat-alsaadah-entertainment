const express = require('express');
const path = require('path');
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
      enum: ['services', 'prices', 'gallery', 'birthday']
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
function publicItemJson(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    price: item.price,
    imageUrl: item.imageUrl || '',
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
   MIDDLEWARE
========================================================= */
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
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
    const result = { services: [], prices: [], gallery: [], birthday: [] };

    items.forEach((item) => {
      if (result[item.type]) {
        result[item.type].push(publicItemJson(item));
      }
    });

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
  if (
    req.body?.email !== process.env.ADMIN_EMAIL ||
    req.body?.password !== process.env.ADMIN_PASSWORD
  ) {
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
    const result = { services: [], prices: [], gallery: [], birthday: [] };

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
      !['services', 'prices', 'gallery', 'birthday'].includes(type) ||
      !String(title || '').trim()
    ) {
      return res.status(400).json({ error: 'Invalid type/title' });
    }

    if (type === 'gallery') {
      return res.status(400).json({ error: 'Use the gallery upload endpoint for images' });
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
    res.status(201).json(adminItemJson(newItem));
  } catch (err) {
    console.error('Create item error:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

/* =========================================================
   CLOUDINARY UPLOAD HELPER
========================================================= */
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'rudhat-alsaadah/gallery',
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

    const cloudResult = await uploadToCloudinary(req.file.buffer);
    uploadedPublicId = cloudResult.public_id || '';

    const newItem = new Item({
      id: crypto.randomUUID(),
      type: 'gallery',
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

    const fields = ['title', 'description', 'price', 'published'];
    fields.forEach((field) => {
      if (req.body[field] !== undefined) {
        item[field] = req.body[field];
      }
    });

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
   SERVE STATIC FRONTEND & START SERVER
========================================================= */
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Rudhat running on port ${PORT}`);
});
