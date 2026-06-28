const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const XRAY_HOST = process.env.XRAY_HOST || '';
const GRPC_SERVICE = process.env.GRPC_SERVICE || 'vlessgrpc';

const db = new Firestore();
const usersCol = db.collection('xray-users');

// --- Auth ---
function tokenHash() {
  return crypto.createHash('sha256').update(ADMIN_PASSWORD + '_xr_salt_9f').digest('hex');
}

function auth(req, res, next) {
  if (req.cookies?.xt === tokenHash()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.cookie('xt', tokenHash(), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('xt');
  res.json({ ok: true });
});

// --- Settings ---
app.get('/api/settings', auth, (req, res) => {
  res.json({ xrayHost: XRAY_HOST, grpcService: GRPC_SERVICE });
});

// --- Users CRUD ---
app.get('/api/users', auth, async (req, res) => {
  try {
    const snap = await usersCol.orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const uuid = uuidv4();
    const user = { uuid, name: name || 'User-' + uuid.slice(0, 8), createdAt: new Date().toISOString(), active: true };
    await usersCol.doc(uuid).set(user);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    await usersCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    const updates = {};
    if (req.body.active !== undefined) updates.active = req.body.active;
    if (req.body.name !== undefined) updates.name = req.body.name;
    await usersCol.doc(req.params.id).update(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Generate Xray config.json ---
app.get('/api/config', auth, async (req, res) => {
  try {
    const snap = await usersCol.where('active', '==', true).get();
    const clients = snap.docs.map(d => ({ id: d.data().uuid }));
    res.json({
      log: { loglevel: 'warning' },
      inbounds: [{
        port: 8080, protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: { network: 'grpc', grpcSettings: { serviceName: GRPC_SERVICE } }
      }],
      outbounds: [{ protocol: 'freedom' }]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Seed initial users on first run ---
async function seed() {
  try {
    const snap = await usersCol.limit(1).get();
    if (!snap.empty) return;
    const batch = db.batch();
    const initial = [
      { uuid: '94b807c7-0130-4de7-887c-cd7d5108a0c2', name: 'User-1' },
      { uuid: '07b807c7-0130-4de7-887c-cd7d5108a0c2', name: 'User-2' },
      { uuid: '08b807c7-0130-4de7-887c-cd7d5108a0c2', name: 'User-3' },
      { uuid: '00b807c7-0130-4de7-887c-cd7d5108a0c1', name: 'User-4' }
    ];
    for (const u of initial) {
      batch.set(usersCol.doc(u.uuid), { ...u, createdAt: new Date().toISOString(), active: true });
    }
    await batch.commit();
    console.log('Seeded 4 initial users');
  } catch (e) {
    console.error('Seed error (Firestore may not be enabled):', e.message);
  }
}

seed().then(() => {
  app.listen(PORT, () => console.log(`Admin panel on port ${PORT}`));
});
