package app.wavedrop.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {
    @Test
    fun versionsCompareNumerically() {
        assertTrue(Updater.isNewer("1.0.10", "1.0.9"))
        assertTrue(Updater.isNewer("v2.0.0", "1.9.9"))
        assertFalse(Updater.isNewer("1.0.1", "1.0.1"))
        assertFalse(Updater.isNewer("1.0.0", "1.0.1"))
    }

    @Test
    fun sumsParseWithOrWithoutBinaryMarker() {
        val h = "A".repeat(64)
        val sums = Updater.parseSums("$h  WaveDrop-Android-1.2.0.apk\r\n$h *other.exe\nnoise")
        assertEquals(h.lowercase(), sums["WaveDrop-Android-1.2.0.apk"])
        assertEquals(h.lowercase(), sums["other.exe"])
        assertEquals(2, sums.size)
    }
}
