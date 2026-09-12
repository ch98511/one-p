# Flock Camera Radar

A phone web app (PWA) that puts **automated license-plate readers (ALPR)** —
including **Flock Safety** — and other public surveillance on a **live map**,
**alerts** you as you approach one, overlays **live weather radar**, and plans
**constraint-aware routes** that can **avoid cameras**, tolls, highways, ferries,
or any area you draw.

Everything runs on your device against free, keyless public services. What
leaves your phone is just coordinates — a bounding-box camera query, a
destination geocode, and a route request. No account, no tracking. It's for
**privacy awareness** — a public-surveillance radar with a router attached.

## What it does

- 🗺️ **Live map base** — Dark / Streets / Satellite (switch top-right)
- 📡 **Surveillance layers** — Flock cameras · other ALPR · all public
  surveillance, from **OpenStreetMap** (the crowd-sourced
  [DeFlock](https://deflock.me) dataset), each a toggleable layer
- 🌧️ **Live weather radar** overlay (animated) from **RainViewer**
- ⚠️ **Proximity alerts** — banner + notification + sound + vibration when the
  nearest ALPR/Flock camera is within your alert distance (default 150 m)
- 🧭 **Constraint-aware routing** — search a destination, then:
  - 🚫 **Avoid ALPR/Flock cameras** (uses the same camera data as the alerts)
  - 🚫 Avoid **tolls / highways / ferries**
  - ✏️ **Draw an avoid area** on the map (hard exclude)
  - 📍 **Must-pass waypoints**
  - 🚗🚲🚶 Drive / bike / walk
  - turn-by-turn directions, distance & time — via **Valhalla**
- ⏺️ **Record your tracks** — start/pause/stop, live distance/time, saved on-device
  (IndexedDB), viewable on the map, exportable as GPX
- 🔐 **Encrypted backups** — export tracks as an **AES-256 password-protected ZIP**
  (openable in 7-Zip / Keka / WinZip); restore them with the same PIN
- 📶 Installs to your home screen and launches offline (last-seen cameras cached)

> **How routing constraints work:** each control becomes a field in a real
> routing-engine request (avoid = soft penalty, exclude = hard block, must-pass
> = required waypoint). The full policy→engine mapping, a production backend
> (PostGIS + rule engine + self-hosted Valhalla/GraphHopper), and the build
> order are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Try it right now (no deploy)

The whole app is static files in [`docs/`](docs/). GPS and notifications require
**HTTPS** (or `localhost`), so serve it, don't just double-click the HTML:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000 on the same machine
```

## Put it on your phone (free, ~2 min) — GitHub Pages

1. Push this branch and open the repo on GitHub → **Settings → Pages**.
2. **Build and deployment → Source: Deploy from a branch.**
3. Pick this branch and folder **`/docs`**, then **Save**.
4. Wait ~1 minute; GitHub gives you an `https://<user>.github.io/<repo>/` URL.
5. Open that URL on your phone, allow **Location** and **Notifications**, tap
   **Start alerts**. Use your browser's **Add to Home Screen** to install it.

## Data sources (all free / keyless)

| Layer / feature | Source | Notes |
|---|---|---|
| Cameras & surveillance | OpenStreetMap **Overpass** (DeFlock) | bounding-box query around you |
| Weather radar | **RainViewer** `api.rainviewer.com` | animated past + latest frame |
| Destination search | **Nominatim** (OpenStreetMap) | free-form geocoding |
| Routing | **Valhalla** `valhalla1.openstreetmap.de` | public demo; override in Settings |
| Base map tiles | OpenStreetMap · CARTO · Esri | dark / streets / satellite |

Public demo servers are rate-limited — fine for personal use and development.
**Settings → Routing engine** lets you point at your own Valhalla instance
(see [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md)).

## How the camera pipeline works

`docs/app.js` queries the Overpass API for OpenStreetMap surveillance nodes
around your position and sorts them into **flock / alpr / cctv**:

```overpassql
[out:json][timeout:25];
(
  node["man_made"="surveillance"]["surveillance:type"~"ALPR",i](around:R,LAT,LON);
  node["man_made"="surveillance"]["manufacturer"~"Flock",i](around:R,LAT,LON);
  node["man_made"="surveillance"]["brand"~"Flock",i](around:R,LAT,LON);
);
out body;
```

(Turning on *Fetch all public surveillance cameras* broadens this to every
`man_made=surveillance` node in range.) Distances and bearings are recomputed
on-device on every GPS update; it re-fetches when you move far enough.

## Honest limitations

- **Background alerts are limited for web apps**, especially on iOS — reliable
  alerting needs the app in the foreground. "Keep screen awake" is on by default.
  A native shell (Capacitor/React Native) reusing this pipeline is the path to
  always-on alerts.
- Coverage depends on OpenStreetMap contributors — a missing camera means nobody
  has mapped it yet, not that none exists.
- Public routing/geocoding servers can rate-limit or be briefly unavailable.
- **Don't stare at your phone while driving.** Use audio/vibration cues.

## Files

```
docs/
  index.html            map-first UI (search, dock, sheets)
  styles.css            styles
  app.js                orchestration: map, cameras, alerts, GPS, route + tracks UI
  routing.js            geocoding + constraint-aware routing (Valhalla)
  layers.js             map base + weather radar + layer control
  tracks.js             track recording storage (IndexedDB) + encrypted-zip backup
  vendor/zip.min.js     zip.js (AES-256 encrypted ZIP) — vendored, offline-capable
  sw.js                 service worker (offline shell + notifications)
  manifest.webmanifest  PWA install metadata
  icons/                app icons
  ARCHITECTURE.md       policy→engine mapping, tracks/backup, always-on, backend plan
backend/                self-hosted Valhalla + PostGIS + camera import (docker)
tools/make-icons.mjs    regenerates the PNG icons
```

### Recording, background & backups — what's real

- Recording and alerts run **while the app is open** (screen kept awake) and
  resume when you reopen it. A web app **can't** record in the background or
  launch at phone startup — that needs a native wrapper (Capacitor). The path is
  in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8 (Always-on).
- The backup PIN is **not** your device unlock PIN (browsers can't read that) —
  it's a passphrase you set in the app; you can reuse your phone's digits. Lose
  it and the encrypted backup can't be recovered.
