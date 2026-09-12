# Flock routing backend — infrastructure

Self-hosted routing so you're not dependent on the public Valhalla demo server.
This is the **infra-first** slice from [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md):
a routing engine, a spatial database, and a camera importer. The custom
rule-engine **API** (`/v1/route`, saved filters, history) comes later — the app
talks to Valhalla directly for now.

```
valhalla   OSM routing engine (exclude_polygons / exclude_locations / costing)   :8002
db         PostGIS — surveillance_cameras (+ scaffolding for filters/history)     :5432
proxy      Caddy — adds CORS/TLS, serves the PWA same-origin (optional)      :8080 / :8443
```

## Prerequisites
- Docker + Docker Compose
- ~2–8 GB free disk and a few minutes for the first Valhalla graph build
  (depends on the region extract you choose)

## 1. Configure
```bash
cd backend
cp .env.example .env
# edit .env → set PBF_URL to your region from https://download.geofabrik.de
```

## 2. Start the engine + database
```bash
docker compose up -d db valhalla
docker compose logs -f valhalla    # watch the first build; ready when it serves on :8002
```
First run downloads the PBF and builds the routing graph (slow). Later runs reuse
the tiles in `./custom_files`. After swapping `PBF_URL`, rebuild with
`force_rebuild: "True"` in `docker-compose.yml` (flip back to `False` afterward).

Smoke-test the engine:
```bash
curl -s http://localhost:8002/status
curl -s http://localhost:8002/route -H 'Content-Type: application/json' -d '{
  "locations":[{"lat":39.7684,"lon":-86.1581},{"lat":39.7173,"lon":-86.2955}],
  "costing":"auto"}' | head -c 200
```

## 3. Import cameras into PostGIS
```bash
pip install -r scripts/requirements.txt
# bbox is south,west,north,east (WGS84). Match roughly to your routing region.
python scripts/import_cameras.py --bbox 39.60,-86.40,39.95,-85.95
# ALPR/Flock only:
python scripts/import_cameras.py --bbox 39.60,-86.40,39.95,-85.95 --alpr-only
```
The DB connection defaults to the `.env` credentials on `localhost:5432`
(override with `--dsn` or `DATABASE_URL`). Verify:
```bash
docker compose exec db psql -U flock -d flock -c \
  "SELECT category, count(*) FROM surveillance_cameras GROUP BY category;"
```
Re-run it on a schedule (cron) to keep cameras fresh — it upserts by OSM id.

## 4. Point the app at your engine

Valhalla sends **no CORS headers**, and a browser won't let an https page call a
plain-http server — so the PWA can't hit `http://localhost:8002` directly. The
`proxy` (Caddy) service fixes both.

**Local dev (one origin, simplest):**
```bash
docker compose --profile proxy up -d
# open the app served BY Caddy so page + routing share an origin:
#   http://localhost:8080
# then in the app:  Settings → Routing engine → http://localhost:8080
```

**Phone / production:** run this on a host with a domain, use **Mode B** in
[`caddy/Caddyfile`](caddy/Caddyfile) (automatic HTTPS + CORS for your Pages
origin), then set **Settings → Routing engine → `https://routing.yourdomain.com`**.
`https://<you>.github.io` cannot call `http://localhost` — a real TLS endpoint is
required for the installed PWA.

> The app's routing client posts to `${endpoint}/route`, so any Valhalla-
> compatible endpoint works — no front-end changes needed.

## Stop / reset
```bash
docker compose down             # stop
docker compose down -v          # stop + wipe the DB volume
rm -rf custom_files             # force a full Valhalla rebuild next time
```

## What's next (the API layer)
When you're ready to graduate from "app calls Valhalla directly" to the stored
**policy engine** (prefer-corridors, time/vehicle-conditioned rules, saved
filters, history), add the API service described in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §5 — it reads `route_filters`
+ `surveillance_cameras` from this same PostGIS and expands them into Valhalla
requests. The schema in `db/init/01_schema.sql` is already in place for it.
