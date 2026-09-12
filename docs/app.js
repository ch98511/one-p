/* Flock Camera Radar — map-first build.
 *
 *  • Live map base (dark/streets/satellite) with layers
 *  • Weather radar overlay (RainViewer)                       [layers.js]
 *  • Camera / Flock / public-surveillance locations (Overpass/OSM)
 *  • Proximity alerts when you near an ALPR/Flock camera
 *  • Constraint-aware routing (avoid tolls/highways/ferries/
 *    cameras/areas, must-pass waypoints)                      [routing.js]
 *
 * All processing is on-device. What leaves the phone: bounding-box camera
 * queries (Overpass), destination geocoding (Nominatim), and route requests
 * (Valhalla) — each just coordinates, no identity.
 */
(() => {
  "use strict";
  const FCR = (window.FCR = window.FCR || {});

  // ---------- Settings ----------
  const DEFAULTS = {
    alertR: 150,          // m: alert when nearest ALPR/Flock camera is within this
    fetchKm: 3,           // km: radius to fetch cameras around you
    includeAllSurv: false,// also fetch non-ALPR public surveillance cameras
    layerFlock: true, layerAlpr: true, layerCctv: false,
    sound: true, vibrate: true, wake: true,
    routeEndpoint: "",    // blank = default public Valhalla
    rememberPin: false,   // persist the backup PIN on this device (less safe)
    backupPin: "",        // only used when rememberPin is true
    autoBackup: false,    // download an encrypted backup when a track is stopped
  };
  const load = () => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("fcr.settings") || "{}") }; }
    catch { return { ...DEFAULTS }; }
  };
  const save = () => { try { localStorage.setItem("fcr.settings", JSON.stringify(settings)); } catch {} };
  let settings = load();

  const $ = (id) => document.getElementById(id);

  // ---------- State ----------
  let map = null, layersApi = null, radar = null;
  let watchId = null, pos = null, swReg = null, audioCtx = null, wakeLock = null;
  let monitoring = false;         // alerts on (shares the geolocation watch)

  let cameras = [];               // normalized [{id,lat,lon,category,name,type}]
  let lastFetchCenter = null, lastFetchAt = 0, fetching = false;
  const alerted = new Map();      // cameraId -> lastAlertTime

  // Track recording
  let recording = false, paused = false;
  let currentTrack = null, trackLine = null, recTimer = null;
  let backupPin = "";             // in-memory unless "remember" is on

  // Map layers
  let gFlock, gAlpr, gCctv;       // camera groups
  let userMarker = null, accCircle = null;
  let routeGroup, avoidGroup;     // route + avoid-area drawing
  let trackGroup, savedTrackGroup;// live recording line + saved-track viewer

  // Routing model
  const R = {
    start: null,                  // {lat,lon,label}  (null => use my location)
    startAuto: true,              // use my location as start
    dest: null,                   // {lat,lon,label}
    mode: "auto",
    avoid: { tolls: false, highways: false, ferries: false, cameras: false },
    waypoints: [],                // [{lat,lon,marker}]
    areas: [],                    // [{layer, ring:[[lon,lat],...]}]
    result: null,                 // last route result
  };

  // Map interaction mode: null | 'start' | 'dest' | 'waypoint' | 'draw'
  let tapMode = null;
  let drawBuffer = [];            // [{lat,lon}] while drawing an area
  let drawPreview = null, drawMarkers = null;

  // ---------- Geo math ----------
  const R_EARTH = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  function distance(aLat, aLon, bLat, bLon) {
    const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  }
  function bearing(aLat, aLon, bLat, bLon) {
    const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  const fmtKm = (km) => (km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km");
  const fmtMin = (min) => (min >= 60 ? Math.floor(min / 60) + " h " + Math.round(min % 60) + " min" : Math.round(min) + " min");
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  // ---------- Camera pipeline (Overpass / OpenStreetMap) ----------
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  function buildQuery(lat, lon, radiusM) {
    const r = Math.round(radiusM);
    if (settings.includeAllSurv) {
      // Every mapped public surveillance camera in range.
      return `[out:json][timeout:25];
(node["man_made"="surveillance"](around:${r},${lat},${lon}););
out body;`;
    }
    // Just ALPR + Flock-branded.
    return `[out:json][timeout:25];
(
  node["man_made"="surveillance"]["surveillance:type"~"ALPR",i](around:${r},${lat},${lon});
  node["man_made"="surveillance"]["manufacturer"~"Flock",i](around:${r},${lat},${lon});
  node["man_made"="surveillance"]["brand"~"Flock",i](around:${r},${lat},${lon});
);
out body;`;
  }
  function categorize(t) {
    const vendor = (t.manufacturer || t.brand || t.operator || "").toString();
    if (/flock/i.test(vendor)) return "flock";
    if (/alpr|anpr|licen[cs]e|plate/i.test((t["surveillance:type"] || "") + " " + (t.description || ""))) return "alpr";
    return "cctv";
  }
  function normalize(elements) {
    const out = [];
    for (const e of elements) {
      if (e.type !== "node" || typeof e.lat !== "number") continue;
      const t = e.tags || {};
      const category = categorize(t);
      const vendor = (t.manufacturer || t.brand || t.operator || "").toString();
      out.push({
        id: e.id, lat: e.lat, lon: e.lon, category,
        name: vendor || (category === "flock" ? "Flock camera" : category === "alpr" ? "ALPR camera" : "Surveillance camera"),
        type: t["surveillance:type"] || t["camera:type"] || t.surveillance || "camera",
      });
    }
    return out;
  }
  async function fetchCameras(lat, lon) {
    if (fetching) return;
    fetching = true;
    setSub("Loading cameras near you…");
    const query = buildQuery(lat, lon, settings.fetchKm * 1000);
    let ok = false;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        cameras = normalize(json.elements || []);
        lastFetchCenter = { lat, lon }; lastFetchAt = Date.now(); ok = true;
        try { localStorage.setItem("fcr.cache", JSON.stringify({ at: lastFetchAt, center: lastFetchCenter, cameras })); } catch {}
        break;
      } catch (err) { console.warn("Overpass failed:", url, err); }
    }
    fetching = false;
    if (!ok) setSub("Couldn't reach the camera database — will retry. Showing last known data.");
    renderCameras();
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem("fcr.cache") || "null");
      if (c && Array.isArray(c.cameras)) { cameras = c.cameras; lastFetchCenter = c.center; }
    } catch {}
  }

  // Cameras that should trigger alerts / be used for camera-avoidance routing.
  const alertable = () => cameras.filter((c) => c.category === "flock" || c.category === "alpr");

  // ---------- Camera rendering ----------
  const CAM_STYLE = {
    flock: { color: "#38bdf8", label: "Flock" },
    alpr: { color: "#f59e0b", label: "ALPR" },
    cctv: { color: "#fb7185", label: "Surveillance" },
  };
  function renderCameras() {
    if (!map) return;
    gFlock.clearLayers(); gAlpr.clearLayers(); gCctv.clearLayers();
    const counts = { flock: 0, alpr: 0, cctv: 0 };
    for (const c of cameras) {
      counts[c.category]++;
      const st = CAM_STYLE[c.category];
      const grp = c.category === "flock" ? gFlock : c.category === "alpr" ? gAlpr : gCctv;
      const d = pos ? distance(pos.lat, pos.lon, c.lat, c.lon) : null;
      L.circleMarker([c.lat, c.lon], { radius: 6, color: st.color, weight: 2, fillColor: st.color, fillOpacity: 0.6, pane: "markerPane" })
        .bindPopup(`<b>${escapeHtml(c.name)}</b><br>${escapeHtml(st.label)} · ${escapeHtml(c.type)}${d != null ? "<br>" + fmtM(d) + " away" : ""}`)
        .addTo(grp);
    }
    $("cntFlock").textContent = counts.flock;
    $("cntAlpr").textContent = counts.alpr;
    $("cntCctv").textContent = counts.cctv;
    evaluate();
  }

  // ---------- Alert evaluation ----------
  function setStatus(cls, big, label, sub) {
    const s = $("statusCard");
    s.className = "status status--" + cls;
    if (big !== undefined) $("nearestDist").textContent = big;
    if (label !== undefined) $("statusLabel").textContent = label;
    if (sub !== undefined) $("statusSub").textContent = sub;
  }
  const setSub = (s) => { $("statusSub").textContent = s; };

  function evaluate() {
    if (!pos || !monitoring) return;
    const list = alertable()
      .map((c) => ({ ...c, d: distance(pos.lat, pos.lon, c.lat, c.lon), b: bearing(pos.lat, pos.lon, c.lat, c.lon) }))
      .sort((a, b) => a.d - b.d);
    const nearest = list[0];
    if (!nearest) { setStatus("ok", "—", "No cameras nearby", `Watching within ${settings.fetchKm} km.`); return; }
    const d = nearest.d, dir = `${compass(nearest.b)} · ${nearest.name}`;
    $("nearestDist").textContent = fmtM(d);
    if (d <= settings.alertR) { setStatus("alert", fmtM(d), "⚠ Camera ahead", dir); maybeAlert(nearest); }
    else if (d <= settings.alertR * 2) setStatus("near", fmtM(d), "Getting close", dir);
    else setStatus("ok", fmtM(d), "Clear", `Nearest camera ${dir}`);
    for (const [id] of alerted) { const cam = list.find((c) => c.id === id); if (!cam || cam.d > settings.alertR * 1.8) alerted.delete(id); }
  }
  function maybeAlert(cam) {
    const now = Date.now(); const last = alerted.get(cam.id) || 0;
    if (now - last < 60000) return;
    alerted.set(cam.id, now); fireAlert(cam);
  }
  function fireAlert(cam) {
    const title = cam.category === "flock" ? "⚠ Flock camera ahead" : "⚠ ALPR camera ahead";
    const body = `${fmtM(cam.d)} to your ${compass(cam.b)} · ${cam.name}`;
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 80, 200]);
    if (settings.sound) beep();
    notify(title, body);
  }
  function notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = { body, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: "fcr-alert", renotify: true, vibrate: [200, 80, 200] };
    try { (swReg && swReg.showNotification) ? swReg.showNotification(title, opts) : new Notification(title, opts); }
    catch (e) { console.warn("notify failed", e); }
  }
  function beep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime;
      for (let i = 0; i < 2; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = 880;
        const s = t0 + i * 0.28;
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.4, s + 0.02); g.gain.exponentialRampToValueAtTime(0.001, s + 0.22);
        o.connect(g).connect(audioCtx.destination); o.start(s); o.stop(s + 0.24);
      }
    } catch (e) { console.warn("beep failed", e); }
  }

  // ---------- Geolocation (shared by alerts + recording) ----------
  function updateUserOnMap() {
    if (!map || !pos) return;
    const ll = [pos.lat, pos.lon];
    if (!userMarker) {
      userMarker = L.circleMarker(ll, { radius: 8, color: "#22c55e", weight: 3, fillColor: "#22c55e", fillOpacity: 0.9 }).addTo(map);
      accCircle = L.circle(ll, { radius: pos.acc || 20, color: "#22c55e", weight: 1, fillOpacity: 0.06 }).addTo(map);
      map.setView(ll, 15);
    } else { userMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(pos.acc || 20); }
  }
  // A single watchPosition powers both alerts and recording.
  function ensureGeoWatch() {
    if (watchId != null || !("geolocation" in navigator)) return;
    watchId = navigator.geolocation.watchPosition(onPos, onGeoErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function stopGeoWatchIfIdle() {
    if (!monitoring && !recording && watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }
  function onPos(p) {
    pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, spd: p.coords.speed, alt: p.coords.altitude };
    updateUserOnMap();
    if (recording) recordPoint();
    if (monitoring) {
      const moved = lastFetchCenter ? distance(pos.lat, pos.lon, lastFetchCenter.lat, lastFetchCenter.lon) : Infinity;
      const stale = Date.now() - lastFetchAt > 120000;
      if (moved > settings.fetchKm * 400 || (stale && moved > 200)) fetchCameras(pos.lat, pos.lon);
      renderCameras();
    }
  }
  function onGeoErr(err) {
    console.warn("geo error", err);
    const msg = err.code === 1 ? "Location permission denied. Enable it in your browser settings."
      : err.code === 2 ? "Position unavailable — check GPS / signal." : "Locating timed out — retrying.";
    if (monitoring) setStatus("idle", "—", "GPS problem", msg); else toast(msg);
  }

  // ---------- Alerts monitoring ----------
  async function startMonitoring() {
    if (!("geolocation" in navigator)) { toast("This device has no geolocation."); return; }
    await requestNotifications();
    if (settings.sound) { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} }
    monitoring = true; acquireWakeLock(); ensureGeoWatch();
    $("statusCard").hidden = false;
    setMonitorUI(true);
    setStatus("ok", "…", "Locating", "Getting your GPS position…");
  }
  function stopMonitoring() {
    monitoring = false; stopGeoWatchIfIdle(); if (!recording) releaseWakeLock();
    setMonitorUI(false);
    setStatus("idle", "—", "Alerts off", "Monitoring paused.");
    $("statusCard").hidden = true;
  }
  function setMonitorUI(on) {
    $("monitorBtn").classList.toggle("on", on);
    $("monitorBtn").textContent = on ? "■ Stop alerts" : "▶ Start alerts";
  }

  // ---------- Track recording ----------
  function startRecording() {
    if (recording) return;
    if (!("geolocation" in navigator)) { toast("This device has no geolocation."); return; }
    recording = true; paused = false;
    currentTrack = FCR.Tracks.newTrack();
    trackLine = L.polyline([], { color: "#22c55e", weight: 5, opacity: 0.9 }).addTo(trackGroup);
    acquireWakeLock(); ensureGeoWatch();
    if (pos) recordPoint();               // seed with current fix if we have one
    recTimer = setInterval(updateRecStats, 1000);
    setRecUI(true);
    $("recChip").hidden = false;
    toast("Recording your track. It keeps going while the app is open.");
  }
  async function stopRecording() {
    if (!recording) return;
    recording = false; paused = false;
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    stopGeoWatchIfIdle(); if (!monitoring) releaseWakeLock();
    setRecUI(false); $("recChip").hidden = true;
    const t = currentTrack; currentTrack = null;
    if (trackLine) { trackGroup.removeLayer(trackLine); trackLine = null; }
    if (!t || t.points.length < 2) { toast("Track discarded — too few points."); return; }
    FCR.Tracks.finalize(t);
    await FCR.Tracks.save(t);
    await renderTrackList();
    toast(`Saved: ${fmtKm(t.distanceM / 1000)} in ${fmtDur(t.durationS)}.`);
    if (settings.autoBackup) { const pin = getPin(); if (pin) backupAll(); else toast("Set a backup PIN to auto-back-up."); }
  }
  function togglePauseRecording() {
    if (!recording) return;
    paused = !paused;
    $("pauseBtn").textContent = paused ? "▶ Resume" : "⏸ Pause";
    $("recChip").classList.toggle("paused", paused);
  }
  function recordPoint() {
    if (!recording || paused || !pos || !currentTrack) return;
    const pts = currentTrack.points;
    const pt = { t: Date.now(), lat: pos.lat, lon: pos.lon, acc: pos.acc, spd: pos.spd, alt: pos.alt };
    const last = pts[pts.length - 1];
    // Skip near-duplicate fixes while stationary to keep the track clean.
    if (last && FCR.Tracks.distance(last, pt) < 2 && pt.t - last.t < 10000) return;
    pts.push(pt);
    if (trackLine) trackLine.setLatLngs(pts.map((p) => [p.lat, p.lon]));
    updateRecStats();
  }
  function updateRecStats() {
    if (!currentTrack) return;
    const pts = currentTrack.points;
    const dist = FCR.Tracks.trackDistance(pts);
    const dur = Math.round((Date.now() - currentTrack.startedAt) / 1000);
    $("recDist").textContent = fmtKm(dist / 1000);
    $("recDur").textContent = fmtDur(dur);
    $("recPts").textContent = pts.length;
    $("recChipTime").textContent = fmtDur(dur);
  }
  function setRecUI(on) {
    $("recordBtn").classList.toggle("on", on);
    $("recordBtn").textContent = on ? "■ Stop recording" : "⏺ Record my track";
    $("pauseBtn").hidden = !on;
    $("pauseBtn").textContent = "⏸ Pause";
    $("recLive").hidden = !on;
  }
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0") + (h ? "" : "");
  };
  // One-shot position (for routing when not actively monitoring).
  function getPositionOnce() {
    return new Promise((resolve, reject) => {
      if (pos) return resolve(pos);
      if (!("geolocation" in navigator)) return reject(new Error("No geolocation"));
      navigator.geolocation.getCurrentPosition(
        (p) => { pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; updateUserOnMap(); resolve(pos); },
        reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }

  async function requestNotifications() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") { try { await Notification.requestPermission(); } catch {} }
  }
  async function acquireWakeLock() {
    if (!settings.wake || !("wakeLock" in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { console.warn("wakeLock", e); }
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (monitoring || recording)) acquireWakeLock(); });

  // ---------- Search / geocoding ----------
  async function doSearch(q) {
    if (!q.trim()) return;
    const results = $("searchResults");
    results.innerHTML = "<li class='muted'>Searching…</li>"; results.hidden = false;
    try {
      const near = pos || lastFetchCenter;
      const hits = await FCR.Routing.geocode(q, near);
      results.innerHTML = "";
      if (!hits.length) { results.innerHTML = "<li class='muted'>No matches</li>"; return; }
      for (const h of hits) {
        const li = document.createElement("li");
        li.innerHTML = `<b>${escapeHtml(h.short)}</b><br><span class="muted">${escapeHtml(h.name)}</span>`;
        li.onclick = () => { setDestination(h.lat, h.lon, h.short); results.hidden = true; $("searchInput").value = h.short; };
        results.appendChild(li);
      }
    } catch (e) { results.innerHTML = `<li class='muted'>Search failed: ${escapeHtml(e.message)}</li>`; }
  }

  // ---------- Routing model updates ----------
  function setDestination(lat, lon, label) {
    R.dest = { lat, lon, label: label || `Pinned (${lat.toFixed(4)}, ${lon.toFixed(4)})` };
    $("destLabel").textContent = R.dest.label;
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
    drawRoutePins();
    openSheet("routeSheet");
  }
  function setStartPin(lat, lon, label) {
    R.start = { lat, lon, label: label || `Pinned (${lat.toFixed(4)}, ${lon.toFixed(4)})` };
    R.startAuto = false;
    $("startLabel").textContent = R.start.label;
    drawRoutePins();
  }
  function useMyLocationAsStart() {
    R.startAuto = true; R.start = null;
    $("startLabel").textContent = "My location";
    drawRoutePins();
  }
  function currentStart() {
    if (!R.startAuto && R.start) return Promise.resolve(R.start);
    return getPositionOnce().then((p) => ({ lat: p.lat, lon: p.lon, label: "My location" }));
  }

  function drawRoutePins() {
    if (!routeGroup) return;
    // Rebuild pins + waypoints (route line is drawn separately after calc).
    routeGroup.eachLayer((l) => { if (l._fcrPin) routeGroup.removeLayer(l); });
    const pin = (ll, color, title) => {
      const m = L.circleMarker(ll, { radius: 8, color, weight: 3, fillColor: color, fillOpacity: 0.9 }).bindTooltip(title);
      m._fcrPin = true; m.addTo(routeGroup); return m;
    };
    if (!R.startAuto && R.start) pin([R.start.lat, R.start.lon], "#22c55e", "Start");
    R.dest && pin([R.dest.lat, R.dest.lon], "#ef4444", "Destination");
    R.waypoints.forEach((w, i) => pin([w.lat, w.lon], "#a78bfa", "Must pass #" + (i + 1)));
  }

  async function calculateRoute() {
    if (!R.dest) { toast("Set a destination first (search or tap the map)."); return; }
    const btn = $("calcRouteBtn"); btn.disabled = true; btn.textContent = "Routing…";
    try {
      const start = await currentStart();
      // Build camera-avoidance exclude list (nearest alertable cameras).
      let excludeLocations = [];
      if (R.avoid.cameras) {
        const midLat = (start.lat + R.dest.lat) / 2, midLon = (start.lon + R.dest.lon) / 2;
        excludeLocations = alertable()
          .map((c) => ({ lat: c.lat, lon: c.lon, d: distance(midLat, midLon, c.lat, c.lon) }))
          .sort((a, b) => a.d - b.d).slice(0, 50);
      }
      const policy = {
        start, end: R.dest, via: R.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
        mode: R.mode, avoid: R.avoid,
        excludePolygons: R.areas.map((a) => a.ring),
        excludeLocations,
      };
      const res = await FCR.Routing.route(policy);
      R.result = res;
      renderRoute(res);
      showRouteSummary(res);
    } catch (e) {
      console.warn("route error", e);
      const msg = /no path|no route|442/i.test(e.message) ? "No route found — your filters may be too strict. Try removing an avoid rule." : ("Routing failed: " + e.message);
      toast(msg);
    } finally { btn.disabled = false; btn.textContent = "Calculate route"; }
  }
  function renderRoute(res) {
    // Remove previous line only.
    routeGroup.eachLayer((l) => { if (l._fcrLine) routeGroup.removeLayer(l); });
    const line = L.polyline(res.coords, { color: "#38bdf8", weight: 6, opacity: 0.9 });
    line._fcrLine = true; line.addTo(routeGroup);
    const halo = L.polyline(res.coords, { color: "#0b1220", weight: 10, opacity: 0.5 });
    halo._fcrLine = true; halo.addTo(routeGroup); halo.bringToBack();
    try { map.fitBounds(line.getBounds().pad(0.15)); } catch {}
  }
  function showRouteSummary(res) {
    const flags = [];
    if (res.hasToll) flags.push("tolls");
    if (res.hasHighway) flags.push("highway");
    if (res.hasFerry) flags.push("ferry");
    $("routeSummary").innerHTML =
      `<b>${fmtKm(res.distanceKm)}</b> · <b>${fmtMin(res.timeMin)}</b>` +
      (flags.length ? ` <span class="muted">(${flags.join(", ")})</span>` : "");
    $("routeSummary").hidden = false;
    $("toggleDirections").hidden = false;
    $("clearRouteBtn").hidden = false;
    const dl = $("directionsList");
    dl.innerHTML = "";
    for (const m of res.maneuvers) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(m.text)}</span><span class="muted">${m.km ? fmtKm(m.km) : ""}</span>`;
      dl.appendChild(li);
    }
  }
  function clearRoute() {
    R.result = null;
    routeGroup.eachLayer((l) => { if (l._fcrLine) routeGroup.removeLayer(l); });
    $("routeSummary").hidden = true; $("toggleDirections").hidden = true; $("directionsList").hidden = true; $("clearRouteBtn").hidden = true;
  }

  // ---------- Map tap modes (set start/dest, add waypoint, draw area) ----------
  function setTapMode(mode) {
    tapMode = mode;
    const hint = $("mapHint");
    if (!mode) { hint.hidden = true; endDraw(false); return; }
    const text = { start: "Tap the map to set your START point.",
      dest: "Tap the map to set your DESTINATION.",
      waypoint: "Tap the map to add a MUST-PASS point.",
      draw: "Tap to add corners of an AVOID area, then Finish." }[mode];
    $("mapHintText").textContent = text;
    $("hintFinish").hidden = mode !== "draw";
    hint.hidden = false;
    if (mode === "draw") beginDraw();
  }
  function onMapClick(e) {
    if (!tapMode) return;
    const { lat, lng } = e.latlng;
    if (tapMode === "start") { setStartPin(lat, lng); setTapMode(null); }
    else if (tapMode === "dest") { setDestination(lat, lng); setTapMode(null); }
    else if (tapMode === "waypoint") { addWaypoint(lat, lng); setTapMode(null); }
    else if (tapMode === "draw") { drawBuffer.push({ lat, lon: lng }); updateDrawPreview(); }
  }
  function addWaypoint(lat, lon) {
    R.waypoints.push({ lat, lon });
    $("wpCount").textContent = R.waypoints.length;
    drawRoutePins();
  }
  function clearWaypoints() { R.waypoints = []; $("wpCount").textContent = 0; drawRoutePins(); }

  function beginDraw() {
    drawBuffer = [];
    drawPreview = L.polyline([], { color: "#ef4444", weight: 2, dashArray: "4 4" }).addTo(map);
    drawMarkers = L.layerGroup().addTo(map);
  }
  function updateDrawPreview() {
    if (!drawPreview) return;
    drawPreview.setLatLngs(drawBuffer.map((p) => [p.lat, p.lon]));
    drawMarkers.clearLayers();
    drawBuffer.forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 4, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 1 }).addTo(drawMarkers));
  }
  function endDraw(commit) {
    if (drawPreview) { map.removeLayer(drawPreview); drawPreview = null; }
    if (drawMarkers) { map.removeLayer(drawMarkers); drawMarkers = null; }
    if (commit && drawBuffer.length >= 3) {
      const latlngs = drawBuffer.map((p) => [p.lat, p.lon]);
      const poly = L.polygon(latlngs, { color: "#ef4444", weight: 2, fillColor: "#ef4444", fillOpacity: 0.18 }).addTo(avoidGroup);
      const ring = drawBuffer.map((p) => [p.lon, p.lat]); // [lon,lat] for Valhalla
      R.areas.push({ layer: poly, ring });
      $("areaCount").textContent = R.areas.length;
    }
    drawBuffer = [];
  }
  function finishDraw() { endDraw(true); setTapMode(null); }
  function clearAreas() { R.areas.forEach((a) => avoidGroup.removeLayer(a.layer)); R.areas = []; $("areaCount").textContent = 0; }

  // ---------- Tracks: list, view, backup, restore ----------
  function getPin() {
    const field = $("backupPin");
    return ((field && field.value) || backupPin || "").trim();
  }
  async function renderTrackList() {
    const ul = $("trackList");
    const tracks = await FCR.Tracks.list();
    $("trackCount").textContent = tracks.length;
    ul.innerHTML = "";
    if (!tracks.length) { ul.innerHTML = "<li class='muted'>No saved tracks yet. Tap “Record my track”.</li>"; return; }
    for (const t of tracks) {
      const li = document.createElement("li");
      li.className = "track-item";
      const when = new Date(t.startedAt).toLocaleString();
      li.innerHTML =
        `<div class="track-item__meta">
           <div class="track-item__name">${escapeHtml(t.name)}</div>
           <div class="muted track-item__sub">${when} · ${fmtKm((t.distanceM || 0) / 1000)} · ${fmtDur(t.durationS || 0)} · ${t.points.length} pts</div>
         </div>
         <div class="track-item__btns">
           <button data-act="show" title="Show on map">🗺</button>
           <button data-act="export" title="Export encrypted backup">⬇︎</button>
           <button data-act="del" title="Delete">🗑</button>
         </div>`;
      li.querySelector('[data-act="show"]').onclick = () => showTrackOnMap(t.id);
      li.querySelector('[data-act="export"]').onclick = () => backupTracks([t]);
      li.querySelector('[data-act="del"]').onclick = () => deleteTrack(t.id);
      ul.appendChild(li);
    }
  }
  async function showTrackOnMap(id) {
    const t = await FCR.Tracks.get(id);
    if (!t || !t.points.length) return;
    savedTrackGroup.clearLayers();
    const latlngs = t.points.map((p) => [p.lat, p.lon]);
    const line = L.polyline(latlngs, { color: "#f59e0b", weight: 5, opacity: 0.95 }).addTo(savedTrackGroup);
    L.circleMarker(latlngs[0], { radius: 6, color: "#22c55e", fillColor: "#22c55e", fillOpacity: 1 }).bindTooltip("Start").addTo(savedTrackGroup);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 1 }).bindTooltip("End").addTo(savedTrackGroup);
    try { map.fitBounds(line.getBounds().pad(0.2)); } catch {}
    closeSheets();
  }
  async function deleteTrack(id) {
    if (!confirm("Delete this track? This can't be undone.")) return;
    await FCR.Tracks.remove(id);
    await renderTrackList();
  }
  async function backupAll() {
    const tracks = await FCR.Tracks.list();
    if (!tracks.length) { toast("No tracks to back up yet."); return; }
    await backupTracks(tracks);
  }
  async function backupTracks(tracks) {
    const pin = getPin();
    if (!pin) { openSheet("tracksSheet"); $("backupPin").focus(); toast("Enter a backup PIN/passphrase first."); return; }
    try {
      toast("Encrypting backup…");
      const blob = await FCR.Tracks.exportZip(tracks, pin);
      downloadBlob(blob, `flock-tracks-${new Date().toISOString().slice(0, 10)}.zip`);
      toast(`Backup ready (${tracks.length} track${tracks.length > 1 ? "s" : ""}) — AES-encrypted.`);
    } catch (e) { console.warn(e); toast("Backup failed: " + e.message); }
  }
  function restoreFromFile(file) {
    const pin = getPin();
    if (!pin) { toast("Enter the backup PIN first, then choose the file."); return; }
    toast("Decrypting backup…");
    FCR.Tracks.importAndSave(file, pin)
      .then(async (n) => { await renderTrackList(); toast(`Restored ${n} track${n === 1 ? "" : "s"}.`); })
      .catch((e) => { console.warn(e); toast(e.message); });
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- Sheets / small UI ----------
  function openSheet(id) { closeSheets(); $(id).hidden = false; }
  function closeSheets() { document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true)); }
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Layer sync (Leaflet control <-> Layers sheet checkboxes) ----------
  function syncLayerChecks() {
    $("layerFlock").checked = map.hasLayer(gFlock);
    $("layerAlpr").checked = map.hasLayer(gAlpr);
    $("layerCctv").checked = map.hasLayer(gCctv);
    if (radar) $("radarOn").checked = map.hasLayer(radar.group);
  }

  // ---------- Wire settings ----------
  function syncSettingsUI() {
    $("alertRRange").value = settings.alertR; $("alertRLabel").textContent = settings.alertR;
    $("fetchRRange").value = settings.fetchKm; $("fetchRLabel").textContent = settings.fetchKm;
    $("includeAllSurv").checked = settings.includeAllSurv;
    $("soundOn").checked = settings.sound; $("vibrateOn").checked = settings.vibrate; $("wakeOn").checked = settings.wake;
    $("routeEndpoint").value = settings.routeEndpoint || "";
  }
  function wire() {
    // Search
    $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); doSearch($("searchInput").value); });
    $("searchInput").addEventListener("input", () => { if (!$("searchInput").value) $("searchResults").hidden = true; });

    // Dock
    $("dockRoute").onclick = () => openSheet("routeSheet");
    $("dockLayers").onclick = () => { syncLayerChecks(); openSheet("layersSheet"); };
    $("dockTracks").onclick = () => { renderTrackList(); openSheet("tracksSheet"); };
    $("settingsBtn").onclick = () => openSheet("settingsSheet");
    $("monitorBtn").onclick = () => (monitoring ? stopMonitoring() : startMonitoring());

    // Tracks sheet
    $("recordBtn").onclick = () => (recording ? stopRecording() : startRecording());
    $("pauseBtn").onclick = togglePauseRecording;
    $("recChip").onclick = () => { renderTrackList(); openSheet("tracksSheet"); };
    $("backupAllBtn").onclick = backupAll;
    $("restoreBtn").onclick = () => $("restoreFile").click();
    $("restoreFile").onchange = (e) => { const f = e.target.files[0]; if (f) restoreFromFile(f); e.target.value = ""; };
    if (settings.rememberPin && settings.backupPin) { backupPin = settings.backupPin; $("backupPin").value = settings.backupPin; }
    $("rememberPin").checked = settings.rememberPin;
    $("backupPin").oninput = (e) => { backupPin = e.target.value; if (settings.rememberPin) { settings.backupPin = e.target.value; save(); } };
    $("rememberPin").onchange = (e) => { settings.rememberPin = e.target.checked; settings.backupPin = e.target.checked ? ($("backupPin").value || "") : ""; save(); };
    $("autoBackup").checked = settings.autoBackup;
    $("autoBackup").onchange = (e) => { settings.autoBackup = e.target.checked; save(); };

    // Sheet close buttons + backdrop
    document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheets));
    document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s) closeSheets(); }));

    // Route sheet
    $("useMyLoc").onclick = useMyLocationAsStart;
    $("tapStart").onclick = () => { closeSheets(); setTapMode("start"); };
    $("tapDest").onclick = () => { closeSheets(); setTapMode("dest"); };
    document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
      R.mode = b.getAttribute("data-mode");
      document.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    $("avoidTolls").onchange = (e) => (R.avoid.tolls = e.target.checked);
    $("avoidHighways").onchange = (e) => (R.avoid.highways = e.target.checked);
    $("avoidFerries").onchange = (e) => (R.avoid.ferries = e.target.checked);
    $("avoidCameras").onchange = (e) => (R.avoid.cameras = e.target.checked);
    $("drawAreaBtn").onclick = () => { closeSheets(); setTapMode("draw"); };
    $("clearAreasBtn").onclick = clearAreas;
    $("addWaypointBtn").onclick = () => { closeSheets(); setTapMode("waypoint"); };
    $("clearWaypointsBtn").onclick = clearWaypoints;
    $("calcRouteBtn").onclick = calculateRoute;
    $("clearRouteBtn").onclick = clearRoute;
    $("toggleDirections").onclick = () => { const d = $("directionsList"); d.hidden = !d.hidden; };

    // Map hint controls
    $("hintFinish").onclick = finishDraw;
    $("hintCancel").onclick = () => setTapMode(null);

    // Layers sheet
    const toggleGroup = (grp, on) => { if (on) grp.addTo(map); else map.removeLayer(grp); };
    $("layerFlock").onchange = (e) => { toggleGroup(gFlock, e.target.checked); settings.layerFlock = e.target.checked; save(); };
    $("layerAlpr").onchange = (e) => { toggleGroup(gAlpr, e.target.checked); settings.layerAlpr = e.target.checked; save(); };
    $("layerCctv").onchange = (e) => { toggleGroup(gCctv, e.target.checked); settings.layerCctv = e.target.checked; save(); };
    $("includeAllSurv").onchange = (e) => { settings.includeAllSurv = e.target.checked; save(); if (pos || lastFetchCenter) { const c = pos || lastFetchCenter; fetchCameras(c.lat, c.lon); } };
    if (radar) {
      $("radarOn").onchange = (e) => { if (e.target.checked) radar.group.addTo(map); else map.removeLayer(radar.group); };
      $("radarPlay").onclick = () => { const playing = radar.toggle(); $("radarPlay").textContent = playing ? "⏸ Pause" : "▶ Play"; };
      $("radarRefresh").onclick = () => radar.refresh();
      $("radarOpacity").oninput = (e) => radar.setOpacity(+e.target.value);
      radar.onFrame = (label) => { $("radarTime").textContent = label; $("radarChip").textContent = "Radar " + label; };
    } else {
      $("radarRow").innerHTML = "<span class='muted'>Weather radar unavailable right now.</span>";
    }

    // Settings sheet
    $("alertRRange").oninput = () => { settings.alertR = +$("alertRRange").value; $("alertRLabel").textContent = settings.alertR; save(); evaluate(); };
    $("fetchRRange").oninput = () => { settings.fetchKm = +$("fetchRRange").value; $("fetchRLabel").textContent = settings.fetchKm; save(); };
    $("fetchRRange").onchange = () => { const c = pos || lastFetchCenter; if (c) fetchCameras(c.lat, c.lon); };
    $("soundOn").onchange = (e) => { settings.sound = e.target.checked; save(); };
    $("vibrateOn").onchange = (e) => { settings.vibrate = e.target.checked; save(); };
    $("wakeOn").onchange = (e) => { settings.wake = e.target.checked; save(); if (settings.wake && (monitoring || recording)) acquireWakeLock(); else releaseWakeLock(); };
    $("routeEndpoint").onchange = (e) => { settings.routeEndpoint = e.target.value.trim(); save(); FCR.Routing.setEndpoint(settings.routeEndpoint); };
    $("resetEndpoint").onclick = () => { settings.routeEndpoint = ""; $("routeEndpoint").value = ""; save(); FCR.Routing.setEndpoint(""); };
    $("testBtn").onclick = () => { $("statusCard").hidden = false; fireAlert({ id: "test", d: 90, b: 45, name: "Test camera", category: "flock" }); };
  }

  // ---------- Boot ----------
  async function boot() {
    FCR.Routing.setEndpoint(settings.routeEndpoint);
    syncSettingsUI();

    layersApi = await FCR.Layers.init({ id: "map", center: [39.5, -98.35], zoom: 4 });
    map = layersApi.map; radar = layersApi.radar;

    // Camera + routing layers
    gFlock = L.layerGroup(); gAlpr = L.layerGroup(); gCctv = L.layerGroup();
    layersApi.addOverlay("🔵 Flock cameras", gFlock, settings.layerFlock);
    layersApi.addOverlay("🟠 ALPR cameras", gAlpr, settings.layerAlpr);
    layersApi.addOverlay("🔴 Other surveillance", gCctv, settings.layerCctv);
    routeGroup = L.layerGroup().addTo(map);
    avoidGroup = L.layerGroup().addTo(map);
    trackGroup = L.layerGroup().addTo(map);           // live recording line
    savedTrackGroup = L.layerGroup().addTo(map);      // saved-track viewer

    map.on("click", onMapClick);
    map.on("overlayadd overlayremove", syncLayerChecks);
    if (radar) {
      map.on("overlayadd", (e) => { if (e.layer === radar.group) $("radarChip").hidden = false; });
      map.on("overlayremove", (e) => { if (e.layer === radar.group) $("radarChip").hidden = true; });
    }

    // Restore CCTV visibility default (off) — addOverlay handled shown state.
    wire();
    loadCache();
    if (cameras.length) { renderCameras(); if (lastFetchCenter) map.setView([lastFetchCenter.lat, lastFetchCenter.lon], 13); }
    useMyLocationAsStart();
    renderTrackList().catch((e) => console.warn("tracks", e));

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").then((reg) => { swReg = reg; }).catch((e) => console.warn("SW", e));
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
