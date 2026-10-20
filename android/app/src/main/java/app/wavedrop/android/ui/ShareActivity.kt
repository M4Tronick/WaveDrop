package app.wavedrop.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.IntentCompat
import app.wavedrop.android.net.Hub
import app.wavedrop.android.net.Status
import app.wavedrop.android.wave
import kotlinx.coroutines.delay

/**
 * The AirDrop-style sheet that opens from Android's "Condividi" menu: pick a
 * paired PC or phone and the shared photos, files or link go straight to it. It stays
 * open until the transfer ends, because the read permission for shared files
 * lasts only as long as this activity.
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            else -> emptyList()
        }
        val text = if (uris.isEmpty()) intent.getStringExtra(Intent.EXTRA_TEXT) else null
        setContent {
            WaveTheme {
                ShareSheet(wave.hub, uris, text, onClose = ::finish, onOpenApp = {
                    startActivity(Intent(this, MainActivity::class.java))
                    finish()
                })
            }
        }
    }

    override fun onStart() {
        super.onStart()
        wave.hub.attach("share")
    }

    override fun onStop() {
        wave.hub.detach("share")
        super.onStop()
    }
}

@Composable
private fun ShareSheet(hub: Hub, uris: List<Uri>, text: String?, onClose: () -> Unit, onOpenApp: () -> Unit) {
    val state by hub.state.collectAsState()
    var transferId by rememberSaveable { mutableStateOf<String?>(null) }
    val transfer = transferId?.let { id -> state.transfers.find { it.id == id } }
    val summary = when {
        uris.size == 1 -> "1 elemento"
        uris.isNotEmpty() -> "${uris.size} elementi"
        !text.isNullOrBlank() -> "«${text.trim().take(60)}${if (text.trim().length > 60) "…" else ""}»"
        else -> "Niente da condividere"
    }

    LaunchedEffect(transfer?.status) {
        if (transfer?.status == Status.DONE) {
            delay(1200)
            onClose()
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.4f))
            .clickable(remember { MutableInteractionSource() }, null) { if (transfer?.status?.active != true) onClose() },
    ) {
        Surface(
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().clickable(remember { MutableInteractionSource() }, null) {},
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            color = MaterialTheme.colorScheme.background,
        ) {
            Column(Modifier.navigationBarsPadding().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.width(36.dp).height(5.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.outline))
                Text("Condividi con WaveDrop", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 14.dp))
                Text(summary, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(18.dp))

                when {
                    state.targets.isEmpty() -> {
                        Text("Nessun PC o telefono collegato. Apri WaveDrop e inquadra il codice QR del PC o dell'altro telefono.", textAlign = TextAlign.Center)
                        TextButton(onClick = onOpenApp) { Text("Apri WaveDrop") }
                    }
                    transfer == null -> LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                        items(state.targets, key = { it.id }) { target ->
                            Column(
                                Modifier
                                    .clip(RoundedCornerShape(14.dp))
                                    .clickable(enabled = target.online) {
                                        transferId = if (uris.isNotEmpty()) hub.sendFiles(target.id, uris)
                                        else text?.let { hub.sendText(target.id, it) }
                                    }
                                    .padding(8.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Avatar(target.name, 68.dp, online = target.online)
                                Text(target.name, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp).width(96.dp), textAlign = TextAlign.Center)
                                Text(
                                    if (target.online) "Tocca per inviare" else "Non raggiungibile",
                                    fontSize = 11.sp,
                                    color = if (target.online) Accent else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    else -> {
                        Avatar(transfer.peer, 68.dp)
                        val label = when (transfer.status) {
                            Status.PREPARING, Status.WAITING -> "In attesa che ${transfer.peer} accetti…"
                            Status.SENDING -> "Invio… ${(transfer.progress * 100).toInt()}%"
                            Status.DONE -> "Inviato ✓"
                            else -> transfer.note ?: "Non riuscito"
                        }
                        Text(label, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp),
                            color = when (transfer.status) { Status.DONE -> Ok; Status.FAILED, Status.DECLINED -> Bad; else -> MaterialTheme.colorScheme.onBackground })
                        if (transfer.status == Status.SENDING) {
                            LinearProgressIndicator(
                                progress = { transfer.progress },
                                modifier = Modifier.fillMaxWidth().padding(top = 10.dp).height(6.dp).clip(RoundedCornerShape(3.dp)),
                                color = Accent,
                                trackColor = MaterialTheme.colorScheme.surfaceVariant,
                                drawStopIndicator = {},
                            )
                        }
                        if (transfer.status.active) TextButton(onClick = { hub.cancel(transfer.id) }) { Text("Annulla") }
                        else TextButton(onClick = onClose) { Text("Chiudi") }
                    }
                }
                Spacer(Modifier.size(6.dp))
            }
        }
    }
}
