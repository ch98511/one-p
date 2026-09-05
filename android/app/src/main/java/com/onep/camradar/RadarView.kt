package com.onep.camradar

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * A fully offline "radar" — no map tiles, no network. Draws you at the centre
 * with concentric distance rings (north up) and a blip for every nearby camera
 * placed by its real bearing and distance.
 */
class RadarView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private var cams: List<Cam> = emptyList()
    private var rangeM: Double = 1000.0
    private var alertM: Double = 150.0

    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = Color.parseColor("#334155"); strokeWidth = 2f
    }
    private val alertRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = Color.parseColor("#ef4444"); strokeWidth = 3f
    }
    private val blipFlock = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#38bdf8") }
    private val blipOther = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#f59e0b") }
    private val user = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#22c55e") }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#94a3b8"); textSize = 28f; textAlign = Paint.Align.CENTER
    }

    fun setData(cams: List<Cam>, rangeM: Double, alertM: Double) {
        this.cams = cams
        this.rangeM = rangeM.coerceAtLeast(50.0)
        this.alertM = alertM
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val r = min(cx, cy) - 16f

        // distance rings at 1/3, 2/3, 3/3 of range
        for (k in 1..3) canvas.drawCircle(cx, cy, r * k / 3f, ring)
        // alert radius ring (red) if within view
        if (alertM <= rangeM) canvas.drawCircle(cx, cy, (r * (alertM / rangeM)).toFloat(), alertRing)

        // N / E / S / W labels
        canvas.drawText("N", cx, cy - r - 4f, label)
        canvas.drawText("S", cx, cy + r + 24f, label)
        canvas.drawText("E", cx + r + 12f, cy + 10f, label)
        canvas.drawText("W", cx - r - 12f, cy + 10f, label)

        // camera blips
        for (c in cams) {
            if (c.dist > rangeM) continue
            val rad = Math.toRadians(c.bearing)
            val f = (c.dist / rangeM).toFloat()
            val x = cx + (r * f * sin(rad)).toFloat()
            val y = cy - (r * f * cos(rad)).toFloat()
            val paint = if (c.flock) blipFlock else blipOther
            canvas.drawCircle(x, y, if (c.dist <= alertM) 10f else 7f, paint)
        }

        // you, in the centre
        canvas.drawCircle(cx, cy, 9f, user)
    }
}
