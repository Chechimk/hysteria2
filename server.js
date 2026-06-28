const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const CONFIG_PATH = '/tmp/xray-config.json';
const XRAY_PATH = '/app/xray';

const db = new Firestore();
const usersCol = db.collection('xray-users');
const settingsDoc = db.collection('xray-settings').doc('main');

let xrayProcess = null;
let prevTraffic = {};
let statsClient = null;
let restarting = false;

// ═══════════════════════════════════════
// XRAY PROCESS MANAGEMENT
// ═══════════════════════════════════════

function generateConfig(activeUsers) {
  const clients = activeUsers.length > 0
    ? activeUsers.map(u => ({ id: u.uuid, email: u.uuid }))
    : [{ id: '00000000-0000-0000-0000-000000000000', email: 'dummy' }];

  const config = {
    log: { loglevel: 'warning' },
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        tag: 'api', port: 10085, listen: '127.0.0.1',
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' }
      },
      {
        port: 10000, listen: '127.0.0.1', protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: '/' } }
      }
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    routing: { rules: [{ inboundTag: ['api'], outboundTag: 'api', type: 'field' }] }
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function startXray() {
  if (xrayProcess) try { xrayProcess.kill(); } catch (e) {}
  xrayProcess = spawn(XRAY_PATH, ['run', '-config', CONFIG_PATH]);
  xrayProcess.stdout?.on('data', d => process.stdout.write(d));
  xrayProcess.stderr?.on('data', d => process.stderr.write(d));
  xrayProcess.on('exit', code => console.log('Xray exited:', code));
  prevTraffic = {};
  setTimeout(initStatsClient, 2000);
}

async function restartXray() {
  if (restarting) return;
  restarting = true;
  try {
    const snap = await usersCol.get();
    const active = snap.docs.filter(d => d.data().assigned && d.data().active).map(d => d.data());
    generateConfig(active);
    startXray();
  } catch (e) { console.error('Restart error:', e.message); }
  finally { restarting = false; }
}

// ═══════════════════════════════════════
// STATS (gRPC)
// ═══════════════════════════════════════

function initStatsClient() {
  const PROTO = 'syntax="proto3";package xray.app.stats.command;service StatsService{rpc QueryStats(QueryStatsRequest)returns(QueryStatsResponse){}}message QueryStatsRequest{string pattern=1;bool reset=2;}message QueryStatsResponse{repeated Stat stat=1;}message Stat{string name=1;int64 value=2;}';
  try {
    fs.writeFileSync('/tmp/stats.proto', PROTO);
    const pkgDef = protoLoader.loadSync('/tmp/stats.proto', { longs: Number });
    const proto = grpc.loadPackageDefinition(pkgDef);
    if (statsClient) try { statsClient.close(); } catch (e) {}
    statsClient = new proto.xray.app.stats.command.StatsService('127.0.0.1:10085', grpc.credentials.createInsecure());
  } catch (e) { statsClient = null; }
}

function getOnlineUsers() {
  return new Promise(resolve => {
    if (!statsClient) return resolve([]);
    const deadline = new Date(Date.now() + 3000);
    statsClient.QueryStats({ pattern: 'user', reset: false }, { deadline }, (err, res) => {
      if (err) return resolve([]);
      const online = new Set(), current = {};
      for (const s of res?.stat || []) {
        const m = s.name?.match(/^user>>>(.+?)>>>traffic>>>/);
        if (m) {
          const uuid = m[1], val = Number(s.value) || 0;
          current[s.name] = val;
          if (prevTraffic[s.name] !== undefined && val > prevTraffic[s.name]) online.add(uuid);
        }
      }
      prevTraffic = current;
      resolve(Array.from(online));
    });
  });
}

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

function tokenHash() {
  return crypto.createHash('sha256').update(ADMIN_PASSWORD + '_xr_salt_9f').digest('hex');
}
function auth(req, res, next) {
  if (req.cookies?.xt === tokenHash()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.cookie('xt', tokenHash(), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400000, path: '/' });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('xt', { path: '/' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════

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
    const u = {};
    if (req.body.cdnAddress !== undefined) u.cdnAddress = req.body.cdnAddress.trim();
    if (req.body.sniList !== undefined) u.sniList = req.body.sniList;
    if (req.body.hostUrls !== undefined) u.hostUrls = req.body.hostUrls;
    await settingsDoc.set(u, { merge: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// USERS CRUD
// ═══════════════════════════════════════

app.get('/api/users', auth, async (req, res) => {
  try {
    const snap = await usersCol.get();
    const users = snap.docs.filter(d => d.data().assigned).map(d => ({ id: d.id, ...d.data() }));
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const uuid = crypto.randomUUID();
    const user = { uuid, name, assigned: true, active: true, createdAt: new Date().toISOString() };
    await usersCol.doc(uuid).set(user);
    await restartXray();
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    const u = {};
    if (req.body.active !== undefined) u.active = req.body.active;
    if (req.body.name !== undefined) u.name = req.body.name;
    await usersCol.doc(req.params.id).update(u);
    await restartXray();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    await usersCol.doc(req.params.id).delete();
    await restartXray();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// STATS ENDPOINT
// ═══════════════════════════════════════

app.get('/api/stats', auth, async (req, res) => {
  try { res.json({ online: await getOnlineUsers() }); }
  catch (e) { res.json({ online: [] }); }
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

async function init() {
  try {
    const doc = await settingsDoc.get();
    if (!doc.exists) {
      await settingsDoc.set({ cdnAddress: 'm.googleapis.com', sniList: ['workspaceblog.google.com'], hostUrls: [] });
    }
  } catch (e) { console.error('Seed error:', e.message); }

  app.listen(PORT, () => console.log(`Admin panel on :${PORT}`));
  try { await restartXray(); } catch (e) { console.error('Initial Xray start failed:', e.message); }
}

init();
