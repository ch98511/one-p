# Native Android app (Capacitor) — build & install on your phone

This wraps the same web app (`docs/`) in a real Android app so it can do what a
browser PWA cannot: keep **recording tracks and running camera alerts with the
screen off / app backgrounded** (via a foreground-service location stream), and
**relaunch after boot**.

> **Where the build happens:** on **your PC**, where your phone is attached via
> USB / wireless debugging. It is **not** built by the cloud coding session —
> that container has no Android SDK and no route to your phone. The commands
> below are what you run locally.

---

## Prerequisites (on your PC, once)

- **Node.js 18+** and npm
- **JDK 17+** — the one bundled with Android Studio is easiest
- **Android SDK** — install **Android Studio** (gives you the SDK, platform-tools/`adb`,
  and an emulator), or the command-line tools. Make sure `adb` is on your PATH.
- Your phone with **Developer options + USB or Wireless debugging** enabled (done ✅),
  and authorized for this PC (`adb devices` shows it as `device`, not `unauthorized`).

Set the SDK location once (either export the env var, or create
`android/local.properties`):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"      # macOS/Linux (adjust path)
# or, in android/local.properties:
# sdk.dir=/Users/you/Library/Android/sdk
```

---

## Build & install (3 commands)

```bash
git checkout claude/flock-alert-constraint-routing-xf3isa
git pull

npm install            # Capacitor + the background-geolocation plugin
npx cap sync android   # copies docs/ into the app and wires the plugin

# plug in / connect the phone, then:
npx cap run android    # builds, installs to the connected phone, and launches it
```

Alternatives to the last step:

```bash
# Install the debug APK straight to the attached device:
cd android && ./gradlew installDebug

# Or open the project in Android Studio and press Run:
npx cap open android
```

The built APK (if you want to copy it around) is at:
`android/app/build/outputs/apk/debug/app-debug.apk`

### Wireless debugging
On Android 11+: **Developer options → Wireless debugging → Pair device with pairing code**,
then on your PC `adb pair <ip>:<port>` and `adb connect <ip>:<port>`. Once `adb devices`
lists it, `npx cap run android` will offer it as a target.

---

## First launch — grant these

1. **Location → "Allow all the time"** (not just "While using"). Background
   recording/alerts need the *all the time* grant. The app prompts on the first
   record/monitor; if you tapped "While using", change it in
   **Settings → Apps → Flock Camera Radar → Permissions → Location**.
2. **Notifications: Allow** (Android 13+) — the foreground-service notification is
   what keeps location alive in the background.

While recording or monitoring you'll see a persistent notification — that's the
foreground service keeping GPS running with the screen off.

---

## "Wake and run at startup"

- In the app: **Tracks → "Start recording automatically when the app opens"**.
  After a reboot the app relaunches (see below) and, with this on, starts
  recording immediately.
- **Disable battery optimization** for the app:
  **Settings → Apps → Flock Camera Radar → Battery → Unrestricted**.
- **OEM ROMs (Xiaomi/MIUI, Samsung, Oppo, Vivo, Huawei…)** add their own
  "Autostart"/"Auto-launch" allowlist — enable the app there, or boot relaunch
  and background location will be killed.

**Honest limits:** Android 10+ restricts apps from starting themselves from the
background, and each OEM enforces it differently — so boot-autostart is
best-effort and depends on the per-device settings above. Truly guaranteed
always-on/headless detection (no UI at all) would require porting the detection
loop into the native foreground service; today the detection logic runs in the
app's web layer, so the app has to be running. **iOS** cannot auto-launch an app
at boot at all (background location works with "Always" permission, but the user
must open the app once per boot).

---

## Updating after web changes

The web app lives in `docs/`. After any change there:

```bash
npm run sync            # = npx cap sync android  (re-copies docs/ into the app)
npx cap run android     # rebuild + reinstall
```

---

## Release build (optional, for a signed APK to keep)

Debug builds are fine for personal sideloading. For a signed release APK:

```bash
keytool -genkey -v -keystore flock.keystore -alias flock -keyalg RSA -keysize 2048 -validity 10000
cd android && ./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file=$PWD/../flock.keystore \
  -Pandroid.injected.signing.store.password=*** \
  -Pandroid.injected.signing.key.alias=flock \
  -Pandroid.injected.signing.key.password=***
# → android/app/build/outputs/apk/release/app-release.apk
```

Keep the keystore safe and out of git (it already is via `.gitignore` patterns).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SDK location not found` | Set `ANDROID_HOME` or `android/local.properties` (see above). |
| `Failed to install ... licenses not accepted` | `yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses` |
| `adb: no devices/unauthorized` | Reconnect, confirm the "Allow USB debugging?" prompt on the phone. |
| Location stops when screen off | Grant "Allow all the time" + set Battery to Unrestricted + OEM autostart. |
| App shows old web UI after edits | You skipped `npx cap sync android` before rebuilding. |
| Gradle/JDK error | Use JDK 17 (Android Studio's bundled JDK); `./gradlew --version` to check. |

The architecture rationale (why Capacitor, what's native vs. web) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8.
