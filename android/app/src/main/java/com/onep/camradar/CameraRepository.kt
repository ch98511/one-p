package com.onep.camradar

import android.content.Context
import org.json.JSONObject

/** One camera resolved relative to the current position. */
data class Cam(
    val lat: Double,
    val lon: Double,
    val flock: Boolean,
    val dist: Double,
    val bearing: Double,
)

/**
 * Holds the bundled offline camera dataset (assets/cameras.json) in compact
 * primitive arrays and answers "what's near me?" with a bounding-box prefilter
 * followed by an exact haversine check. Loaded once, lazily, off the main thread.
 */
class CameraRepository private constructor(
    private val lats: DoubleArray,
    private val lons: DoubleArray,
    private val flock: BooleanArray,
    val generated: String,
) {
    val size: Int get() = lats.size

    fun nearby(lat: Double, lon: Double, radiusM: Double, flockOnly: Boolean): List<Cam> {
        val dLat = radiusM / 111_320.0
        val cosLat = cosDeg(lat).coerceAtLeast(1e-6)
        val dLon = radiusM / (111_320.0 * cosLat)
        val minLa = lat - dLat; val maxLa = lat + dLat
        val minLo = lon - dLon; val maxLo = lon + dLon
        val out = ArrayList<Cam>()
        for (i in lats.indices) {
            if (flockOnly && !flock[i]) continue
            val la = lats[i]; val lo = lons[i]
            if (la < minLa || la > maxLa || lo < minLo || lo > maxLo) continue
            val d = Geo.distance(lat, lon, la, lo)
            if (d <= radiusM) out.add(Cam(la, lo, flock[i], d, Geo.bearing(lat, lon, la, lo)))
        }
        out.sortBy { it.dist }
        return out
    }

    private fun cosDeg(d: Double) = Math.cos(Math.toRadians(d))

    companion object {
        @Volatile private var INSTANCE: CameraRepository? = null

        fun get(ctx: Context): CameraRepository =
            INSTANCE ?: synchronized(this) { INSTANCE ?: load(ctx.applicationContext).also { INSTANCE = it } }

        private fun load(ctx: Context): CameraRepository {
            return try {
                val text = ctx.assets.open("cameras.json").bufferedReader().use { it.readText() }
                val obj = JSONObject(text)
                val arr = obj.getJSONArray("cameras")
                val n = arr.length()
                val lats = DoubleArray(n); val lons = DoubleArray(n); val fl = BooleanArray(n)
                for (i in 0 until n) {
                    val c = arr.getJSONArray(i)
                    lats[i] = c.getDouble(0)
                    lons[i] = c.getDouble(1)
                    fl[i] = c.optInt(2, 0) == 1
                }
                CameraRepository(lats, lons, fl, obj.optString("generated", "?"))
            } catch (e: Exception) {
                CameraRepository(DoubleArray(0), DoubleArray(0), BooleanArray(0), "?")
            }
        }
    }
}
