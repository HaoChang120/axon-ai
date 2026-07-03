// Axon AI — backend API
// Auth (JWT) + players + impact-event logging, backed by SQLite.
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const db = require('./db');

const JWT_SECRET = process.env.AXON_JWT_SECRET || 'axon-dev-secret-change-in-prod';
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());                 // allow the static site (any origin) to call the API
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- helpers ----
const sign = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });

const DEFAULT_SETTINGS = { g: 70, ang: 4500, push: true, vibrate: true, notifyCoach: true, quiet: false };
function userSettings(u) {
  try { return { ...DEFAULT_SETTINGS, ...(u && u.settings ? JSON.parse(u.settings) : {}) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, created_at: u.created_at, settings: userSettings(u) });

// classify against the owner's saved thresholds so a settings change actually affects flagging
function classify(linearG, angularAccel, thr) {
  const g = (thr && thr.g) || 70, a = (thr && thr.ang) || 4500;
  if (linearG >= g || angularAccel >= a) return { severity: 'concussion-risk', flagged: 1 };
  if (linearG >= g * 0.57 || angularAccel >= a * 0.56) return { severity: 'elevated', flagged: 0 };
  return { severity: 'routine', flagged: 0 };
}
function settingsForUser(id) { return userSettings(db.prepare('SELECT settings FROM users WHERE id = ?').get(id)); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// require that a player belongs to the requesting user
function ownPlayer(userId, playerId) {
  return db.prepare('SELECT * FROM players WHERE id = ? AND owner_id = ?').get(playerId, userId);
}

// ---- health ----
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'axon-backend', time: new Date().toISOString() }));

// ---- public demo (no auth) — lets the marketing site log/read impacts ----
// All site "SIMULATE IMPACT" events land on one shared demo player.
function ensureDemoPlayer() {
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@axon.ai');
  if (!u) {
    const info = db.prepare('INSERT INTO users (email, password_hash, name, team, role) VALUES (?, ?, ?, ?, ?)')
      .run('demo@axon.ai', bcrypt.hashSync('public-demo-no-login', 10), 'Public Demo', 'Axon Field Demo', 'demo');
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  let p = db.prepare('SELECT * FROM players WHERE owner_id = ? AND name = ?').get(u.id, 'Field Demo');
  if (!p) {
    const info = db.prepare('INSERT INTO players (owner_id, name, jersey, position) VALUES (?, ?, ?, ?)')
      .run(u.id, 'Field Demo', 0, 'Demo');
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
  }
  return p.id;
}
const DEMO_PLAYER = ensureDemoPlayer();
const DEMO_OWNER = db.prepare('SELECT owner_id FROM players WHERE id = ?').get(DEMO_PLAYER).owner_id;

// ---- ephemeral-host bootstrap (Render free tier has no persistent disk) ----
// On a fresh DB, recreate the demo coach + roster and re-register the real
// helmet with a stable key from env, so the firmware never needs re-flashing
// after the host restarts. Set AXON_BOOTSTRAP=1 + AXON_DEVICE_ID/KEY.
if (process.env.AXON_BOOTSTRAP === '1') {
  if (!db.prepare('SELECT id FROM users WHERE email = ?').get('coach@axon.ai')) require('./seed');
  const devId = process.env.AXON_DEVICE_ID, devKey = process.env.AXON_DEVICE_KEY;
  if (devId && devKey) {
    const ex = db.prepare('SELECT id FROM devices WHERE device_id = ?').get(devId);
    if (ex) db.prepare('UPDATE devices SET device_key = ? WHERE id = ?').run(devKey, ex.id);
    else {
      const coach = db.prepare('SELECT id FROM users WHERE email = ?').get('coach@axon.ai');
      const player = coach && db.prepare('SELECT id FROM players WHERE owner_id = ? ORDER BY id DESC').get(coach.id);
      db.prepare('INSERT INTO devices (device_id, device_key, owner_id, player_id, name) VALUES (?, ?, ?, ?, ?)')
        .run(devId, devKey, coach ? coach.id : DEMO_OWNER, player ? player.id : DEMO_PLAYER,
             process.env.AXON_DEVICE_NAME || 'Axon_Main_Module');
    }
  }
}

// =====================================================================
//  LIVE EVENT HUB — Server-Sent Events. This is your own realtime layer,
//  replacing Particle Cloud's event stream. The firmware POSTs to
//  /api/ingest; every connected app gets the impact pushed instantly.
// =====================================================================
const crypto = require('node:crypto');
const clients = new Set();  // each: { res, ownerId }
function sseSend(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, payload, ownerId) {
  for (const c of clients) {
    if (c.ownerId !== ownerId) continue;   // only push to that coach's live apps
    try { sseSend(c.res, event, payload); } catch { /* dead socket, will be cleaned on close */ }
  }
}
function startSse(req, res, ownerId) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const client = { res, ownerId };
  clients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}
