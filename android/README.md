# Camera Radar — native Android app

A fully **offline**, **native** Android app (Kotlin, AOSP-only) that warns you
when you approach an automated license-plate reader (**ALPR / Flock Safety**)
camera.

## Privacy by design

- **No `INTERNET` permission.** Open `app/src/main/AndroidManifest.xml` — there is
  deliberately no internet permission, so the app *physically cannot* send your
  location (or anything else) off the device.
- **No Google Play Services, no Firebase, no analytics.** Location comes from
  Android's built-in `LocationManager` (GPS + network provider).
- **Camera data is bundled inside the app** (`app/src/main/assets/cameras.json`)
  and read locally. Nothing is fetched at runtime.

## What it does

- Foreground service tracks your GPS and, on every fix, finds the nearest camera
  (bounding-box prefilter + haversine) from the bundled worldwide dataset.
- **Alerts** with a high-priority notification + vibration when a camera is within
  your alert distance (default 150 m). Works with the screen off (foreground
  service + wake lock).
- Offline **radar view** (no map tiles) showing cameras around you by real bearing
  and distance, plus a live nearby list.
- Adjustable alert distance and a "Flock only" filter.

## Install (sideload — no store, no computer)

1. Copy the built `app-debug.apk` to your phone.
2. Tap it in your Files app. Android will ask to allow installing from this
   source — enable it, then **Install**.
3. Open **Camera Radar**, grant **Location** (choose *Allow all the time* for
   background alerts) and **Notifications**, tap **Start monitoring**.
4. Tap **Test alert** to confirm the notification + vibration fire.

## Build it yourself

Requires the Android SDK (platform 34, build-tools 34.0.0) and JDK 17+.

```bash
cd android
echo "sdk.dir=/path/to/android-sdk" > local.properties
gradle :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

## Refresh the camera data

The bundled dataset is generated from OpenStreetMap (the DeFlock ALPR dataset):

```bash
node ../tools/fetch-cameras.mjs   # rewrites app/src/main/assets/cameras.json
```

Then rebuild. Data © OpenStreetMap contributors, ODbL.

## Limitations

- Coverage depends on what OpenStreetMap contributors have mapped — a missing
  camera means nobody has mapped it yet.
- Background behavior is subject to your phone's battery optimization. If alerts
  stop when the screen is off for a long time, exclude the app from battery
  optimization in Android settings.
- **Don't use while driving distracted** — rely on the audio/vibration cue.
