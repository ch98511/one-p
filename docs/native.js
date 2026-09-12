/* FCR.env + FCR.NativeGeo — native (Capacitor) integration.
 *
 * On the web this file is inert: FCR.env.native === false and FCR.NativeGeo is
 * null, so app.js falls back to navigator.geolocation exactly as before.
 *
 * Inside the Capacitor Android app it routes the shared location watch through
 * @capacitor-community/background-geolocation, which runs a foreground service —
 * so alerts and track recording keep receiving fixes with the screen off or the
 * app backgrounded (the thing a plain PWA cannot do).
 */
(() => {
  "use strict";
  const FCR = (window.FCR = window.FCR || {});

  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  const platform = cap && typeof cap.getPlatform === "function" ? cap.getPlatform() : "web";
  FCR.env = { native: isNative, platform };

  if (!isNative || typeof cap.registerPlugin !== "function") {
    FCR.NativeGeo = null;
    return;
  }

  // A proxy straight to the native plugin — no bundler/import needed.
  const BG = cap.registerPlugin("BackgroundGeolocation");

  // Adapt a plugin location object to the {coords:{…}} shape app.js expects.
  const toGeo = (loc) => ({
    coords: {
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      altitude: loc.altitude != null ? loc.altitude : null,
      speed: loc.speed != null ? loc.speed : null,
      heading: loc.bearing != null ? loc.bearing : null,
    },
    timestamp: loc.time || Date.now(),
  });

  FCR.NativeGeo = {
    _id: null,
    active() { return !!this._id; },
    async start(onPos, onErr) {
      if (this._id) return;
      try {
        this._id = await BG.addWatcher(
          {
            backgroundTitle: "Flock Camera Radar",
            backgroundMessage: "Watching for cameras / recording your track.",
            requestPermissions: true,
            stale: false,
            distanceFilter: 5, // meters between callbacks
          },
          (location, error) => {
            if (error) {
              const code = error.code === "NOT_AUTHORIZED" ? 1 : 2;
              if (onErr) onErr({ code, message: error.message || "Location error" });
              return;
            }
            if (location) onPos(toGeo(location));
          }
        );
      } catch (e) {
        if (onErr) onErr({ code: 2, message: (e && e.message) || "Could not start background location" });
      }
    },
    async stop() {
      const id = this._id;
      this._id = null;
      if (id) { try { await BG.removeWatcher({ id }); } catch (e) { console.warn("removeWatcher", e); } }
    },
    // If the OS refused background location, this opens the app's settings page.
    openSettings() { try { BG.openSettings(); } catch {} },
  };
})();
