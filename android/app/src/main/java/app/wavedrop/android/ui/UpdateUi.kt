package app.wavedrop.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.wavedrop.android.update.Updater
import app.wavedrop.android.update.Updater.Status

/** On the home screen, only while a new version is on offer. */
@Composable
fun UpdateBanner(updater: Updater) {
    val s by updater.state.collectAsState()
    if (s.status !in setOf(Status.Available, Status.Downloading, Status.Ready)) return
    Card {
        Column(Modifier.padding(16.dp)) {
            Text("È disponibile WaveDrop ${s.latest}", fontWeight = FontWeight.SemiBold)
            Text("Hai la ${s.current}.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            UpdateAction(updater, s, Modifier.padding(top = 10.dp))
        }
    }
}

/** The "Aggiornamenti" card in the settings. */
@Composable
fun UpdateSettings(updater: Updater) {
    val s by updater.state.collectAsState()
    val context = LocalContext.current
    var auto by remember { mutableStateOf(updater.autoCheck) }
    Card {
        Column {
            Column(Modifier.padding(16.dp)) {
                val title = when (s.status) {
                    Status.Idle -> "Versione ${s.current}"
                    Status.Checking -> "Controllo in corso…"
                    Status.Latest -> "WaveDrop ${s.current} è la versione più recente"
                    Status.Available -> "È disponibile WaveDrop ${s.latest}"
                    Status.Downloading -> "Download di WaveDrop ${s.latest}…"
                    Status.Ready -> "WaveDrop ${s.latest} è pronto da installare"
                    Status.Error -> "Controllo non riuscito"
                }
                Text(title, fontWeight = FontWeight.Medium)
                s.error?.let { Text(it, fontSize = 12.sp, color = Bad) }
                if (s.status in setOf(Status.Available, Status.Downloading, Status.Ready)) {
                    UpdateAction(updater, s, Modifier.padding(top = 10.dp))
                    if (s.notes.isNotBlank()) {
                        TextButton(onClick = {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.pageUrl))) }
                        }) { Text("Novità della versione") }
                    }
                } else {
                    TextButton(onClick = { updater.check() }, enabled = s.status != Status.Checking) { Text("Controlla ora") }
                }
            }
            HorizontalDivider(Modifier.padding(start = 16.dp))
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Controlla automaticamente")
                    Text(
                        "Quando apri l'app, al massimo ogni 6 ore, sulle release del progetto su GitHub.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(auto, {
                    auto = it
                    updater.autoCheck = it
                }, colors = SwitchDefaults.colors(checkedTrackColor = Ok))
            }
        }
    }
}

@Composable
private fun UpdateAction(updater: Updater, s: Updater.State, modifier: Modifier) {
    when (s.status) {
        Status.Downloading -> LinearProgressIndicator(progress = { s.progress }, modifier = modifier.fillMaxWidth())
        Status.Ready -> Button(onClick = { updater.install() }, modifier = modifier, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
            Text("Installa")
        }
        else -> Button(onClick = { updater.download() }, modifier = modifier, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
            Text("Scarica e installa")
        }
    }
    if (s.status != Status.Downloading) s.error?.let { Text(it, fontSize = 12.sp, color = Bad, modifier = Modifier.padding(top = 6.dp)) }
}