const deviceInsert = db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)');

// ---- device ingest: the helmet firmware POSTs here over cellular ----
// Auth = a per-device shared secret (X-Device-Key), NOT a user login.
app.post('/api/ingest', (req, res) => {
  const key = req.headers['x-device-key'];
  const deviceId = req.headers['x-device-id'] || (req.body || {}).device_id;
  if (!key || !deviceId) return res.status(401).json({ error: 'device id + key required' });
  const dev = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(String(deviceId));
  if (!dev || dev.device_key !== String(key)) return res.status(401).json({ error: 'unknown device or bad key' });

  const b = req.body || {};
  const linear_g = Number(b.g ?? b.linear_g);           // accept firmware names (g/angAccel) or api names
  const angular_accel = Number(b.angAccel ?? b.angular_accel);
  if (!isFinite(linear_g) || !isFinite(angular_accel)) return res.status(400).json({ error: 'g / angAccel required' });
  const lg = Math.max(0, Math.min(200, linear_g));
  const aa = Math.max(0, Math.min(15000, angular_accel));
  const playerId = dev.player_id || DEMO_PLAYER;
  const owner = db.prepare('SELECT owner_id FROM players WHERE id = ?').get(playerId).owner_id;
  const { severity, flagged } = classify(lg, aa, settingsForUser(owner));   // owner's live thresholds
  const info = deviceInsert.run(playerId, Math.round(lg * 10) / 10, Math.round(aa), severity, flagged);
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(dev.id);
  const impact = db.prepare('SELECT * FROM impacts WHERE id = ?').get(info.lastInsertRowid);
  const payload = { ...impact, pad: b.pad ?? null, fsr: b.fsr != null ? Number(b.fsr) : null };
  broadcast('impact', payload, owner);
  if (flagged) broadcast('concussion_alert', payload, owner);
  res.status(201).json({ ok: true, severity, flagged });
});

