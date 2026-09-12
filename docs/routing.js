/* FCR.Routing — constraint-aware routing + geocoding (all client-side).
 *
 * Geocoding:  Nominatim (OpenStreetMap) — turns "Airport" into lat/lon.
 * Routing:    Valhalla (FOSSGIS public instance by default) — a real routing
 *             engine with configurable costing, so we can express constraints:
 *               • avoid tolls / highways / ferries   → costing_options flags
 *               • avoid drawn areas                   → exclude_polygons
 *               • avoid cameras (points)              → exclude_locations
 *               • must-pass waypoints                 → intermediate locations
 *
 * This maps the "routing policy engine" idea onto a keyless public backend so
 * the app can be built and tested today. For production, point ENDPOINT at your
 * own Valhalla/GraphHopper (see docs/ARCHITECTURE.md).
 */
(() => {
  "use strict";
  const FCR = (window.FCR = window.FCR || {});

  // Default keyless public routing engine. Override in Settings.
  const DEFAULT_ENDPOINT = "https://valhalla1.openstreetmap.de";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";

  let endpoint = DEFAULT_ENDPOINT;
  const setEndpoint = (url) => { endpoint = (url || DEFAULT_ENDPOINT).replace(/\/+$/, ""); };
  const getEndpoint = () => endpoint;
  const getDefaultEndpoint = () => DEFAULT_ENDPOINT;

  // ---------- Geocoding ----------
  async function geocode(query, near) {
    const params = new URLSearchParams({ format: "jsonv2", limit: "6", q: query });
    // Bias results toward the user's area when we know it (viewbox, not bounded).
    if (near) {
      const d = 1.5; // ~150 km box
      params.set("viewbox", [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(","));
    }
    const res = await fetch(`${NOMINATIM}?${params.toString()}`, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error("Geocoder HTTP " + res.status);
    const arr = await res.json();
    return (arr || []).map((r) => ({
      name: r.display_name,
      short: (r.display_name || "").split(",").slice(0, 2).join(","),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      kind: r.type,
    }));
  }

  // ---------- Encoded-polyline decode (Valhalla uses precision 6) ----------
  function decodePolyline(str, precision = 6) {
    let index = 0, lat = 0, lng = 0;
    const coords = [], factor = Math.pow(10, precision);
    while (index < str.length) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      result = 0; shift = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lat / factor, lng / factor]);
    }
    return coords;
  }

  // ---------- Build a Valhalla request from a routing policy ----------
  // policy: {
  //   start:{lat,lon}, end:{lat,lon},
  //   via:[{lat,lon}, ...],                 // must-pass waypoints (ordered)
  //   mode:"auto"|"bicycle"|"pedestrian",
  //   avoid:{tolls,highways,ferries},       // booleans
  //   excludePolygons:[ [[lon,lat],...], ...],   // hard avoid areas
  //   excludeLocations:[{lat,lon}, ...],         // hard avoid points (cameras)
  // }
  function buildRequest(policy) {
    const mode = policy.mode || "auto";
    const locations = [
      { lat: policy.start.lat, lon: policy.start.lon, type: "break" },
      ...(policy.via || []).map((v) => ({ lat: v.lat, lon: v.lon, type: "through" })),
      { lat: policy.end.lat, lon: policy.end.lon, type: "break" },
    ];

    const co = {};
    const a = policy.avoid || {};
    if (mode === "auto") {
      co.auto = {
        use_tolls: a.tolls ? 0 : 1,
        use_highways: a.highways ? 0 : 1,
        use_ferry: a.ferries ? 0 : 1,
      };
    } else if (mode === "bicycle") {
      co.bicycle = { use_ferry: a.ferries ? 0 : 1 };
    } else if (mode === "pedestrian") {
      co.pedestrian = { use_ferry: a.ferries ? 0 : 1 };
    }

    const body = {
      locations,
      costing: mode,
      costing_options: co,
      units: "kilometers",
      directions_type: "maneuvers",
      id: "fcr",
    };
    if (policy.excludePolygons && policy.excludePolygons.length) {
      body.exclude_polygons = policy.excludePolygons;
    }
    if (policy.excludeLocations && policy.excludeLocations.length) {
      // Valhalla caps this; keep it sane.
      body.exclude_locations = policy.excludeLocations
        .slice(0, 50)
        .map((p) => ({ lat: p.lat, lon: p.lon }));
    }
    return body;
  }

  // ---------- Route ----------
  async function route(policy) {
    const body = buildRequest(policy);
    const res = await fetch(`${endpoint}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok || !json || !json.trip) {
      const msg = (json && (json.error || json.status_message)) || ("HTTP " + res.status);
      throw new RouteError(msg, json && json.error_code);
    }
    return normalizeTrip(json.trip);
  }

  function normalizeTrip(trip) {
    const coords = [];
    const maneuvers = [];
    for (const leg of trip.legs || []) {
      const pts = decodePolyline(leg.shape, 6);
      // Avoid duplicating the shared vertex between consecutive legs.
      const startAt = coords.length ? 1 : 0;
      for (let i = startAt; i < pts.length; i++) coords.push(pts[i]);
      for (const m of leg.maneuvers || []) {
        maneuvers.push({
          text: m.instruction,
          km: m.length,
          min: m.time / 60,
        });
      }
    }
    const s = trip.summary || {};
    return {
      coords,
      distanceKm: s.length || 0,
      timeMin: (s.time || 0) / 60,
      hasToll: !!s.has_toll,
      hasHighway: !!s.has_highway,
      hasFerry: !!s.has_ferry,
      maneuvers,
    };
  }

  // ---------- Turn a circle (point + radius) into an exclude polygon ----------
  // Handy for "avoid this whole area" when the user taps rather than draws.
  function circlePolygon(lat, lon, radiusM, steps = 16) {
    const ring = [];
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return ring; // [lon,lat] ring, as Valhalla expects
  }

  class RouteError extends Error {
    constructor(message, code) { super(message); this.name = "RouteError"; this.code = code; }
  }

  FCR.Routing = {
    setEndpoint, getEndpoint, getDefaultEndpoint,
    geocode, route, buildRequest, decodePolyline, circlePolygon, RouteError,
  };
})();
