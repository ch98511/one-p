package com.onep.camradar

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** Pure geographic helpers. No Android dependencies so it is trivially testable. */
object Geo {
    private const val R = 6371000.0 // mean Earth radius, metres

    fun distance(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
        val dLat = Math.toRadians(bLat - aLat)
        val dLon = Math.toRadians(bLon - aLon)
        val s = sin(dLat / 2).pow(2) +
            cos(Math.toRadians(aLat)) * cos(Math.toRadians(bLat)) * sin(dLon / 2).pow(2)
        return 2 * R * asin(min(1.0, sqrt(s)))
    }

    fun bearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
        val dLon = Math.toRadians(bLon - aLon)
        val la1 = Math.toRadians(aLat)
        val la2 = Math.toRadians(bLat)
        val y = sin(dLon) * cos(la2)
        val x = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dLon)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    private val COMPASS = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    fun compass(deg: Double): String = COMPASS[(Math.round(deg / 45.0).toInt()) % 8]

    fun fmt(m: Double): String =
        if (m >= 1000) String.format("%.1f km", m / 1000.0) else "${Math.round(m)} m"
}
