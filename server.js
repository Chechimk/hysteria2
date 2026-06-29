const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const httpProxy = require('http-proxy');

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const CONFIG_PATH = '/tmp/xray-config.json';
const XRAY_PATH = '/app/xray';

const db = new Firestore();
const usersCol = db.collection('xray-users');
const settingsDoc = db.collection('xray-settings').doc('main');
const trafficCol = db.collection('xray-traffic');

let xrayProcess = null;
let restarting = false;
let statsClient = null;

const onlineUsers = new Set();
const connRef = {};
const liveTraffic = {};
const trafficBuffer = {};

const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:10000', ws: true });

// ═══════════════════════════════════════
// XRAY CONFIG & PROCESS
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
      { tag: 'api', port: 10085, listen: '127.0.0.1', protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
      { port: 10000, listen: '127.0.0.1', protocol: 'vless', settings: { clients, decryption: 'none' }, streamSettings: { network: 'ws', wsSettings: { path: '/' } } }
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
// TRAFFIC STATS (gRPC)
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

function pollTraffic() {
  if (!statsClient) return;
  const deadline = new Date(Date.now() + 3000);
  statsClient.QueryStats({ pattern: 'user', reset: true }, { deadline }, (err, res) => {
    if (err) return;
    for (const s of res?.stat || []) {
      const m = s.name?.match(/^user>>>(.+?)>>>traffic>>>(uplink|downlink)/);
      if (m) {
        const uuid = m[1], dir = m[2], val = Number(s.value) || 0;
        if (val <= 0) continue;
        if (!liveTraffic[uuid]) liveTraffic[uuid] = { up: 0, down: 0 };
        if (!trafficBuffer[uuid]) trafficBuffer[uuid] = { up: 0, down: 0 };
        if (dir === 'uplink') { liveTraffic[uuid].up += val; trafficBuffer[uuid].up += val; }
        else { liveTraffic[uuid].down += val; trafficBuffer[uuid].down += val; }
      }
    }
  });
}

async function flushTraffic() {
  const hour = new Date().toISOString().slice(0, 13).replace('T', '-');
  const batch = db.batch();
  let hasData = false;
  for (const [uuid, data] of Object.entries(trafficBuffer)) {
    if (data.up === 0 && data.down === 0) continue;
    hasData = true;
    const ref = trafficCol.doc(`${uuid}_${hour}`);
    batch.set(ref, { uuid, hour, up: Firestore.FieldValue.increment(data.up), down: Firestore.FieldValue.increment(data.down) }, { merge: true });
    trafficBuffer[uuid] = { up: 0, down: 0 };
  }
  if (hasData) { try { await batch.commit(); } catch (e) { console.error('Flush error:', e.message); } }
}

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

function tokenHash() { return crypto.createHash('sha256').update(ADMIN_PASSWORD + '_xr_salt_9f').digest('hex'); }
function auth(req, res, next) { if (req.cookies?.xt === tokenHash()) return next(); res.status(401).json({ error: 'Unauthorized' }); }

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.cookie('xt', tokenHash(), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400000, path: '/' });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('xt', { path: '/' }); res.json({ ok: true }); });

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════

app.get('/api/settings', auth, async (req, res) => {
  try {
    const doc = await settingsDoc.get();
    const d = doc.exists ? doc.data() : {};
    const hostUrls = d.hostUrls || [];
    const currentHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (currentHost && !hostUrls.includes(currentHost)) { hostUrls.unshift(currentHost); await settingsDoc.set({ hostUrls }, { merge: true }); }
    res.json({ cdnAddress: d.cdnAddress || 'm.googleapis.com', sniList: d.sniList || ['workspaceblog.google.com'], hostUrls });
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
// User model: { uuid, owner, baseName, links: [{name, sni}], assigned, active, createdAt }
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
    const owner = (req.body.owner || '').trim();
    const baseName = (req.body.baseName || '').trim();
    const links = req.body.links || []; // [{name, sni}]
    if (!owner) return res.status(400).json({ error: 'Owner name is required' });
    if (!baseName) return res.status(400).json({ error: 'Base name is required' });
    if (!links.length) return res.status(400).json({ error: 'At least one link is required' });
    const uuid = crypto.randomUUID();
    const user = { uuid, owner, baseName, links, assigned: true, active: true, createdAt: new Date().toISOString() };
    await usersCol.doc(uuid).set(user);
    await restartXray();
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    const u = {};
    if (req.body.active !== undefined) u.active = req.body.active;
    if (req.body.links !== undefined) u.links = req.body.links;
    if (req.body.name !== undefined) u.owner = req.body.name;
    await usersCol.doc(req.params.id).update(u);
    if (req.body.active !== undefined) await restartXray();
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
// STATS + TRAFFIC ENDPOINTS
// ═══════════════════════════════════════

app.get('/api/stats', auth, (req, res) => {
  res.json({ online: Array.from(onlineUsers), traffic: liveTraffic });
});

app.get('/api/traffic', auth, async (req, res) => {
  try {
    const period = req.query.period || 'daily';
    const now = new Date();
    let since;
    switch (period) {
      case '1h': since = new Date(now - 3600000); break;
      case '2h': since = new Date(now - 7200000); break;
      case '3h': since = new Date(now - 10800000); break;
      case '4h': since = new Date(now - 14400000); break;
      case '5h': since = new Date(now - 18000000); break;
      case 'daily': since = new Date(now - 86400000); break;
      case 'weekly': since = new Date(now - 604800000); break;
      case 'monthly': since = new Date(now - 2592000000); break;
      case 'yearly': since = new Date(now - 31536000000); break;
      default: since = new Date(now - 86400000);
    }
    const sinceHour = since.toISOString().slice(0, 13).replace('T', '-');
    const snap = await trafficCol.where('hour', '>=', sinceHour).get();
    const result = {};
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!result[d.uuid]) result[d.uuid] = { up: 0, down: 0 };
      result[d.uuid].up += d.up || 0;
      result[d.uuid].down += d.down || 0;
    }
    res.json({ period, traffic: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════

app.get('/_ah/health', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.send('OK'));

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

async function init() {
  try {
    const doc = await settingsDoc.get();
    if (!doc.exists) await settingsDoc.set({ cdnAddress: 'm.googleapis.com', sniList: ['workspaceblog.google.com'], hostUrls: [] });
  } catch (e) { console.error('Seed error:', e.message); }

  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    if (url.startsWith('/admin') || url.startsWith('/api')) { socket.destroy(); return; }

    const uuid = url.slice(1).split('?')[0];
    if (uuid) {
      connRef[uuid] = (connRef[uuid] || 0) + 1;
      onlineUsers.add(uuid);
      const cleanup = () => {
        connRef[uuid] = (connRef[uuid] || 1) - 1;
        if (connRef[uuid] <= 0) {
          delete connRef[uuid];
          onlineUsers.delete(uuid);
          // Reset live session traffic when user fully disconnects
          delete liveTraffic[uuid];
        }
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    }

    req.url = '/';
    proxy.ws(req, socket, head, {}, (err) => { socket.destroy(); });
  });

  server.listen(PORT, () => console.log(`Server on :${PORT}`));
  try { await restartXray(); } catch (e) { console.error('Initial Xray start failed:', e.message); }

  setInterval(pollTraffic, 5000);
  setInterval(flushTraffic, 60000);
}

init();
