/* FCR.Tracks — record, store, and back up GPS tracks.
 *
 *  Storage:  IndexedDB (handles long point arrays that outgrow localStorage).
 *  Export:   GPX (opens in any mapping tool) + JSON (full fidelity for restore),
 *            packed into an AES-256 password-encrypted ZIP via zip.js.
 *
 * Privacy note: tracks are your movement history. They live only in this
 * browser's IndexedDB until you export them; the encrypted backup is the only
 * copy that leaves the device, and only you hold the passphrase.
 */
(() => {
  "use strict";
  const FCR = (window.FCR = window.FCR || {});

  const DB_NAME = "fcr.tracks";
  const STORE = "tracks";
  let dbP = null;

  function open() {
    if (dbP) return dbP;
    dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbP;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(store)).then((v) => (out = v));
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // ---------- Geo helpers ----------
  const R_EARTH = 6371000, toRad = (d) => (d * Math.PI) / 180;
  function distance(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  }
  function trackDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += distance(points[i - 1], points[i]);
    return d;
  }

  // ---------- CRUD ----------
  const newTrack = (name) => ({
    id: "trk-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    name: name || new Date().toLocaleString(),
    startedAt: Date.now(), endedAt: null, points: [], distanceM: 0, durationS: 0,
  });
  const save = (track) => tx("readwrite", (s) => reqP(s.put(track)));
  const get = (id) => tx("readonly", (s) => reqP(s.get(id)));
  const remove = (id) => tx("readwrite", (s) => reqP(s.delete(id)));
  async function list() {
    const all = await tx("readonly", (s) => reqP(s.getAll()));
    return (all || []).sort((a, b) => b.startedAt - a.startedAt);
  }
  function finalize(track) {
    track.endedAt = Date.now();
    track.distanceM = trackDistance(track.points);
    const first = track.points[0], last = track.points[track.points.length - 1];
    track.durationS = first && last ? Math.round((last.t - first.t) / 1000) : 0;
    return track;
  }

  // ---------- Serialization ----------
  const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[m]));
  function toGPX(track) {
    const seg = track.points.map((p) => {
      const parts = [`lat="${p.lat}" lon="${p.lon}"`];
      let inner = `<time>${new Date(p.t).toISOString()}</time>`;
      if (p.alt != null) inner += `<ele>${p.alt}</ele>`;
      return `<trkpt ${parts[0]}>${inner}</trkpt>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Flock Camera Radar" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${xmlEsc(track.name)}</name><trkseg>${seg}</trkseg></trk>
</gpx>`;
  }
  const safeName = (s) => String(s).replace(/[^\w.-]+/g, "_").slice(0, 60);

  // ---------- Encrypted ZIP backup (AES-256 via zip.js) ----------
  function ensureZip() {
    if (typeof zip === "undefined") throw new Error("Backup library not loaded");
    zip.configure({ useWebWorkers: false }); // single vendored file, no worker scripts
    return zip;
  }
  // tracks: array of full track records. Returns a Blob (application/zip).
  async function exportZip(tracks, passphrase) {
    if (!passphrase) throw new Error("A backup PIN/passphrase is required");
    const z = ensureZip();
    const blobWriter = new z.BlobWriter("application/zip");
    const zw = new z.ZipWriter(blobWriter, { password: passphrase, encryptionStrength: 3 }); // 3 = AES-256
    // A manifest so a restore knows what's inside.
    const manifest = { app: "flock-camera-radar", kind: "tracks-backup", version: 1, exportedAt: new Date().toISOString(), count: tracks.length };
    await zw.add("manifest.json", new z.TextReader(JSON.stringify(manifest, null, 2)));
    for (const t of tracks) {
      const base = safeName(t.name) + "_" + t.id;
      await zw.add(`json/${base}.json`, new z.TextReader(JSON.stringify(t)));
      await zw.add(`gpx/${base}.gpx`, new z.TextReader(toGPX(t)));
    }
    await zw.close();
    return blobWriter.getData();
  }
  // Reads an encrypted backup zip; returns the array of track records (from json/).
  async function importZip(fileOrBlob, passphrase) {
    if (!passphrase) throw new Error("Enter the PIN/passphrase this backup was made with");
    const z = ensureZip();
    const zr = new z.ZipReader(new z.BlobReader(fileOrBlob), { password: passphrase });
    let entries;
    try {
      entries = await zr.getEntries();
      const out = [];
      for (const e of entries) {
        if (e.directory || !/^json\/.+\.json$/.test(e.filename)) continue;
        const text = await e.getData(new z.TextWriter());
        try { out.push(JSON.parse(text)); } catch {}
      }
      return out;
    } catch (err) {
      // zip.js throws a generic error on a wrong password / corrupt file.
      throw new Error("Could not read backup — wrong PIN or not a Flock backup file.");
    } finally {
      try { await zr.close(); } catch {}
    }
  }
  async function importAndSave(fileOrBlob, passphrase) {
    const tracks = await importZip(fileOrBlob, passphrase);
    let added = 0;
    for (const t of tracks) {
      if (!t || !t.id || !Array.isArray(t.points)) continue;
      await save(t); added++;
    }
    return added;
  }

  FCR.Tracks = {
    newTrack, save, get, remove, list, finalize,
    toGPX, exportZip, importZip, importAndSave,
    trackDistance, distance,
  };
})();