// ---- register / list helmets (coach auth) ----
app.post('/api/devices', auth, (req, res) => {
  const { device_id, name, player_id } = req.body || {};
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  if (player_id && !ownPlayer(req.user.id, player_id)) return res.status(404).json({ error: 'player not found' });
  const key = crypto.randomBytes(18).toString('base64url');
  try {
    const info = db.prepare('INSERT INTO devices (device_id, device_key, owner_id, player_id, name) VALUES (?, ?, ?, ?, ?)')
      .run(String(device_id), key, req.user.id, player_id || null, name || null);
    const device = db.prepare('SELECT id, device_id, player_id, name, last_seen FROM devices WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ device, device_key: key });   // key shown once — paste into firmware
  } catch { res.status(409).json({ error: 'device already registered' }); }
});
app.get('/api/devices', auth, (req, res) =>
  res.json({ devices: db.prepare('SELECT id, device_id, player_id, name, last_seen, created_at FROM devices WHERE owner_id = ?').all(req.user.id) }));

// ---- live streams (EventSource) ----
// token comes via query string because EventSource can't set headers.
app.get('/api/stream', (req, res) => {
  let user; try { user = jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch { return res.status(401).end(); }
  startSse(req, res, user.id);
});
app.get('/api/public/stream', (req, res) => startSse(req, res, DEMO_OWNER));

const platformTotals = () => ({
  players: db.prepare('SELECT COUNT(*) c FROM players').get().c,
  impacts: db.prepare('SELECT COUNT(*) c FROM impacts').get().c,
  flagged: db.prepare('SELECT COUNT(*) c FROM impacts WHERE flagged = 1').get().c,
});

app.get('/api/public/stats', (_req, res) => res.json(platformTotals()));

// waitlist signup
app.post('/api/public/waitlist', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const role = (req.body || {}).role || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  try { db.prepare('INSERT INTO waitlist (email, role) VALUES (?, ?)').run(email, role); }
  catch { /* duplicate email — treat as success */ }
  res.status(201).json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM waitlist').get().c });
});
app.get('/api/public/waitlist/count', (_req, res) =>
  res.json({ count: db.prepare('SELECT COUNT(*) c FROM waitlist').get().c }));

app.post('/api/public/impacts', (req, res) => {
  let { linear_g, angular_accel } = req.body || {};
  linear_g = Number(linear_g); angular_accel = Number(angular_accel);
  if (!isFinite(linear_g) || !isFinite(angular_accel))
    return res.status(400).json({ error: 'linear_g, angular_accel required' });
  linear_g = Math.max(0, Math.min(200, linear_g));            // clamp to sane sensor range
  angular_accel = Math.max(0, Math.min(15000, angular_accel));
  const { severity, flagged } = classify(linear_g, angular_accel);
  const info = db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)')
    .run(DEMO_PLAYER, Math.round(linear_g * 10) / 10, Math.round(angular_accel), severity, flagged);
  const impact = db.prepare('SELECT * FROM impacts WHERE id = ?').get(info.lastInsertRowid);
  broadcast('impact', impact, DEMO_OWNER);
  if (flagged) broadcast('concussion_alert', impact, DEMO_OWNER);
  res.status(201).json({ severity, flagged, totals: platformTotals() });
});

