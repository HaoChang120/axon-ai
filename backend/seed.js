// Seed a demo coach with players and impact history.
const bcrypt = require('bcryptjs');
const db = require('./db');

const email = 'coach@axon.ai', pass = 'axon1234';
db.prepare('DELETE FROM users WHERE email = ?').run(email); // cascade clears players/impacts

const info = db.prepare('INSERT INTO users (email, password_hash, name, team) VALUES (?, ?, ?, ?)')
  .run(email, bcrypt.hashSync(pass, 10), 'Demo Coach', 'Orange County HS');
const owner = info.lastInsertRowid;

const roster = [
  ['Marcus Reed', 54, 'Linebacker'],
  ['Tyler Cross', 12, 'Quarterback'],
  ['Andre Sims', 88, 'Wide Receiver'],
  ['Hao Chang', 91, 'Defensive End'],
];
const classify = (g, a) => (g >= 70 || a >= 4500) ? ['concussion-risk', 1] : (g >= 40 || a >= 2500) ? ['elevated', 0] : ['routine', 0];

for (const [name, jersey, pos] of roster) {
  const pid = db.prepare('INSERT INTO players (owner_id, name, jersey, position) VALUES (?, ?, ?, ?)')
    .run(owner, name, jersey, pos).lastInsertRowid;
  const n = 4 + Math.floor(Math.random() * 5);
  for (let k = 0; k < n; k++) {
    const big = Math.random() > 0.78;
    const g = big ? 72 + Math.random() * 33 : 10 + Math.random() * 30;
    const a = big ? 4500 + Math.random() * 2700 : 350 + Math.random() * 1600;
    const [sev, fl] = classify(g, a);
    db.prepare('INSERT INTO impacts (player_id, linear_g, angular_accel, severity, flagged) VALUES (?, ?, ?, ?, ?)')
      .run(pid, Math.round(g * 10) / 10, Math.round(a), sev, fl);
  }
}
console.log(`Seeded. Login -> email: ${email}  password: ${pass}`);
