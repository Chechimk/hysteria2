const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const db = new Firestore();
const usersCol = db.collection('xray-users');
const settingsDoc = db.collection('xray-settings').doc('main');

const UUID_POOL = [
  'c7c939fc-b470-40c7-a7a8-05be9e3731bf',
  '07b807c7-0130-4de7-887c-cd7d5108a0c2',
  '08b807c7-0130-4de7-887c-cd7d5108a0c2',
  '00b807c7-0130-4de7-887c-cd7d5108a0c1',
  '55a1d58d-fea7-400e-8fdd-65815091ff13',
  '318b9498-cad3-47d0-9fb5-cb7244d42022',
  '77f4c09e-953c-4b33-926b-e458f405e9e2',
  '1b4d2d34-40dc-4bf1-942c-0f01b8ce182e',
  'ab36b411-4d02-4594-991a-5f449e91e67c',
  'b68dede1-e35f-4ae9-8cbf-1c31e6a2e121',
  '487f4690-3e24-4816-8e62-b366135d5e1e',
  '58fe2a88-7813-4b6a-ba63-3560e6370b67',
  'd7dafe93-bcdd-49e8-990d-f8c65bbc7a43',
  '6690f718-5919-4c1a-8528-442b0c4ff769',
  '708a4a0a-1cbe-4b3e-8a84-7dc582d6a48b',
  'f1bf7603-e86a-4b82-aade-6b49f69739e4',
  '4ac22172-a6f3-4d06-80b9-708e4cb52e95',
  '7cf3bf24-1a69-4c38-b6b9-bd62ce9031d7',
  '1dae563d-f14f-442b-a9a4-df2c7efcec03',
  '236d8557-96c0-4047-aad7-d97a4ab1985c',
  'b5f53ea2-6503-456e-8f88-4c77628ef16a',
  'ba3b12e0-8ba9-4f95-bb14-8ba4a3e1d9db',
  '19e2eab3-70b5-4bb9-84c0-8cdb2000dd50',
  '8099517f-7841-48e0-a9be-41827b66cc61',
  '18a0de5b-be9e-49f7-840c-4d6d3cef2868',
  'acd7290a-8b05-4991-afba-ab22f62bb73a',
  '3ffdaab5-bc1e-425d-8851-be81dcfbd4e4',
  '6076426a-0a8e-4ee5-b3c0-7abe78022d15',
  'e7bb3ee2-edbc-4029-b1ff-f7e6ba4abb38',
  '6149c54a-e8d2-4154-b2e8-42766f7fcbf2'
];

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
app.get('/api/settings', auth, async (req, res) => {
  try {
    const doc = await settingsDoc.get();
    const d = doc.exists ? doc.data() : {};
    res.json({
      cdnAddress: d.cdnAddress || 'm.googleapis.com',
      sniList: d.sniList || ['workspaceblog.google.com'],
      hostUrls: d.hostUrls || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    const updates = {};
    if (req.body.cdnAddress !== undefined) updates.cdnAddress = req.body.cdnAddress.trim();
    if (req.body.sniList !== undefined) updates.sniList = req.body.sniList;
    if (req.body.hostUrls !== undefined) updates.hostUrls = req.body.hostUrls;
    await settingsDoc.set(updates, { merge: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Users ---
app.get('/api/users', auth, async (req, res) => {
  try {
    const snap = await usersCol.get();
    const users = snap.docs.filter(d => d.data().assigned).map(d => ({ id: d.id, ...d.data() }));
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ users, total: UUID_POOL.length, available: UUID_POOL.length - users.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    // Get all docs to check which UUIDs are already assigned
    const snap = await usersCol.get();
    const used = new Set();
    snap.docs.forEach(d => { if (d.data().assigned) used.add(d.id); });
    const uuid = UUID_POOL.find(u => !used.has(u));
    if (!uuid) return res.status(400).json({ error: 'No available slots (all 30 used)' });
    const user = { uuid, name, assigned: true, active: true, createdAt: new Date().toISOString() };
    await usersCol.doc(uuid).set(user);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    await usersCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    const updates = {};
    if (req.body.active !== undefined) updates.active = req.body.active;
    if (req.body.name !== undefined) updates.name = req.body.name;
    await usersCol.doc(req.params.id).update(updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Seed ---
async function seed() {
  try {
    const doc = await settingsDoc.get();
    if (!doc.exists) {
      await settingsDoc.set({
        cdnAddress: 'm.googleapis.com',
        sniList: ['workspaceblog.google.com'],
        hostUrls: []
      });
      console.log('Seeded default settings');
    }
  } catch (e) { console.error('Seed error:', e.message); }
}

seed().then(() => {
  app.listen(PORT, () => console.log(`Admin panel on port ${PORT}`));
});
