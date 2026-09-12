-- Flock routing schema. Runs once, on first `db` container init.
-- Mirrors docs/ARCHITECTURE.md §4. The camera import (scripts/import_cameras.py)
-- needs only `surveillance_cameras`; the rest is scaffolding for the future API.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Public surveillance cameras, ingested from OSM/Overpass (DeFlock).
CREATE TABLE IF NOT EXISTS surveillance_cameras (
  id          bigint PRIMARY KEY,               -- OSM node id
  category    text NOT NULL,                    -- 'flock' | 'alpr' | 'cctv'
  vendor      text,
  osm_type    text,                             -- surveillance:type / camera:type
  geom        geometry(Point, 4326) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cameras_gix      ON surveillance_cameras USING gist (geom);
CREATE INDEX IF NOT EXISTS cameras_category ON surveillance_cameras (category);

-- Users (for saved filters / history once the API lands).
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A stored routing policy (exclude / avoid / prefer / require).
CREATE TABLE IF NOT EXISTS route_filters (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  filter_type   text NOT NULL,          -- 'exclude' | 'avoid' | 'prefer' | 'require'
  target_kind   text NOT NULL,          -- 'polygon' | 'road' | 'waypoint' | 'feature'
  geometry      geometry(Geometry, 4326),
  road_ref      text,                   -- OSM way id when target_kind='road'
  feature       text,                   -- 'toll' | 'motorway' | 'ferry' | 'camera' ...
  penalty       double precision NOT NULL DEFAULT 0,  -- + penalize, - prefer, huge = exclude
  active        boolean NOT NULL DEFAULT true,
  vehicle_type  text,                   -- NULL = all
  start_time    time,
  end_time      time,
  days_of_week  int[],                  -- 1..7, NULL = all
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_filters_gix  ON route_filters USING gist (geometry);
CREATE INDEX IF NOT EXISTS route_filters_user ON route_filters (user_id) WHERE active;

-- Past routes.
CREATE TABLE IF NOT EXISTS route_history (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  origin        geometry(Point, 4326),
  destination   geometry(Point, 4326),
  policy        jsonb,
  distance_km   double precision,
  duration_min  double precision,
  created_at    timestamptz NOT NULL DEFAULT now()
);
