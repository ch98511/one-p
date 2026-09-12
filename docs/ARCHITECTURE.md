# Architecture — constraint-aware routing + live surveillance map

This document is the build plan for the app. It describes **what ships today**
(a keyless, static PWA) and the **production stack** to graduate into when you
outgrow public demo servers.

---

## 1. What ships today (the MVP in `docs/`)

A static Progressive Web App — no backend, no build step, no API keys — that
you can host on GitHub Pages right now.

```
Phone browser (PWA)
  ├─ Leaflet map base            dark / streets / satellite
  ├─ Weather radar overlay       RainViewer  (api.rainviewer.com)   [layers.js]
  ├─ Camera / surveillance layer OpenStreetMap Overpass (DeFlock)   [app.js]
  ├─ Proximity alerts            on-device haversine + notifications [app.js]
  └─ Constraint-aware routing    Valhalla   (valhalla1.openstreetmap.de) [routing.js]
```

### The routing policy → engine mapping (implemented)

The "policy engine" idea is implemented client-side in `routing.js`. Each UI
control becomes a field in a Valhalla request:

| Control (UI)               | Policy field            | Valhalla translation                     | Strength |
|----------------------------|-------------------------|------------------------------------------|----------|
| Avoid tolls                | `avoid.tolls`           | `costing_options.auto.use_tolls = 0`     | soft     |
| Avoid highways             | `avoid.highways`        | `costing_options.auto.use_highways = 0`  | soft     |
| Avoid ferries              | `avoid.ferries`         | `costing_options.*.use_ferry = 0`        | soft     |
| Avoid ALPR/Flock cameras   | `avoid.cameras`         | `exclude_locations: [{lat,lon}, …]`      | hard     |
| Draw avoid area            | `excludePolygons`       | `exclude_polygons: [[[lon,lat],…]]`      | hard     |
| Must-pass waypoint         | `via: [{lat,lon}]`      | intermediate `type:"through"` location   | required |
| Drive / Bike / Walk        | `mode`                  | `costing: auto|bicycle|pedestrian`       | —        |

This is the exact four-way control model from the brief:

```
Exclude  → hard   → infinite cost  → exclude_polygons / exclude_locations
Avoid    → soft   → large penalty  → costing use_* = 0
Prefer   → soft   → reduced cost   → (see §3, needs a custom Valhalla model)
Include  → required            → waypoint / through location
```

> **Camera avoidance** is the feature that ties the two halves of the app
> together: the same OSM camera data that powers proximity alerts is fed to the
> router as `exclude_locations` (capped at the 50 nearest to the trip midline so
> the request stays small).

### Honest limits of the MVP
- **Public demo servers** (Valhalla/Nominatim/Overpass) have fair-use rate
  limits and can go down. Fine for personal use and building; not for a launch.
- **"Prefer road / corridor" (negative penalty)** can't be expressed on the
  stock public Valhalla `/route`. It needs a custom cost model — see §3.
- **Time/vehicle/weather-conditioned rules** aren't in the MVP; they belong in a
  backend rule engine — see §4.
- **Background alerts** are limited for web apps (esp. iOS). A native shell
  (Capacitor/React Native) reusing this same pipeline is the path to always-on.

### Swapping in your own engine today
Settings → *Routing engine* accepts any Valhalla-compatible endpoint. Stand up
your own Valhalla (§3) and paste its URL — nothing else changes.

---

## 2. Production stack (target)

```
Mobile app  (React Native + Mapbox, or keep the PWA + Capacitor)
     │  HTTPS
     ▼
Your Routing API        (FastAPI / Node)  — authenticates, validates, logs
     │
     ▼
Custom Rule Engine      turns stored policies → engine costing + exclusions
     │
     ├── Valhalla / GraphHopper           routing over the OSM graph
     └── PostgreSQL + PostGIS             users, filters, polygons, history
                 ▲
                 └── OpenStreetMap import (osm2pgsql) + camera dataset (DeFlock)
```

Why Valhalla or GraphHopper (not a fixed "avoid tolls/highways" API): both
expose **configurable costing**, which is what makes exclude/avoid/prefer/
require expressible. OSRM is faster but harder to customize dynamically.

---

## 3. Self-hosting the routing engine

**Valhalla (Docker), the fastest path — matches the client we already ship:**
```bash
mkdir valhalla && cd valhalla
# Grab a region extract, e.g. Indiana:
curl -LO https://download.geofabrik.de/north-america/us/indiana-latest.osm.pbf
docker run -it --rm -p 8002:8002 -v "$PWD:/custom_files" \
  -e serve_tiles=True -e build_tar=True \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
# → point the app's Settings → Routing engine at http://<host>:8002
```
Valhalla supports `exclude_polygons`, `exclude_locations`, and per-costing
options out of the box — the MVP already speaks this API.

**Prefer / penalize corridors (the missing "negative penalty"):** use Valhalla
`costing_options.auto.*` avoid factors, or GraphHopper's **`custom_model`**,
which lets you multiply edge weights by attributes and areas:
```jsonc
// GraphHopper custom_model — soft prefer + soft avoid + hard block
{
  "priority": [
    { "if": "in_preferred_corridor",  "multiply_by": 1.4 },  // prefer
    { "if": "in_soft_avoid_area",      "multiply_by": 0.2 }   // avoid
  ],
  "areas": { "type": "FeatureCollection", "features": [ /* GeoJSON polygons */ ] }
}
```
Model this as `cost = travel_time + avoidance_penalty + preference_penalty`,
exactly as in the brief.

