package com.onep.camradar

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var statusDist: TextView
    private lateinit var statusLabel: TextView
    private lateinit var statusSub: TextView
    private lateinit var radar: RadarView
    private lateinit var camCount: TextView
    private lateinit var gpsAcc: TextView
    private lateinit var alertSeek: SeekBar
    private lateinit var alertLabel: TextView
    private lateinit var flockSwitch: Switch
    private lateinit var listContainer: LinearLayout
    private lateinit var startBtn: Button
    private lateinit var stopBtn: Button
    private lateinit var testBtn: Button
    private lateinit var dataInfo: TextView

    private var svc: MonitorService? = null
    private var bound = false
    private val ui = Handler(Looper.getMainLooper())

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            svc = (binder as? MonitorService.LocalBinder)?.service()
        }
        override fun onServiceDisconnected(name: ComponentName?) { svc = null }
    }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val fine = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)
        if (fine) beginMonitoring() else
            Toast.makeText(this, "Location permission is required", Toast.LENGTH_LONG).show()
    }

    private val bgLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* optional; foreground monitoring works either way */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusDist = findViewById(R.id.statusDist)
        statusLabel = findViewById(R.id.statusLabel)
        statusSub = findViewById(R.id.statusSub)
        radar = findViewById(R.id.radar)
        camCount = findViewById(R.id.camCount)
        gpsAcc = findViewById(R.id.gpsAcc)
        alertSeek = findViewById(R.id.alertSeek)
        alertLabel = findViewById(R.id.alertLabel)
        flockSwitch = findViewById(R.id.flockSwitch)
        listContainer = findViewById(R.id.listContainer)
        startBtn = findViewById(R.id.startBtn)
        stopBtn = findViewById(R.id.stopBtn)
        testBtn = findViewById(R.id.testBtn)
        dataInfo = findViewById(R.id.dataInfo)

        val p = getSharedPreferences(MonitorService.PREFS, Context.MODE_PRIVATE)
        val alertR = p.getInt(MonitorService.KEY_ALERT_R, 150)
        alertSeek.max = 570 // 30..600
        alertSeek.progress = alertR - 30
        alertLabel.text = "Alert distance: $alertR m"
        flockSwitch.isChecked = p.getBoolean(MonitorService.KEY_FLOCK_ONLY, false)

        alertSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                val v = ((progress + 30) / 10) * 10
                alertLabel.text = "Alert distance: $v m"
                p.edit().putInt(MonitorService.KEY_ALERT_R, v).apply()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })
        flockSwitch.setOnCheckedChangeListener { _, checked ->
            p.edit().putBoolean(MonitorService.KEY_FLOCK_ONLY, checked).apply()
        }

        startBtn.setOnClickListener { onStartClicked() }
        stopBtn.setOnClickListener {
            startService(Intent(this, MonitorService::class.java).setAction(MonitorService.ACTION_STOP))
        }
        testBtn.setOnClickListener {
            startService(Intent(this, MonitorService::class.java).setAction(MonitorService.ACTION_TEST))
        }
    }

    private fun onStartClicked() {
        val need = ArrayList<String>()
        if (!hasPerm(Manifest.permission.ACCESS_FINE_LOCATION))
            need.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPerm(Manifest.permission.POST_NOTIFICATIONS))
            need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (need.isEmpty()) beginMonitoring() else permLauncher.launch(need.toTypedArray())
    }

    private fun beginMonitoring() {
        ContextCompat.startForegroundService(this, Intent(this, MonitorService::class.java))
        bindMonitor()
        // Ask for "allow all the time" so alerts keep working in the background.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            !hasPerm(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    private fun bindMonitor() {
        if (!bound) {
            bound = bindService(
                Intent(this, MonitorService::class.java), conn, Context.BIND_AUTO_CREATE
            )
        }
    }

    override fun onStart() {
        super.onStart()
        bindMonitor()
    }

    override fun onResume() {
        super.onResume()
        ui.post(tick)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(tick)
    }

    override fun onStop() {
        super.onStop()
        if (bound) { try { unbindService(conn) } catch (_: Exception) {} ; bound = false; svc = null }
    }

    private val tick = object : Runnable {
        override fun run() {
            render(svc?.snapshot ?: Snapshot())
            ui.postDelayed(this, 500)
        }
    }

    private fun render(s: Snapshot) {
        val p = getSharedPreferences(MonitorService.PREFS, Context.MODE_PRIVATE)
        val alertR = p.getInt(MonitorService.KEY_ALERT_R, 150).toDouble()
        val range = maxOf(alertR * 4, 1200.0)

        startBtn.visibility = if (s.monitoring) android.view.View.GONE else android.view.View.VISIBLE
        stopBtn.visibility = if (s.monitoring) android.view.View.VISIBLE else android.view.View.GONE

        camCount.text = s.nearby.size.toString()
        gpsAcc.text = if (s.hasFix) Math.round(s.accuracy).toString() else "—"
        dataInfo.text = if (s.camerasLoaded > 0)
            "${s.camerasLoaded} cameras loaded · offline" else "Loading camera data…"

        radar.setData(s.nearby, range, alertR)

        val nearest = s.nearest
        when {
            !s.monitoring -> setStatus("—", "Not monitoring", "Press Start to watch for cameras")
            !s.hasFix -> setStatus("…", "Locating", "Getting your GPS position…")
            nearest == null -> setStatus("—", "Clear", "No cameras within ${Geo.fmt(range)}")
            nearest.dist <= alertR -> setStatus(Geo.fmt(nearest.dist), "⚠ Camera ahead",
                "${Geo.compass(nearest.bearing)} · ${if (nearest.flock) "Flock" else "ALPR"} camera")
            nearest.dist <= alertR * 2 -> setStatus(Geo.fmt(nearest.dist), "Getting close",
                "${Geo.compass(nearest.bearing)} · ${if (nearest.flock) "Flock" else "ALPR"} camera")
            else -> setStatus(Geo.fmt(nearest.dist), "Clear",
                "Nearest ${Geo.compass(nearest.bearing)} · ${if (nearest.flock) "Flock" else "ALPR"}")
        }

        // nearby list (top 8)
        listContainer.removeAllViews()
        for (c in s.nearby.take(8)) {
            val row = TextView(this).apply {
                text = "${Geo.fmt(c.dist)}   ${Geo.compass(c.bearing)}   ${if (c.flock) "Flock" else "ALPR"}"
                setTextColor(0xFFE2E8F0.toInt())
                textSize = 15f
                setPadding(24, 18, 24, 18)
            }
            listContainer.addView(row)
        }
    }

    private fun setStatus(big: String, label: String, sub: String) {
        statusDist.text = big
        statusLabel.text = label
        statusSub.text = sub
    }

    private fun hasPerm(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
}
