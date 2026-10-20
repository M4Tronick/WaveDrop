package app.wavedrop.android.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.wavedrop.android.R
import app.wavedrop.android.net.NearbyPhone
import app.wavedrop.android.net.PairRequest
import app.wavedrop.android.net.ShownQr
import app.wavedrop.android.net.Target
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import kotlinx.coroutines.delay

/** A PC or a paired phone in the row of places to send to. */
@Composable
fun TargetTile(target: Target, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.width(96.dp).clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Avatar(target.name, 72.dp, online = target.online, selected = selected)
        Text(target.name, fontWeight = FontWeight.Medium, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(
            when {
                !target.online -> "Non raggiungibile"
                target.isPhone -> platformLabel(target.platform)
                else -> "Connesso"
            },
            fontSize = 11.sp,
            color = if (target.online) Ok else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

fun platformLabel(platform: String) = when (platform) {
    "ios" -> "iPhone"
    "android" -> "Android"
    else -> "Telefono"
}

/** Phones heard on the network that are not paired yet, plus the way to pair. */
@Composable
fun NearbyPhones(nearby: List<NearbyPhone>, onPair: (NearbyPhone) -> Unit, onShowQr: () -> Unit, onScan: () -> Unit) {
    Card {
        Column(Modifier.padding(14.dp)) {
            if (nearby.isEmpty()) {
                Text(
                    "Nessun altro telefono con WaveDrop su questa rete Wi-Fi. Aprilo sull'altro telefono, oppure abbinatevi con il codice QR.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            for (phone in nearby) {
                Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(phone.name, 40.dp)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(phone.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${platformLabel(phone.platform)} · non abbinato", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    SmallButton("Abbina") { onPair(phone) }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SmallButton("Mostra il mio QR", onShowQr)
                SmallButton("Inquadra un QR", onScan)
            }
        }
    }
}

/** Another phone asked this one to show its QR. */
@Composable
fun PairRequestCard(request: PairRequest, onShowQr: () -> Unit, onIgnore: () -> Unit) {
    Card {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(request.name, 44.dp)
                Spacer(Modifier.width(12.dp))
                Text("${request.name} (${platformLabel(request.platform)}) vuole abbinarsi con questo telefono.", fontSize = 15.sp, modifier = Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TextButton(onClick = onIgnore, modifier = Modifier.weight(1f)) { Text("Ignora") }
                TextButton(onClick = onShowQr, modifier = Modifier.weight(1f)) { Text("Mostra il codice QR", fontWeight = FontWeight.SemiBold, color = Accent) }
            }
        }
    }
}

/** This phone's pairing QR, for another phone to scan. */
@Composable
fun QrDialog(qr: ShownQr, onClose: () -> Unit) {
    val bitmap: Bitmap? = remember(qr.text) {
        runCatching { BarcodeEncoder().encodeBitmap(qr.text, BarcodeFormat.QR_CODE, 640, 640) }.getOrNull()
    }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(qr) {
        while (true) {
            now = System.currentTimeMillis()
            if (qr.pairedWith != null) {
                delay(1500)
                onClose()
                return@LaunchedEffect
            }
            delay(1000)
        }
    }
    val left = ((qr.expires - now) / 1000).coerceAtLeast(0)
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (qr.pairedWith != null) "Abbinato con ${qr.pairedWith} ✓" else "Il mio codice QR") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Box(
                    Modifier.size(240.dp).clip(RoundedCornerShape(16.dp)).background(Color.White).padding(10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (qr.pairedWith != null) {
                        Icon(painterResource(R.drawable.ic_check), null, tint = Ok, modifier = Modifier.size(96.dp))
                    } else if (bitmap != null) {
                        Image(bitmap.asImageBitmap(), "Codice QR", filterQuality = FilterQuality.None, modifier = Modifier.size(220.dp))
                    }
                }
                Text(
                    "Sull'altro telefono apri WaveDrop e tocca «Inquadra un QR». I due telefoni si scambiano le chiavi di cifratura e da quel momento si riconoscono.",
                    textAlign = TextAlign.Center,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 14.dp),
                )
                if (qr.pairedWith == null) {
                    Text(
                        if (left > 0) "Valido ancora ${left / 60}:${(left % 60).toString().padStart(2, '0')}, una sola volta" else "Scaduto: chiudi e mostrane uno nuovo",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
                Spacer(Modifier.height(4.dp))
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Chiudi") } },
    )
}