---

## 4. Backend: PostgreSQL + PostGIS

PostGIS makes "which road segments intersect this avoid polygon?" a one-line
spatial query and stores every rule as a first-class, queryable object.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  created_at    timestamptz DEFAULT now()
);

-- A stored routing policy. Geometry is optional (point/line rules use *_ref).
CREATE TABLE route_filters (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id),
  filter_type   text NOT NULL,          -- 'exclude' | 'avoid' | 'prefer' | 'require'
  target_kind   text NOT NULL,          -- 'polygon' | 'road' | 'waypoint' | 'feature'
  geometry      geometry(Geometry,4326),-- polygon/point when spatial
  road_ref      text,                   -- OSM way id / road id when target_kind='road'
  feature       text,                   -- 'toll' | 'motorway' | 'ferry' | 'camera' …
  penalty       double precision DEFAULT 0,  -- + penalize, − prefer, huge = exclude
  active        boolean DEFAULT true,
  -- conditional rules
  vehicle_type  text,                   -- NULL = all
  start_time    time, end_time time,    -- time-of-day window
  days_of_week  int[],                  -- 1..7, NULL = all
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX route_filters_gix ON route_filters USING gist (geometry);

CREATE TABLE surveillance_cameras (      -- ingested from OSM/DeFlock
  id            bigint PRIMARY KEY,      -- OSM node id
  category      text,                    -- 'flock' | 'alpr' | 'cctv'
  vendor        text,
  geom          geometry(Point,4326) NOT NULL,
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX cameras_gix ON surveillance_cameras USING gist (geom);

CREATE TABLE route_history (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id),
  origin        geometry(Point,4326),
  destination   geometry(Point,4326),
  policy        jsonb,                   -- snapshot of the request
  distance_km   double precision,
  duration_min  double precision,
  created_at    timestamptz DEFAULT now()
);
```

Example spatial queries the rule engine runs:
```sql
-- Camera exclusions near a trip corridor (buffer the straight line by 300 m)
SELECT id, ST_X(geom) lon, ST_Y(geom) lat
FROM surveillance_cameras
WHERE category IN ('flock','alpr')
  AND ST_DWithin(geom::geography,
        ST_MakeLine(:origin, :destination)::geography, 300);

-- Active avoid polygons for this user, right now, for this vehicle
SELECT ST_AsGeoJSON(geometry) AS ring, penalty
FROM route_filters
WHERE user_id = :uid AND active AND filter_type IN ('avoid','exclude')
  AND (vehicle_type IS NULL OR vehicle_type = :vehicle)
  AND (start_time IS NULL OR localtime BETWEEN start_time AND end_time);
```

---

## 5. Routing API (the policy engine)

One endpoint takes a **policy**, the rule engine expands it (pulling stored
filters + live camera geometry from PostGIS), calls the routing engine, and
returns the route.

```
POST /v1/route
{
  "start":       [-86.20, 39.80],
  "destination": [-86.10, 39.70],
  "mode": "auto",
  "rules": [
    { "type": "avoid_feature",  "feature": "toll",        "strength": "soft" },
    { "type": "avoid_cameras",  "categories": ["flock","alpr"], "strength": "hard" },
    { "type": "avoid_polygon",  "id": 91 },
    { "type": "prefer_road",    "road_id": "12345", "weight": -0.3 },
    { "type": "required_waypoint", "coordinates": [-86.15, 39.74] }
  ]
}
→ 200 { "distance_km", "duration_min", "geometry": {GeoJSON LineString}, "steps":[…] }
```

Other endpoints:
```
GET/POST/DELETE /v1/filters          CRUD on saved route_filters
GET             /v1/cameras?bbox=…   surveillance cameras in a bounding box
GET             /v1/history          past routes
```

Rule-engine cost model (server-side, mirrors the brief):
```python
def edge_cost(edge, ctx):
    if edge.id in ctx.hard_exclusions:      return math.inf
    cost = edge.travel_time
    if intersects(edge, ctx.avoid_areas):   cost *= 10     # soft avoid
    if intersects(edge, ctx.prefer_areas):  cost *= 0.7    # prefer
    return cost
```
(In practice you hand these as costing options / custom models / exclusions to
Valhalla or GraphHopper rather than iterating edges yourself.)

---

## 6. App screens

```
┌──────────────────────────┐   Map (default)          — live map, layers, alerts
│ 🔎 Search destination  ⚙ │   Route sheet            — start/dest, mode, filters
├──────────────────────────┤   Layers sheet           — cameras, radar, base map
│            MAP           │   Settings sheet         — alert dist, radius, engine
│   • you  ▲ cameras       │
│   ~ weather radar        │   (Future) Saved filters — reusable policies
│   ── route line          │   (Future) Trip history  — past routes
├──────────────────────────┤
│ 🧭 Route  🗂 Layers  ▶Go │
└──────────────────────────┘
```

The MVP already implements the Map, Route, Layers, and Settings screens. Saved
filters and history land when the backend (§4–5) exists.

---

## 7. Suggested build order

1. **Ship the PWA** (done) — validate UX with real public data.
2. **Self-host Valhalla** (§3) — remove the public rate limit; paste URL in Settings.
3. **Stand up PostGIS + a thin API** (§4–5) — persist filters, serve camera bbox.
4. **Move the rule engine server-side** — enable prefer/conditional rules.
5. **Native shell** (Capacitor over this PWA, or React Native + Mapbox) — for
   reliable background alerts.