// ---- auth ----
app.post('/api/auth/register', (req, res) => {
  const { email, password, name, team } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare('INSERT INTO users (email, password_hash, name, team) VALUES (?, ?, ?, ?)')
    .run(String(email).toLowerCase(), hash, name, team || null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(String(password), user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

// update account name / team / settings (alert thresholds + notification prefs)
app.patch('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, team, settings } = req.body || {};
  const merged = settings ? JSON.stringify({ ...userSettings(user), ...settings }) : user.settings;
  db.prepare('UPDATE users SET name = COALESCE(?, name), team = COALESCE(?, team), settings = ? WHERE id = ?')
    .run(name ?? null, team ?? null, merged, user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

// ---- players ----
app.get('/api/players', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM impacts i WHERE i.player_id = p.id) AS impact_count,
      (SELECT COUNT(*) FROM impacts i WHERE i.player_id = p.id AND i.flagged = 1) AS flagged_count,
      (SELECT MAX(i.linear_g) FROM impacts i WHERE i.player_id = p.id) AS peak_g,
      (SELECT i.linear_g FROM impacts i WHERE i.player_id = p.id ORDER BY i.created_at DESC LIMIT 1) AS last_g,
      (SELECT i.angular_accel FROM impacts i WHERE i.player_id = p.id ORDER BY i.created_at DESC LIMIT 1) AS last_ang
    FROM players p WHERE p.owner_id = ? ORDER BY p.created_at DESC`).all(req.user.id);
  res.json({ players: rows });
});

app.post('/api/players', auth, (req, res) => {
  const { name, jersey, position } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO players (owner_id, name, jersey, position) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, jersey ?? null, position || null);
  res.status(201).json({ player: db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/players/:id', auth, (req, res) => {
  if (!ownPlayer(req.user.id, req.params.id)) return res.status(404).json({ error: 'Player not found' });
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- impacts ----
app.post('/api/impacts', auth, (req, res) => {
  const { player_id, linear_g, angular_accel } = req.body || {};
  if (!player_id || linear_g == null || angular_accel == null)
    return res.status(400).json({ error: 'player_id, linear_g, angular_accel required' });
  if (!ownPlayer(req.user.id, player_id)) return res.status(404).json({ error: 'Player not found' });

  const { severity, flagged } = classify(Number(linear_g), Number(angular_accel), settingsForUser(req.user.id));
  const info = db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)')
    .run(player_id, Number(linear_g), Number(angular_accel), severity, flagged);
  const impact = db.prepare('SELECT * FROM impacts WHERE id = ?').get(info.lastInsertRowid);
  broadcast('impact', impact, req.user.id);
  if (flagged) broadcast('concussion_alert', impact, req.user.id);
  res.status(201).json({ impact });
});

app.get('/api/impacts', auth, (req, res) => {
  const { player_id, limit } = req.query;
  const lim = Math.min(Number(limit) || 50, 200);
  let rows;
  if (player_id) {
    if (!ownPlayer(req.user.id, player_id)) return res.status(404).json({ error: 'Player not found' });
    rows = db.prepare('SELECT * FROM impacts WHERE player_id = ? ORDER BY created_at DESC LIMIT ?').all(player_id, lim);
  } else {
    rows = db.prepare(`
      SELECT i.*, p.name AS player_name, p.jersey FROM impacts i
      JOIN players p ON p.id = i.player_id
      WHERE p.owner_id = ? ORDER BY i.created_at DESC LIMIT ?`).all(req.user.id, lim);
  }
  res.json({ impacts: rows });
});

// ---- aggregate stats for the dashboard ----
app.get('/api/stats', auth, (req, res) => {
  const base = `FROM impacts i JOIN players p ON p.id = i.player_id WHERE p.owner_id = ?`;
  const players = db.prepare('SELECT COUNT(*) c FROM players WHERE owner_id = ?').get(req.user.id).c;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(req.user.id).c;
  const flagged = db.prepare(`SELECT COUNT(*) c ${base} AND i.flagged = 1`).get(req.user.id).c;
  const peak = db.prepare(`SELECT MAX(i.linear_g) m ${base}`).get(req.user.id).m || 0;
  res.json({ players, impacts: total, flagged, peak_g: Math.round(peak) });
});

// ---- player portal (role: player) ----
const linkedPlayer = (userId) => db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);

app.post('/api/player/register', (req, res) => {
  const { email, password, name, jersey, position } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const lc = String(email).toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(lc)) return res.status(409).json({ error: 'Email already registered' });

  const uid = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(lc, bcrypt.hashSync(String(password), 10), name, 'player').lastInsertRowid;
  db.prepare('INSERT INTO players (owner_id, user_id, name, jersey, position) VALUES (?, ?, ?, ?, ?)')
    .run(uid, uid, name, jersey ?? null, position || null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/player/me', auth, (req, res) => {
  const p = linkedPlayer(req.user.id);
  if (!p) return res.status(404).json({ error: 'No player profile for this account' });
  const one = (q) => db.prepare(q).get(p.id);
  const stats = {
    impacts: one('SELECT COUNT(*) c FROM impacts WHERE player_id = ?').c,
    flagged: one('SELECT COUNT(*) c FROM impacts WHERE player_id = ? AND flagged = 1').c,
    peak_g: Math.round(one('SELECT MAX(linear_g) m FROM impacts WHERE player_id = ?').m || 0),
    last: one('SELECT * FROM impacts WHERE player_id = ? ORDER BY created_at DESC LIMIT 1') || null,
  };
  const checkin = one('SELECT * FROM checkins WHERE player_id = ? ORDER BY created_at DESC LIMIT 1') || null;
  const lastFlag = one('SELECT created_at FROM impacts WHERE player_id = ? AND flagged = 1 ORDER BY created_at DESC LIMIT 1');
  let clearance = 'cleared';
  if (checkin && checkin.status === 'symptoms') clearance = 'monitor';
  else if (lastFlag && (!checkin || lastFlag.created_at > checkin.created_at)) clearance = 'flagged';
  res.json({
    player: { id: p.id, name: p.name, jersey: p.jersey, position: p.position, weight: p.weight, neck_strength: p.neck_strength, hydration: p.hydration },
    stats, checkin, clearance
  });
});

// update the player's own profile (personalizes their concussion threshold)
app.patch('/api/player/me', auth, (req, res) => {
  const p = linkedPlayer(req.user.id);
  if (!p) return res.status(404).json({ error: 'No player profile' });
  const { name, jersey, position, weight, neck_strength, hydration } = req.body || {};
  db.prepare(`UPDATE players SET name = COALESCE(?, name), jersey = COALESCE(?, jersey), position = COALESCE(?, position),
      weight = COALESCE(?, weight), neck_strength = COALESCE(?, neck_strength), hydration = COALESCE(?, hydration) WHERE id = ?`)
    .run(name ?? null, jersey ?? null, position ?? null, weight ?? null, neck_strength ?? null,
         hydration == null ? null : (hydration ? 1 : 0), p.id);
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  const up = db.prepare('SELECT * FROM players WHERE id = ?').get(p.id);
  res.json({ player: { id: up.id, name: up.name, jersey: up.jersey, position: up.position, weight: up.weight, neck_strength: up.neck_strength, hydration: up.hydration } });
});

// ---- trainer <-> player messages ----
app.get('/api/messages', auth, (req, res) => {
  let pid;
  if (req.query.player_id) {
    if (!ownPlayer(req.user.id, req.query.player_id)) return res.status(404).json({ error: 'Player not found' });
    pid = Number(req.query.player_id);
  } else {
    const p = linkedPlayer(req.user.id);
    if (!p) return res.status(404).json({ error: 'No player profile' });
    pid = p.id;
  }
  res.json({ messages: db.prepare('SELECT id, sender, body, created_at FROM messages WHERE player_id = ? ORDER BY created_at ASC LIMIT 200').all(pid) });
});
app.post('/api/messages', auth, (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  let pid, sender;
  if (req.query.player_id) {                                  // a coach messaging one of their players
    if (!ownPlayer(req.user.id, req.query.player_id)) return res.status(404).json({ error: 'Player not found' });
    pid = Number(req.query.player_id); sender = 'trainer';
  } else {                                                     // a player messaging their trainer
    const p = linkedPlayer(req.user.id);
    if (!p) return res.status(404).json({ error: 'No player profile' });
    pid = p.id; sender = 'player';
  }
  const info = db.prepare('INSERT INTO messages (player_id, sender, body) VALUES (?, ?, ?)').run(pid, sender, body);
  const msg = db.prepare('SELECT id, sender, body, created_at FROM messages WHERE id = ?').get(info.lastInsertRowid);
  const owner = db.prepare('SELECT owner_id FROM players WHERE id = ?').get(pid).owner_id;
  broadcast('message', { ...msg, player_id: pid }, owner);
  res.status(201).json({ message: msg });
});

app.get('/api/player/impacts', auth, (req, res) => {
  const p = linkedPlayer(req.user.id);
  if (!p) return res.status(404).json({ error: 'No player profile' });
  res.json({ impacts: db.prepare('SELECT * FROM impacts WHERE player_id = ? ORDER BY created_at DESC LIMIT 50').all(p.id) });
});

app.post('/api/player/checkin', auth, (req, res) => {
  const p = linkedPlayer(req.user.id);
  if (!p) return res.status(404).json({ error: 'No player profile' });
  const { status, note } = req.body || {};
  if (!['ok', 'symptoms'].includes(status)) return res.status(400).json({ error: "status must be 'ok' or 'symptoms'" });
  db.prepare('INSERT INTO checkins (player_id, status, note) VALUES (?, ?, ?)').run(p.id, status, note || null);
  res.status(201).json({ ok: true });
});

app.listen(PORT, () => console.log(`Axon backend listening on http://localhost:${PORT}`));
