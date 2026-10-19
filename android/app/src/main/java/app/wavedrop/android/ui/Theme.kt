package app.wavedrop.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Accent = Color(0xFF0A84FF)
val Ok = Color(0xFF34C759)
val Bad = Color(0xFFFF3B30)

private val Light = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    background = Color(0xFFF2F2F7),
    onBackground = Color.Black,
    surface = Color.White,
    onSurface = Color.Black,
    surfaceVariant = Color(0xFFE5E5EA),
    onSurfaceVariant = Color(0x993C3C43),
    outline = Color(0x2E3C3C43),
    error = Bad,
)

private val Dark = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    background = Color.Black,
    onBackground = Color.White,
    surface = Color(0xFF1C1C1E),
    onSurface = Color.White,
    surfaceVariant = Color(0xFF2C2C2E),
    onSurfaceVariant = Color(0x99EBEBF5),
    outline = Color(0x99545458),
    error = Color(0xFFFF453A),
)

@Composable
fun WaveTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
