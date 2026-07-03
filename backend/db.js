// Axon AI — database layer (Node built-in SQLite, no native deps)
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.AXON_DB || path.join(__dirname, 'axon.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'coach',   -- coach | admin
    team          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS players (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    jersey      INTEGER,
    position    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS impacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL,
    linear_g      REAL NOT NULL,         -- peak linear acceleration (g)
    angular_accel REAL NOT NULL,         -- peak angular acceleration (rad/s^2)
    severity      TEXT NOT NULL,         -- routine | elevated | concussion-risk
    flagged       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL,
    status      TEXT NOT NULL,         -- ok | symptoms
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT UNIQUE NOT NULL,
    role        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- a physical helmet: the firmware authenticates with device_key and posts impacts
  CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT UNIQUE NOT NULL,   -- Particle device id (or any hardware id)
    device_key  TEXT NOT NULL,          -- shared secret the firmware sends in X-Device-Key
    owner_id    INTEGER,                -- coach account that registered it
    player_id   INTEGER,                -- which player currently wears it
    name        TEXT,
    last_seen   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id)  REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);

  CREATE INDEX IF NOT EXISTS idx_players_owner ON players(owner_id);
  CREATE INDEX IF NOT EXISTS idx_impacts_player ON impacts(player_id);
  CREATE INDEX IF NOT EXISTS idx_checkins_player ON checkins(player_id);
`);

// migration: link a player record to a login account (role 'player')
try { db.exec('ALTER TABLE players ADD COLUMN user_id INTEGER'); } catch { /* column exists */ }

module.exports = db;
