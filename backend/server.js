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
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, created_at: u.created_at });

function classify(linearG, angularAccel) {
  // Thresholds aligned with the site's biomechanics copy
  if (linearG >= 70 || angularAccel >= 4500) return { severity: 'concussion-risk', flagged: 1 };
  if (linearG >= 40 || angularAccel >= 2500) return { severity: 'elevated', flagged: 0 };
  return { severity: 'routine', flagged: 0 };
}

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
  db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)')
    .run(DEMO_PLAYER, Math.round(linear_g * 10) / 10, Math.round(angular_accel), severity, flagged);
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

// ---- players ----
app.get('/api/players', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM impacts i WHERE i.player_id = p.id) AS impact_count,
      (SELECT COUNT(*) FROM impacts i WHERE i.player_id = p.id AND i.flagged = 1) AS flagged_count
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

  const { severity, flagged } = classify(Number(linear_g), Number(angular_accel));
  const info = db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)')
    .run(player_id, Number(linear_g), Number(angular_accel), severity, flagged);
  res.status(201).json({ impact: db.prepare('SELECT * FROM impacts WHERE id = ?').get(info.lastInsertRowid) });
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
  res.json({ player: { id: p.id, name: p.name, jersey: p.jersey, position: p.position }, stats, checkin, clearance });
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
