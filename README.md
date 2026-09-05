# Flock Camera Radar

A phone web app (PWA) that warns you when you're approaching an **automated
license-plate reader (ALPR)** — including **Flock Safety** — camera.

Camera locations come from **OpenStreetMap** (the crowd-sourced
[DeFlock](https://deflock.me) dataset). Everything runs on your device; the only
thing that leaves your phone is a bounding-box query around you to fetch nearby
camera locations. It's for **privacy awareness** — think of it like a
public-camera radar.

## What it does

- 📍 Watches your GPS location in real time
- 🛰️ Pulls ALPR / Flock camera locations near you from OpenStreetMap (Overpass API)
- 🗺️ Shows you and the cameras on a map
- ⚠️ **Alerts** — banner + system notification + sound + vibration — when the
  nearest camera is within your alert distance (default 150 m)
- ⚙️ Adjustable alert distance, search radius, "Flock only" filter, sound/vibrate/screen-awake toggles
- 📶 Installs to your home screen and launches offline (last-seen cameras cached)

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
   **Start monitoring**. Use your browser's **Add to Home Screen** to install it.

## How the "Flock pipeline" works

`docs/app.js` queries the Overpass API for OpenStreetMap nodes tagged as
surveillance ALPRs or Flock-branded, around your position:

```overpassql
[out:json][timeout:25];
(
  node["man_made"="surveillance"]["surveillance:type"~"ALPR",i](around:R,LAT,LON);
  node["man_made"="surveillance"]["manufacturer"~"Flock",i](around:R,LAT,LON);
  node["man_made"="surveillance"]["brand"~"Flock",i](around:R,LAT,LON);
);
out body;
```

Results are normalized, Flock-tagged ones are flagged, and haversine distance +
bearing to each is recomputed on every GPS update. It re-fetches when you move
far enough from the last query center.

## Honest limitations

- **Background alerts are limited for web apps**, especially on iOS — reliable
  alerting needs the app in the foreground. "Keep screen awake" is on by default
  to help. A true native app (via Capacitor/React Native) is the path to
  always-on background alerts; this shares the same data pipeline.
- Coverage depends on OpenStreetMap contributors — a missing camera means nobody
  has mapped it yet, not that none exists.
- **Don't stare at your phone while driving.** Use audio/vibration cues.

## Files

```
docs/
  index.html            UI
  styles.css            styles
  app.js                geolocation, camera pipeline, distance math, alerts
  sw.js                 service worker (offline shell + notifications)
  manifest.webmanifest  PWA install metadata
  icons/                app icons
tools/make-icons.mjs    regenerates the PNG icons
```
