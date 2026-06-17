# Axon AI — Backend

Auth + players + impact-event logging for the Axon AI platform. Node/Express with a
SQLite database (Node's built-in `node:sqlite` — no native build step). Includes a
coach console served at `/`.

## Run locally
```bash
cd backend
npm install
npm run seed     # optional: demo coach + roster + impact history
npm start        # http://localhost:4000
```
Demo login (after seeding): **coach@axon.ai** / **axon1234**

## Data model
- **users** — coaches/admins (email, bcrypt password hash, role, team)
- **players** — roster owned by a coach (name, jersey, position)
- **impacts** — logged head impacts (linear g, angular rad/s², auto-classified severity + concussion flag)

Severity is derived server-side: `concussion-risk` at ≥70 g or ≥4500 rad/s²,
`elevated` at ≥40 g or ≥2500 rad/s², else `routine` — matching the thresholds on the marketing site.

## API
| Method | Route | Auth | Body / notes |
|---|---|---|---|
| GET | `/api/health` | – | service check |
| POST | `/api/auth/register` | – | `{email, password, name, team?}` → `{token, user}` |
| POST | `/api/auth/login` | – | `{email, password}` → `{token, user}` |
| GET | `/api/me` | ✓ | current user |
| GET | `/api/players` | ✓ | roster + impact counts |
| POST | `/api/players` | ✓ | `{name, jersey?, position?}` |
| DELETE | `/api/players/:id` | ✓ | remove player |
| GET | `/api/impacts` | ✓ | `?player_id=&limit=` |
| POST | `/api/impacts` | ✓ | `{player_id, linear_g, angular_accel}` |
| GET | `/api/stats` | ✓ | dashboard aggregates |

Auth is a JWT bearer token (`Authorization: Bearer <token>`), 7-day expiry.

## Environment
- `PORT` — default 4000
- `AXON_JWT_SECRET` — **set a strong value in production**
- `AXON_DB` — SQLite file path (default `./axon.db`)

## Free hosting (Render)
1. Push this repo to GitHub (already done).
2. render.com → New → Web Service → connect the repo.
3. Root directory `backend`, build `npm install`, start `npm start`.
4. Add env var `AXON_JWT_SECRET`. Add a persistent disk if you want the SQLite file to survive deploys
   (or swap SQLite for Render Postgres / Firebase Firestore for production durability).

Other free options: Railway, Fly.io, or Cloudflare Workers (would need a D1/Postgres swap).
