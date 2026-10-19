package app.wavedrop.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

const val AUTHOR = "Matteo Davanzo"

/** The project's GitHub page; null until the repository exists. */
val REPO_URL: String? = null

private class Credit(val name: String, val by: String, val what: String, val url: String)

private val CREDITS = listOf(
    Credit("OpenDrop", "SEEMOO, TU Darmstadt", "Studio del protocollo AirDrop", "https://github.com/seemoo-lab/opendrop"),
    Credit("OWL", "SEEMOO, TU Darmstadt", "AWDL aperto, la radio Wi-Fi di AirDrop", "https://github.com/seemoo-lab/owl"),
    Credit("omdrop-owl", "t4t5", "Ponte AirDrop su Linux", "https://github.com/t4t5/omdrop-owl"),
    Credit("omdrop-plugin", "netmojo-systems", "Ponte AirDrop su Linux", "https://github.com/netmojo-systems/omdrop-plugin"),
    Credit("xtool", "xtool-org", "App iPhone compilata senza Mac", "https://github.com/xtool-org/xtool"),
    Credit("OkHttp", "Square", "Rete", "https://github.com/square/okhttp"),
    Credit("Bouncy Castle", "Legion of the Bouncy Castle", "Crittografia", "https://www.bouncycastle.org/"),
    Credit("ZXing Android Embedded", "JourneyApps", "Lettura dei codici QR", "https://github.com/journeyapps/zxing-android-embedded"),
    Credit("Jetpack Compose", "Google", "Interfaccia", "https://developer.android.com/compose"),
)

/** The "Informazioni" part of the settings list: author, licence and thanks. */
fun LazyListScope.aboutItems() {
    item { SectionTitle("Informazioni") }
    item { AboutCard() }
    item { SectionTitle("Ringraziamenti") }
    item {
        Card {
            Column {
                CREDITS.forEachIndexed { i, credit ->
                    if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                    LinkRow(credit.url) {
                        Text("${credit.name} · ${credit.by}", fontWeight = FontWeight.Medium)
                        Text(credit.what, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    item {
        Text(
            "AirDrop e iPhone sono marchi di Apple Inc.; WaveDrop è un progetto indipendente, non affiliato ad Apple.",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 14.dp),
        )
    }
}

@Composable
private fun AboutCard() {
    val context = LocalContext.current
    val version = remember(context) { context.packageManager.getPackageInfo(context.packageName, 0).versionName }
    Card {
        Column(Modifier.padding(vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("WaveDrop", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Versione $version", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "Creato da $AUTHOR\nLicenza MIT · © 2026 $AUTHOR",
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 10.dp),
            )
            REPO_URL?.let { url ->
                Text(
                    "Codice sorgente su GitHub",
                    color = Accent,
                    modifier = Modifier.padding(top = 10.dp).clickable { open(context, url) },
                )
            }
        }
    }
}

@Composable
private fun LinkRow(url: String, content: @Composable () -> Unit) {
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clickable { open(context, url) }.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) { content() }
        Text("↗", color = Accent)
    }
}

private fun open(context: android.content.Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
