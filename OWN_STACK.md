# Axon — your own end-to-end stack

You now own every layer. No Particle Cloud, no Firebase, no FlutterFlow in the data path.

```
Your firmware on Boron  ──HTTP POST──▶  your API  ──▶  your SQLite  ──SSE──▶  your app (PWA)
 axon_helmet_v2.ino                     backend/server.js               app.html
```

Verified working end to end on 2026-07-02: a firmware-style POST to `/api/ingest`
fired the live concussion alert in the app with zero cloud middlemen.

## 1. Firmware  (`~/axon-firmware/axon_helmet_v2.ino`)
Reads the BNO085 + FSR/ADS1115 exactly like v1, but instead of `Particle.publish`
it does an HTTP `POST /api/ingest` over cellular with two headers:
`X-Device-Id` and `X-Device-Key`. The Boron still keeps its Particle link **only**
for OTA flashing.

Before flashing, edit the top of the file:
- `API_HOST` / `API_PORT` — your server (LAN IP for local testing, or your host)
- `DEVICE_ID` — the Particle device id (or `System.deviceID()`)
- `DEVICE_KEY` — from step 2 below

Flash via the Particle Web IDE (same as v1: add `Adafruit_BNO08x_Sahagun` +
`Adafruit_ADS1X15`, paste, flash OTA).

> **HTTPS note:** `TCPClient` speaks plain HTTP. For a production HTTPS host you have
> two clean options: (a) run the API on a plain-HTTP port on your own box/VPS, or
> (b) keep v1 firmware and add a Particle **webhook** that forwards
> `impact_data` → `POST https://your-api/api/ingest` (still lands in *your* DB).

## 2. Backend  (`~/axon-site/backend`)
Node + Express + built-in SQLite. New in this build:
- `POST /api/ingest` — device-key auth; the firmware posts here.
- `GET  /api/stream?token=<jwt>` — live SSE feed for the app (per-coach scoped).
- `GET  /api/public/stream` — SSE for the public/demo player.
- `POST /api/devices` / `GET /api/devices` — register a helmet, get its `device_key`.

Run locally:
```
cd ~/axon-site/backend && npm install && npm start   # http://localhost:4000
```
Register a helmet (returns the device_key to paste into the firmware):
```
# after logging in as a coach to get <JWT>:
curl -X POST http://localhost:4000/api/devices \
  -H "Authorization: Bearer <JWT>" -H 'Content-Type: application/json' \
  -d '{"device_id":"e00fce68baab0b648b3d9899","name":"Axon_Main_Module","player_id":1}'
```

### Deploy the API to Render (free)
1. Push `backend/` to a GitHub repo.
2. Render → New → Web Service → point at the repo, root `backend/`.
3. Build: `npm install` · Start: `npm start` · Node 22+.
4. Add a disk (for `axon.db`) or set `AXON_DB` to a mounted path so data persists.
5. Set env `AXON_JWT_SECRET` to a long random string.
6. Your API is now `https://your-axon-api.onrender.com`.

## 3. App  (`~/axon-site/app.html`)  — PWA
Same app, now installable. In **Profile → Device & Pairing** there are two tabs:
- **Particle Cloud** — paste a Particle token (the original path).
- **My Axon API** — enter your API URL + your coach email/password; the app logs in
  and streams live from `GET /api/stream`. This is the fully-owned path.

Installable: `manifest.webmanifest` + `sw.js` are wired in. On iPhone: Share → Add to
Home Screen. It launches full-screen with your icon and works offline.

### Wrap for the App Store with Capacitor
```
npm create @capacitor/app axon-app        # or: npm i @capacitor/core @capacitor/cli
npx cap init "Axon AI" ai.axon.app
# put app.html + manifest + sw.js + icons in the Capacitor webDir (e.g. www/)
npx cap add ios
npx cap copy && npx cap open ios          # opens Xcode → run on device / submit
```
One codebase, your code, in the App Store — replacing the FlutterFlow build.
