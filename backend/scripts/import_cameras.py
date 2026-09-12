#!/usr/bin/env python3
"""Import public surveillance cameras from OpenStreetMap (Overpass) into PostGIS.

Categorizes each `man_made=surveillance` node into flock / alpr / cctv — the same
logic the PWA uses — and upserts it into the `surveillance_cameras` table.

Examples
--------
    # Indianapolis-ish bounding box (south,west,north,east)
    python import_cameras.py --bbox 39.60,-86.40,39.95,-85.95

    # Only ALPR + Flock (skip generic CCTV)
    python import_cameras.py --bbox 39.60,-86.40,39.95,-85.95 --alpr-only

DB connection (first match wins):
    --dsn "postgresql://user:pass@host:5432/db"
    $DATABASE_URL
    $POSTGRES_USER / $POSTGRES_PASSWORD / $POSTGRES_DB / $POSTGRES_HOST / $POSTGRES_PORT
"""
import argparse
import os
import re
import sys
import time

import requests
import psycopg2
from psycopg2.extras import execute_values

OVERPASS_DEFAULT = "https://overpass-api.de/api/interpreter"
# Overpass rejects the default python-requests UA with 406; a descriptive UA is
# also the polite convention for OSM services.
HEADERS = {"User-Agent": "FlockCamRadar/1.0 (camera import; +https://github.com/ch98511/one-p)"}

FLOCK_RE = re.compile(r"flock", re.I)
ALPR_RE = re.compile(r"alpr|anpr|licen[cs]e|plate", re.I)


def categorize(tags):
    vendor = tags.get("manufacturer") or tags.get("brand") or tags.get("operator") or ""
    if FLOCK_RE.search(vendor):
        return "flock", vendor
    stype = f"{tags.get('surveillance:type', '')} {tags.get('description', '')}"
    if ALPR_RE.search(stype):
        return "alpr", vendor
    return "cctv", vendor


def build_query(bbox, alpr_only):
    s, w, n, e = bbox
    box = f"{s},{w},{n},{e}"
    if alpr_only:
        body = (
            f'node["man_made"="surveillance"]["surveillance:type"~"ALPR",i]({box});'
            f'node["man_made"="surveillance"]["manufacturer"~"Flock",i]({box});'
            f'node["man_made"="surveillance"]["brand"~"Flock",i]({box});'
        )
    else:
        body = f'node["man_made"="surveillance"]({box});'
    return f"[out:json][timeout:180];({body});out body;"


def fetch(overpass_url, query, retries=3):
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(overpass_url, data={"data": query}, headers=HEADERS, timeout=200)
            r.raise_for_status()
            return r.json().get("elements", [])
        except Exception as err:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  Overpass attempt {attempt} failed ({err}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit("Overpass request failed after retries.")


def rows_from(elements):
    rows = []
    for el in elements:
        if el.get("type") != "node" or "lat" not in el:
            continue
        tags = el.get("tags", {})
        category, vendor = categorize(tags)
        osm_type = tags.get("surveillance:type") or tags.get("camera:type") or tags.get("surveillance")
        rows.append((el["id"], category, vendor or None, osm_type, el["lon"], el["lat"]))
    return rows


def dsn_from_env(args):
    if args.dsn:
        return args.dsn
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    user = os.getenv("POSTGRES_USER", "flock")
    pw = os.getenv("POSTGRES_PASSWORD", "flock")
    db = os.getenv("POSTGRES_DB", "flock")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{pw}@{host}:{port}/{db}"


UPSERT = """
INSERT INTO surveillance_cameras (id, category, vendor, osm_type, geom, updated_at)
VALUES %s
ON CONFLICT (id) DO UPDATE SET
  category   = EXCLUDED.category,
  vendor     = EXCLUDED.vendor,
  osm_type   = EXCLUDED.osm_type,
  geom       = EXCLUDED.geom,
  updated_at = now();
"""

TEMPLATE = "(%s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), now())"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", required=True, help="south,west,north,east (WGS84 degrees)")
    ap.add_argument("--alpr-only", action="store_true", help="only ALPR/Flock cameras")
    ap.add_argument("--overpass", default=os.getenv("OVERPASS_URL", OVERPASS_DEFAULT))
    ap.add_argument("--dsn", help="Postgres DSN (overrides env)")
    args = ap.parse_args()

    try:
        bbox = tuple(float(x) for x in args.bbox.split(","))
        assert len(bbox) == 4
    except (ValueError, AssertionError):
        raise SystemExit("--bbox must be four comma-separated numbers: south,west,north,east")

    print(f"Querying Overpass for cameras in {bbox} ...")
    elements = fetch(args.overpass, build_query(bbox, args.alpr_only))
    rows = rows_from(elements)
    counts = {"flock": 0, "alpr": 0, "cctv": 0}
    for r in rows:
        counts[r[1]] += 1
    print(f"  Found {len(rows)} cameras — flock={counts['flock']} alpr={counts['alpr']} cctv={counts['cctv']}")
    if not rows:
        print("  Nothing to import.")
        return

    dsn = dsn_from_env(args)
    print(f"Upserting into {re.sub(r':[^:@/]+@', ':****@', dsn)} ...")
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        execute_values(cur, UPSERT, rows, template=TEMPLATE, page_size=500)
        conn.commit()
        cur.execute("SELECT count(*) FROM surveillance_cameras;")
        total = cur.fetchone()[0]
    print(f"Done. surveillance_cameras now holds {total} rows.")


if __name__ == "__main__":
    main()
