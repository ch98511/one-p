/* FCR.Layers — the map "base" plus toggleable overlays.
 *
 *   Base maps:  Dark (default) · Streets · Satellite
 *   Overlays:   Live weather radar (RainViewer, animated) + whatever camera /
 *               surveillance / route groups the app registers via addOverlay().
 *
 * Everything is Leaflet + free/keyless tile sources, so it deploys as static
 * files (GitHub Pages) with no build step and no API keys.
 */
(() => {
  "use strict";
  const FCR = (window.FCR = window.FCR || {});

  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";

  function baseLayers() {
    const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    });
    const dark = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO" }
    );
    const sat = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery © Esri" }
    );
    return { "Dark": dark, "Streets": streets, "Satellite": sat };
  }

  // ---------- Weather radar (RainViewer, animated) ----------
  function createRadar(map) {
    const state = {
      frames: [],          // [{time, url}]
      idx: 0,
      layer: null,         // current L.tileLayer
      playing: false,
      timer: null,
      opacity: 0.7,
      onFrame: null,       // callback(label)
    };

    // Dedicated pane: above base tiles, below markers/routes.
    if (!map.getPane("radar")) {
      map.createPane("radar");
      map.getPane("radar").style.zIndex = 350;
      map.getPane("radar").style.pointerEvents = "none";
    }

    function tileUrl(host, path) {
      // {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
      // color 4 = "The Weather Channel" scheme (reads well on a dark map).
      return `${host}${path}/256/{z}/{x}/{y}/4/1_1.png`;
    }

    async function load() {
      const res = await fetch(RAINVIEWER, { cache: "no-store" });
      if (!res.ok) throw new Error("RainViewer HTTP " + res.status);
      const j = await res.json();
      const host = j.host;
      const past = (j.radar && j.radar.past) || [];
      const now = (j.radar && j.radar.nowcast) || [];
      state.frames = [...past, ...now].map((f) => ({ time: f.time, url: tileUrl(host, f.path) }));
      if (!state.frames.length) throw new Error("No radar frames");
      state.idx = past.length ? past.length - 1 : 0; // newest observed frame
      return state.frames.length;
    }

    function show(i) {
      if (!state.frames.length) return;
      state.idx = (i + state.frames.length) % state.frames.length;
      const f = state.frames[state.idx];
      const fresh = L.tileLayer(f.url, {
        tileSize: 256, opacity: state.opacity, pane: "radar",
        attribution: "Radar © RainViewer", crossOrigin: true,
      });
      fresh.addTo(map);
      const old = state.layer;
      // Swap once the new frame paints, to reduce flicker.
      fresh.once("load", () => { if (old) map.removeLayer(old); });
      // Safety: drop the old layer even if 'load' never fires.
      setTimeout(() => { if (old && map.hasLayer(old) && old !== fresh) map.removeLayer(old); }, 1200);
      state.layer = fresh;
      if (state.onFrame) state.onFrame(frameLabel());
    }

    function frameLabel() {
      const f = state.frames[state.idx];
      if (!f) return "";
      const d = new Date(f.time * 1000);
      const hh = d.getHours().toString().padStart(2, "0");
      const mm = d.getMinutes().toString().padStart(2, "0");
      const newest = state.idx === state.frames.length - 1;
      return `${hh}:${mm}${newest ? " (latest)" : ""}`;
    }

    function play() {
      if (state.playing || state.frames.length < 2) return;
      state.playing = true;
      state.timer = setInterval(() => {
        const next = state.idx + 1;
        // Pause a beat on the newest frame before looping.
        show(next >= state.frames.length ? 0 : next);
      }, 500);
    }
    function pause() { state.playing = false; if (state.timer) clearInterval(state.timer); state.timer = null; }
    function toggle() { state.playing ? pause() : play(); return state.playing; }

    function setOpacity(o) {
      state.opacity = o;
      if (state.layer) state.layer.setOpacity(o);
    }

    async function refresh() {
      const wasPlaying = state.playing;
      pause();
      await load();
      show(state.idx);
      if (wasPlaying) play();
    }

    // A LayerGroup we can add/remove from the map + layer control. Adding it
    // renders the current frame; removing it clears radar and stops animation.
    const group = L.layerGroup();
    group.on("add", () => { if (state.frames.length) show(state.idx); });
    group.on("remove", () => { pause(); if (state.layer) { map.removeLayer(state.layer); state.layer = null; } });

    return {
      group, load, show, play, pause, toggle, setOpacity, refresh, frameLabel,
      get playing() { return state.playing; },
      get count() { return state.frames.length; },
      get idx() { return state.idx; },
      setIndex: (i) => show(i),
      set onFrame(fn) { state.onFrame = fn; },
    };
  }

  // ---------- Public init ----------
  // Returns { map, control, addOverlay, radar }. `radar` is null if it failed.
  async function init(opts = {}) {
    const map = L.map(opts.id || "map", {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    }).setView(opts.center || [39.5, -98.35], opts.zoom || 4);

    const bases = baseLayers();
    bases["Dark"].addTo(map); // default base

    const control = L.control.layers(bases, {}, { collapsed: true, position: "topright" }).addTo(map);

    let radar = null;
    try {
      radar = createRadar(map);
      await radar.load();
      control.addOverlay(radar.group, "🌧 Weather radar");
    } catch (e) {
      console.warn("Radar unavailable:", e);
      radar = null;
    }

    function addOverlay(name, layer, show) {
      layer.addTo(map);
      control.addOverlay(layer, name);
      if (show === false) map.removeLayer(layer);
    }

    return { map, control, addOverlay, radar };
  }

  FCR.Layers = { init };
})();
