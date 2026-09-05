// Fetch all ALPR / Flock surveillance cameras from OpenStreetMap (Overpass),
// worldwide (the tag is rare & US-concentrated), and write a compact bundle.
// Runs at BUILD TIME on the developer's machine — never on the user's phone.
import { writeFileSync } from "node:fs";
const OUT = new URL("../android/app/src/main/assets/cameras.json", import.meta.url);
const query = `[out:json][timeout:300];
(
  node["man_made"="surveillance"]["surveillance:type"~"ALPR",i];
  node["man_made"="surveillance"]["manufacturer"~"Flock",i];
  node["man_made"="surveillance"]["brand"~"Flock",i];
);
out body;`;
const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) { console.log(`[${attempt}] ${url} -> HTTP ${res.status}`); continue; }
        const j = await res.json();
        const els = j.elements || [];
        if (!els.length) { console.log(`[${attempt}] ${url} -> 0 elements, retrying`); continue; }
        const seen = new Set();
        const cams = [];
        for (const e of els) {
          if (e.type !== "node" || typeof e.lat !== "number") continue;
          if (seen.has(e.id)) continue; seen.add(e.id);
          const t = e.tags || {};
          const vendor = (t.manufacturer || t.brand || t.operator || "");
          const f = /flock/i.test(vendor) ? 1 : 0;
          cams.push([+e.lat.toFixed(5), +e.lon.toFixed(5), f]);
        }
        const flock = cams.filter((c) => c[2]).length;
        const bundle = { v: 1, generated: new Date().toISOString().slice(0, 10), source: "OpenStreetMap / DeFlock (ODbL)", count: cams.length, flock, cameras: cams };
        writeFileSync(OUT, JSON.stringify(bundle));
        console.log(`OK: ${cams.length} cameras (${flock} Flock-tagged) -> cameras.json`);
        return 0;
      } catch (e) { console.log(`[${attempt}] ${url} -> ERR ${e.message}`); }
    }
    const back = Math.min(30000, 3000 * 2 ** attempt);
    console.log(`  all endpoints busy; backoff ${back / 1000}s`);
    await sleep(back);
  }
  console.log("FAILED: could not fetch after retries");
  return 1;
}
process.exit(await run());
