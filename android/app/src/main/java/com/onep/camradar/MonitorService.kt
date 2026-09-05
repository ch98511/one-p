package com.onep.camradar

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Snapshot of monitoring state the UI polls. */
data class Snapshot(
    val monitoring: Boolean = false,
    val hasFix: Boolean = false,
    val accuracy: Float = 0f,
    val nearest: Cam? = null,
    val nearby: List<Cam> = emptyList(),
    val camerasLoaded: Int = 0,
)

class MonitorService : Service(), LocationListener {

    private val binder = LocalBinder()
    inner class LocalBinder : Binder() {
        fun service(): MonitorService = this@MonitorService
    }

    @Volatile var snapshot: Snapshot = Snapshot()
        private set

    private var repo: CameraRepository? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val alertedAt = HashMap<String, Long>()
    private var lastLoc: Location? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        // Parse the bundled dataset off the main thread.
        Thread {
            val r = CameraRepository.get(applicationContext)
            repo = r
            snapshot = snapshot.copy(camerasLoaded = r.size)
        }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopMonitoring(); return START_NOT_STICKY }
            ACTION_TEST -> { fireTestAlert(); return START_STICKY }
            else -> startMonitoring()
        }
        return START_STICKY
    }

    private fun startMonitoring() {
        startForeground(ONGOING_ID, buildOngoing("Monitoring…", "Waiting for GPS fix"))
        acquireWake()
        snapshot = snapshot.copy(monitoring = true)

        if (!hasLocationPermission()) {
            updateOngoing("Location permission needed", "Open the app and grant location")
            return
        }
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_TIME_MS, MIN_DIST_M, this)
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_TIME_MS, MIN_DIST_M, this)
            }
        } catch (_: SecurityException) {
            updateOngoing("Location permission needed", "Grant location to monitor")
        }
    }

    private fun stopMonitoring() {
        try {
            val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            lm.removeUpdates(this)
        } catch (_: Exception) {}
        releaseWake()
        snapshot = snapshot.copy(monitoring = false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onLocationChanged(location: Location) {
        lastLoc = location
        val r = repo
        val alertR = prefs().getInt(KEY_ALERT_R, 150).toDouble()
        val flockOnly = prefs().getBoolean(KEY_FLOCK_ONLY, false)
        val range = maxOf(alertR * 4, 1200.0)

        if (r == null || r.size == 0) {
            snapshot = snapshot.copy(hasFix = true, accuracy = location.accuracy)
            updateOngoing("Loading cameras…", "GPS ±${Math.round(location.accuracy)} m")
            return
        }
        val near = r.nearby(location.latitude, location.longitude, range, flockOnly)
        val nearest = near.firstOrNull()
        snapshot = Snapshot(
            monitoring = true, hasFix = true, accuracy = location.accuracy,
            nearest = nearest, nearby = near, camerasLoaded = r.size,
        )

        if (nearest != null && nearest.dist <= alertR) {
            updateOngoing("⚠ Camera ${Geo.fmt(nearest.dist)}", vendorLine(nearest))
            maybeAlert(nearest)
        } else if (nearest != null) {
            updateOngoing("Nearest camera ${Geo.fmt(nearest.dist)}", vendorLine(nearest))
        } else {
            updateOngoing("Clear", "No cameras within ${Geo.fmt(range)}")
        }
    }

    // Older devices call these; provide no-op overrides for compatibility.
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    @Deprecated("Deprecated in API 29")
    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}

    private fun maybeAlert(cam: Cam) {
        val key = keyOf(cam)
        val now = System.currentTimeMillis()
        val last = alertedAt[key] ?: 0L
        if (now - last < ALERT_COOLDOWN_MS) return
        alertedAt[key] = now
        pruneAlerts(now)
        fireAlert("⚠ ${if (cam.flock) "Flock" else "ALPR"} camera ahead", vendorLine(cam))
    }

    private fun pruneAlerts(now: Long) {
        val it = alertedAt.entries.iterator()
        while (it.hasNext()) if (now - it.next().value > 5 * 60_000L) it.remove()
    }

    private fun fireTestAlert() {
        if (snapshot.camerasLoaded == 0) { /* still fine */ }
        fireAlert("⚠ Test alert", "This is what a camera warning looks like")
    }

    private fun fireAlert(title: String, body: String) {
        vibrate()
        val n = NotificationCompat.Builder(this, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_radar)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(openAppIntent())
            .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_LIGHTS)
            .build()
        nm().notify(ALERT_ID, n)
    }

    private fun vibrate() {
        val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 250, 120, 250), -1))
    }

    // ---- notifications ----
    private fun createChannels() {
        val mgr = nm()
        mgr.createNotificationChannel(
            NotificationChannel(CH_ONGOING, "Monitoring", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
        mgr.createNotificationChannel(
            NotificationChannel(CH_ALERT, "Camera alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Fires when you approach a camera"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 120, 250)
            }
        )
    }

    private fun buildOngoing(title: String, text: String): Notification =
        NotificationCompat.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_radar)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openAppIntent())
            .build()

    private fun updateOngoing(title: String, text: String) {
        if (!snapshot.monitoring) return
        nm().notify(ONGOING_ID, buildOngoing(title, text))
    }

    private fun openAppIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE)
    }

    // ---- helpers ----
    private fun startForeground(id: Int, n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(this, id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(id, n)
        }
    }

    private fun acquireWake() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "camradar:monitor").also {
            it.setReferenceCounted(false); it.acquire()
        }
    }

    private fun releaseWake() { try { wakeLock?.release() } catch (_: Exception) {}; wakeLock = null }

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun nm() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun keyOf(c: Cam) = "${Math.round(c.lat * 1e5)}:${Math.round(c.lon * 1e5)}"
    private fun vendorLine(c: Cam) =
        "${Geo.compass(c.bearing)} · ${if (c.flock) "Flock" else "ALPR"} camera"

    override fun onBind(intent: Intent?): IBinder = binder
    override fun onDestroy() { releaseWake(); super.onDestroy() }

    companion object {
        const val ACTION_STOP = "com.onep.camradar.STOP"
        const val ACTION_TEST = "com.onep.camradar.TEST"
        const val PREFS = "settings"
        const val KEY_ALERT_R = "alertR"
        const val KEY_FLOCK_ONLY = "flockOnly"

        private const val CH_ONGOING = "monitor"
        private const val CH_ALERT = "alerts"
        private const val ONGOING_ID = 1
        private const val ALERT_ID = 2
        private const val MIN_TIME_MS = 2000L
        private const val MIN_DIST_M = 5f
        private const val ALERT_COOLDOWN_MS = 60_000L
    }
}
