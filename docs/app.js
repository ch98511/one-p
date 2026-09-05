/* Flock Camera Radar
 * - Pulls ALPR / Flock camera locations from OpenStreetMap (Overpass API)
 * - Watches your GPS location
 * - Alerts (banner + notification + sound + vibrate) when you near a camera
 * All processing is on-device; nothing about your location leaves the phone
 * except the Overpass query (a bounding box around you) used to fetch cameras.
 */
(() => {
  "use strict";

  // ---------- Settings ----------
  const DEFAULTS = {
    alertR: 150,      // meters: alert when nearest camera is within this
    fetchKm: 3,       // km: radius to fetch cameras around you
    flockOnly: false, // only cameras explicitly tagged Flock
    sound: true,
    vibrate: true,
    wake: true,
  };
  const load = () => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("fcr.settings") || "{}") }; }
    catch { return { ...DEFAULTS }; }
  };
  const save = () => { try { localStorage.setItem("fcr.settings", JSON.stringify(settings)); } catch {} };
  let settings = load();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $("statusCard"), dist: $("nearestDist"), label: $("statusLabel"), sub: $("statusSub"),
    camCount: $("camCount"), gpsAcc: $("gpsAcc"), alertR: $("alertR"), camList: $("camList"),
    start: $("startBtn"), stop: $("stopBtn"), test: $("testBtn"),
    settingsBtn: $("settingsBtn"), sheet: $("settingsSheet"), closeSettings: $("closeSettings"),
    alertRRange: $("alertRRange"), alertRLabel: $("alertRLabel"),
    fetchRRange: $("fetchRRange"), fetchRLabel: $("fetchRLabel"),
    flockOnly: $("flockOnly"), soundOn: $("soundOn"), vibrateOn: $("vibrateOn"), wakeOn: $("wakeOn"),
  };

  // ---------- State ----------
  let watchId = null;
  let cameras = [];                 // normalized camera list
  let lastFetchCenter = null;       // {lat, lon}
  let lastFetchAt = 0;
  let fetching = false;
  let pos = null;                   // last {lat, lon, acc}
  const alerted = new Map();        // cameraId -> lastAlertTime (ms)
  let map = null, userMarker = null, accCircle = null, camLayer = null, swReg = null;
  let audioCtx = null;

  // ---------- Geo math ----------
  const R_EARTH = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  function distance(aLat, aLon, bLat, bLon) {
    const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  }
  function bearing(aLat, aLon, bLat, bLon) {
    const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
      Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");

  // ---------- Camera pipeline (Overpass / OpenStreetMap) ----------
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  function buildQuery(lat, lon, radiusM) {
    const r = Math.round(radiusM);
    return `[out:json][timeout:25];
(
  node["man_made"="surveillance"]["surveillance:type"~"ALPR",i](around:${r},${lat},${lon});
  node["man_made"="surveillance"]["manufacturer"~"Flock",i](around:${r},${lat},${lon});
  node["man_made"="surveillance"]["brand"~"Flock",i](around:${r},${lat},${lon});
);
out body;`;
  }
  function normalize(elements) {
    const out = [];
    for (const e of elements) {
      if (e.type !== "node" || typeof e.lat !== "number") continue;
      const t = e.tags || {};
      const vendor = (t.manufacturer || t.brand || t.operator || "").toString();
      const isFlock = /flock/i.test(vendor);
      out.push({
        id: e.id,
        lat: e.lat, lon: e.lon,
        isFlock,
        name: vendor || (/(alpr)/i.test(t["surveillance:type"] || "") ? "ALPR camera" : "Surveillance camera"),
        type: t["surveillance:type"] || t["camera:type"] || "camera",
        direction: t.direction || null,
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
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        cameras = normalize(json.elements || []);
        lastFetchCenter = { lat, lon };
        lastFetchAt = Date.now();
        ok = true;
        try { localStorage.setItem("fcr.cache", JSON.stringify({ at: lastFetchAt, center: lastFetchCenter, cameras })); } catch {}
        break;
      } catch (err) {
        console.warn("Overpass failed:", url, err);
      }
    }
    fetching = false;
    if (!ok) setSub("Couldn’t reach the camera database — will retry. Showing last known data.");
    renderCameras();
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem("fcr.cache") || "null");
      if (c && Array.isArray(c.cameras)) { cameras = c.cameras; lastFetchCenter = c.center; }
    } catch {}
  }

  // ---------- Rendering ----------
  function visibleCameras() {
    return settings.flockOnly ? cameras.filter((c) => c.isFlock) : cameras;
  }
  function withDistance() {
    if (!pos) return [];
    return visibleCameras()
      .map((c) => ({ ...c, d: distance(pos.lat, pos.lon, c.lat, c.lon), b: bearing(pos.lat, pos.lon, c.lat, c.lon) }))
      .sort((a, b) => a.d - b.d);
  }
  function renderCameras() {
    const list = withDistance();
    el.camCount.textContent = list.length;
    el.camList.innerHTML = "";
    for (const c of list.slice(0, 12)) {
      const li = document.createElement("li");
      li.className = "cam-item" + (c.isFlock ? " flock" : "");
      li.innerHTML =
        `<div class="cam-item__meta">
           <div class="cam-item__name">${escapeHtml(c.name)}${c.isFlock ? '<span class="badge">FLOCK</span>' : ""}</div>
           <div class="cam-item__tags">${escapeHtml(c.type)}${c.d != null ? " · " + compass(c.b) + " of you" : ""}</div>
         </div>
         <div class="cam-item__dist">${c.d != null ? fmtM(c.d) : ""}</div>`;
      el.camList.appendChild(li);
    }
    renderMapCameras(list);
    evaluate(list);
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  // ---------- Alert evaluation ----------
  function setStatus(cls, big, label, sub) {
    el.status.className = "status status--" + cls;
    if (big !== undefined) el.dist.textContent = big;
    if (label !== undefined) el.label.textContent = label;
    if (sub !== undefined) el.sub.textContent = sub;
  }
  const setSub = (s) => (el.sub.textContent = s);

  function evaluate(list) {
    el.alertR.textContent = settings.alertR;
    if (!pos) return;
    const nearest = list[0];
    if (!nearest) { setStatus("ok", "—", "No cameras nearby", `Watching within ${settings.fetchKm} km.`); return; }

    const d = nearest.d;
    el.dist.textContent = fmtM(d);
    const dir = `${compass(nearest.b)} · ${nearest.name}`;

    if (d <= settings.alertR) {
      setStatus("alert", fmtM(d), "⚠ Camera ahead", dir);
      maybeAlert(nearest);
    } else if (d <= settings.alertR * 2) {
      setStatus("near", fmtM(d), "Getting close", dir);
    } else {
      setStatus("ok", fmtM(d), "Clear", `Nearest camera ${dir}`);
    }

    // Clear cooldowns for cameras we've moved well away from.
    for (const [id, t] of alerted) {
      const cam = list.find((c) => c.id === id);
      if (!cam || cam.d > settings.alertR * 1.8) alerted.delete(id);
    }
  }

  function maybeAlert(cam) {
    const now = Date.now();
    const last = alerted.get(cam.id) || 0;
    if (now - last < 60000) return; // at most once/min per camera while in range
    alerted.set(cam.id, now);
    fireAlert(cam);
  }

  function fireAlert(cam) {
    const title = cam.isFlock ? "⚠ Flock camera ahead" : "⚠ ALPR camera ahead";
    const body = `${fmtM(cam.d)} to your ${compass(cam.b)} · ${cam.name}`;
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 80, 200]);
    if (settings.sound) beep();
    notify(title, body);
  }

  // ---------- Notification / sound ----------
  function notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = { body, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: "fcr-alert", renotify: true, vibrate: [200, 80, 200] };
    try {
      if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (e) { console.warn("notify failed", e); }
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
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.4, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.22);
        o.connect(g).connect(audioCtx.destination); o.start(s); o.stop(s + 0.24);
      }
    } catch (e) { console.warn("beep failed", e); }
  }

  // ---------- Map ----------
  function initMap() {
    if (map || typeof L === "undefined") return;
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([39.5, -98.35], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);
    camLayer = L.layerGroup().addTo(map);
  }
  function renderMapCameras(list) {
    if (!map || !camLayer) return;
    camLayer.clearLayers();
    for (const c of list) {
      const color = c.isFlock ? "#38bdf8" : "#f59e0b";
      L.circleMarker([c.lat, c.lon], { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.6 })
        .bindPopup(`${escapeHtml(c.name)}${c.d != null ? "<br>" + fmtM(c.d) + " away" : ""}`)
        .addTo(camLayer);
    }
  }
  function updateUserOnMap() {
    if (!map || !pos) return;
    const ll = [pos.lat, pos.lon];
    if (!userMarker) {
      userMarker = L.circleMarker(ll, { radius: 8, color: "#22c55e", weight: 3, fillColor: "#22c55e", fillOpacity: 0.9 }).addTo(map);
      accCircle = L.circle(ll, { radius: pos.acc || 20, color: "#22c55e", weight: 1, fillOpacity: 0.06 }).addTo(map);
      map.setView(ll, 15);
    } else {
      userMarker.setLatLng(ll);
      accCircle.setLatLng(ll).setRadius(pos.acc || 20);
    }
  }

  // ---------- Geolocation ----------
  async function start() {
    if (!("geolocation" in navigator)) { setSub("This device has no geolocation."); return; }
    await requestNotifications();
    if (settings.sound) { // unlock audio on the user gesture
      try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
    }
    acquireWakeLock();
    el.start.hidden = true; el.stop.hidden = false;
    setStatus("ok", "…", "Locating", "Getting your GPS position…");
    watchId = navigator.geolocation.watchPosition(onPos, onGeoErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }
  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    releaseWakeLock();
    el.start.hidden = false; el.stop.hidden = true;
    setStatus("idle", "—", "Stopped", "Monitoring paused.");
  }
  function onPos(p) {
    pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    el.gpsAcc.textContent = pos.acc ? Math.round(pos.acc) : "—";
    updateUserOnMap();
    // (Re)fetch cameras if we've moved far from the last fetch center, or it's stale.
    const moved = lastFetchCenter ? distance(pos.lat, pos.lon, lastFetchCenter.lat, lastFetchCenter.lon) : Infinity;
    const stale = Date.now() - lastFetchAt > 120000;
    if (moved > settings.fetchKm * 400 || (stale && moved > 200)) fetchCameras(pos.lat, pos.lon);
    renderCameras();
  }
  function onGeoErr(err) {
    console.warn("geo error", err);
    const msg = err.code === 1 ? "Location permission denied. Enable it in your browser settings."
      : err.code === 2 ? "Position unavailable — check GPS / signal."
      : "Locating timed out — retrying.";
    setStatus("idle", "—", "GPS problem", msg);
  }

  // ---------- Permissions / wake lock ----------
  async function requestNotifications() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
  }
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!settings.wake || !("wakeLock" in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { console.warn("wakeLock", e); }
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && watchId != null) acquireWakeLock();
  });

  // ---------- Settings UI ----------
  function syncSettingsUI() {
    el.alertRRange.value = settings.alertR; el.alertRLabel.textContent = settings.alertR; el.alertR.textContent = settings.alertR;
    el.fetchRRange.value = settings.fetchKm; el.fetchRLabel.textContent = settings.fetchKm;
    el.flockOnly.checked = settings.flockOnly;
    el.soundOn.checked = settings.sound;
    el.vibrateOn.checked = settings.vibrate;
    el.wakeOn.checked = settings.wake;
  }
  function wireSettings() {
    el.settingsBtn.onclick = () => { el.sheet.hidden = false; };
    el.closeSettings.onclick = () => { el.sheet.hidden = true; };
    el.sheet.addEventListener("click", (e) => { if (e.target === el.sheet) el.sheet.hidden = true; });
    el.alertRRange.oninput = () => { settings.alertR = +el.alertRRange.value; el.alertRLabel.textContent = settings.alertR; el.alertR.textContent = settings.alertR; save(); if (pos) renderCameras(); };
    el.fetchRRange.oninput = () => { settings.fetchKm = +el.fetchRRange.value; el.fetchRLabel.textContent = settings.fetchKm; save(); };
    el.fetchRRange.onchange = () => { if (pos) fetchCameras(pos.lat, pos.lon); };
    el.flockOnly.onchange = () => { settings.flockOnly = el.flockOnly.checked; save(); renderCameras(); };
    el.soundOn.onchange = () => { settings.sound = el.soundOn.checked; save(); };
    el.vibrateOn.onchange = () => { settings.vibrate = el.vibrateOn.checked; save(); };
    el.wakeOn.onchange = () => { settings.wake = el.wakeOn.checked; save(); if (settings.wake && watchId != null) acquireWakeLock(); else releaseWakeLock(); };
  }

  // ---------- Boot ----------
  function boot() {
    syncSettingsUI();
    wireSettings();
    initMap();
    loadCache();
    if (cameras.length) renderCameras();
    el.start.onclick = start;
    el.stop.onclick = stop;
    el.test.onclick = () => fireAlert({ id: "test", d: 90, b: 45, name: "Test camera", isFlock: true });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").then((reg) => { swReg = reg; }).catch((e) => console.warn("SW", e));
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
