const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
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

let xrayProcess = null;
let restarting = false;
const connCount = {}; // uuid -> number of active WS connections

// WebSocket proxy to Xray
const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:10000', ws: true });

// ═══════════════════════════════════════
// XRAY PROCESS MANAGEMENT
// ═══════════════════════════════════════

function generateConfig(activeUsers) {
  const clients = activeUsers.length > 0
    ? activeUsers.map(u => ({ id: u.uuid, email: u.uuid }))
    : [{ id: '00000000-0000-0000-0000-000000000000', email: 'dummy' }];

  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        port: 10000, listen: '127.0.0.1', protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: '/' } }
      }
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }]
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function startXray() {
  if (xrayProcess) try { xrayProcess.kill(); } catch (e) {}
  xrayProcess = spawn(XRAY_PATH, ['run', '-config', CONFIG_PATH]);
  xrayProcess.stdout?.on('data', d => process.stdout.write(d));
  xrayProcess.stderr?.on('data', d => process.stderr.write(d));
  xrayProcess.on('exit', code => console.log('Xray exited:', code));
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
// AUTH
// ═══════════════════════════════════════

function tokenHash() {
  return crypto.createHash('sha256').update(ADMIN_PASSWORD + '_xr_salt_9f').digest('hex');
}
function auth(req, res, next) {
  if (req.cookies?.xt === tokenHash()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/', (req, res) => res.redirect('/admin'));
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
    const hostUrls = d.hostUrls || [];
    // Auto-detect current Cloud Run URL and include it
    const currentHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (currentHost && !hostUrls.includes(currentHost)) {
      hostUrls.unshift(currentHost);
      await settingsDoc.set({ hostUrls }, { merge: true });
    }
    res.json({
      cdnAddress: d.cdnAddress || 'm.googleapis.com',
      sniList: d.sniList || ['workspaceblog.google.com'],
      hostUrls
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

app.get('/api/stats', auth, (req, res) => {
  // Return map of uuid -> connection count for all connected users
  const online = {};
  for (const [uuid, count] of Object.entries(connCount)) {
    if (count > 0) online[uuid] = count;
  }
  res.json({ online });
});

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════

app.get('/_ah/health', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.send('OK'));

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

  const server = http.createServer(app);

  // Handle WebSocket upgrades - extract UUID from path, track connections
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    if (url.startsWith('/admin') || url.startsWith('/api')) {
      socket.destroy();
      return;
    }

    // Extract UUID from path: /UUID -> track connection
    const uuid = url.slice(1).split('?')[0]; // remove leading / and query params
    if (uuid) {
      connCount[uuid] = (connCount[uuid] || 0) + 1;
      console.log(`WS connect: ${uuid} (${connCount[uuid]} sessions)`);
      const cleanup = () => {
        if (connCount[uuid]) {
          connCount[uuid]--;
          if (connCount[uuid] <= 0) delete connCount[uuid];
        }
        console.log(`WS disconnect: ${uuid} (${connCount[uuid] || 0} sessions)`);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    }

    // Rewrite URL to / for Xray
    req.url = '/';
    proxy.ws(req, socket, head, {}, (err) => {
      console.error('WS proxy error:', err.message);
      socket.destroy();
    });
  });

  server.listen(PORT, () => console.log(`Server on :${PORT}`));
  try { await restartXray(); } catch (e) { console.error('Initial Xray start failed:', e.message); }
}

init();
