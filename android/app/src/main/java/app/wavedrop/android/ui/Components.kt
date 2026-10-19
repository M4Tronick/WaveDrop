package app.wavedrop.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.text.format.Formatter
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.wavedrop.android.R
import app.wavedrop.android.crypto.Proto
import app.wavedrop.android.files.SavedFile
import app.wavedrop.android.net.Dir
import app.wavedrop.android.net.Status
import app.wavedrop.android.net.Transfer

fun initials(name: String): String {
    val words = name.split(Regex("\\s+")).mapNotNull { w -> w.firstOrNull { it.isLetter() } }
    val picked = if (words.size > 1) listOf(words.first(), words.last()) else words
    return picked.joinToString("").uppercase().ifEmpty { "?" }
}

fun bytes(context: Context, n: Long): String = Formatter.formatShortFileSize(context, n)

@Composable
fun Avatar(name: String, size: Dp, online: Boolean? = null, selected: Boolean = false) {
    Box(Modifier.size(size)) {
        Box(
            Modifier
                .fillMaxSize()
                .then(if (selected) Modifier.border(3.dp, Accent, CircleShape).padding(5.dp) else Modifier)
                .clip(CircleShape)
                .background(Brush.verticalGradient(listOf(Color(0xFFA9AEBB), Color(0xFF868B98)))),
            contentAlignment = Alignment.Center,
        ) {
            Text(initials(name), color = Color.White, fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Medium)
        }
        if (online != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(size * 0.28f)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.background)
                    .padding(3.dp)
                    .clip(CircleShape)
                    .background(if (online) Ok else Color(0xFF8E8E93)),
            )
        }
    }
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface, content = content)
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 22.dp, bottom = 7.dp),
    )
}

@Composable
fun ActionTile(icon: Int, label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier.clip(RoundedCornerShape(16.dp)).clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.padding(14.dp)) {
            Box(
                Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(if (enabled) Accent else Color(0xFF8E8E93)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(icon), null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.height(16.dp))
            Text(
                label,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Thumbnail(dataUrl: String?, icon: Int) {
    val bitmap = remember(dataUrl) {
        dataUrl?.substringAfter("base64,", "")?.takeIf { it.isNotEmpty() }?.let {
            runCatching { Proto.unb64(it) }.getOrNull()?.let { b -> BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }
        }
    }
    Box(
        Modifier.size(48.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) Image(bitmap, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
    }
}

private fun headline(t: Transfer): AnnotatedString = buildAnnotatedString {
    fun bold(s: String) = withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(s) }
    when {
        t.dir == Dir.OUT && t.status == Status.DONE -> { append("Inviato ${t.what} a "); bold(t.peer) }
        t.dir == Dir.OUT -> { append("Invio di ${t.what} a "); bold(t.peer) }
        t.status == Status.OFFER -> { bold(t.peer); append(" vuole inviarti ${t.what}.") }
        t.status == Status.DONE -> { append("Ricevuto ${t.what} da "); bold(t.peer) }
        else -> { append("Ricezione di ${t.what} da "); bold(t.peer) }
    }
}

@Composable
fun TransferCard(t: Transfer, onAccept: () -> Unit, onDecline: () -> Unit, onCancel: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    Card {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Thumbnail(t.thumbnail, if (t.what == "un testo") R.drawable.ic_text else R.drawable.ic_file)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(headline(t), fontSize = 15.sp, lineHeight = 20.sp)
                    val (line, color) = statusLine(context, t)
                    Text(line, fontSize = 13.sp, color = color, modifier = Modifier.padding(top = 2.dp))
                }
                if (!t.status.active) {
                    IconButton(onClick = onDismiss) {
                        Icon(painterResource(R.drawable.ic_close), "Chiudi", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    }
                }
            }
            if (t.status == Status.SENDING || t.status == Status.RECEIVING) {
                LinearProgressIndicator(
                    progress = { t.progress },
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp).height(6.dp).clip(RoundedCornerShape(3.dp)),
                    color = Accent,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                    drawStopIndicator = {},
                )
            }
            if (t.text != null && (t.status == Status.DONE || t.status == Status.OFFER) && t.dir == Dir.IN) TextBox(t.text, t.status == Status.DONE)
            for (f in t.saved) SavedRow(f)
            when (t.status) {
                Status.OFFER -> Buttons(listOf("Rifiuta" to onDecline, "Accetta" to onAccept), primaryIndex = 1)
                Status.WAITING, Status.SENDING, Status.RECEIVING, Status.PREPARING -> Buttons(listOf("Annulla" to onCancel))
                else -> {}
            }
        }
    }
}

private fun statusLine(context: Context, t: Transfer): Pair<String, Color> = when (t.status) {
    Status.SENDING, Status.RECEIVING ->
        "${(t.progress * 100).toInt()}% · ${bytes(context, (t.progress * t.size).toLong())} di ${bytes(context, t.size)}" to Color.Gray
    Status.DONE -> (t.note ?: if (t.size > 0) bytes(context, t.size) else "Fatto") to Ok
    Status.FAILED, Status.DECLINED -> (t.note ?: "Non riuscito") to Bad
    Status.CANCELLED -> (t.note ?: "Annullato") to Color.Gray
    Status.OFFER -> (if (t.size > 0) bytes(context, t.size) else "Testo") to Color.Gray
    else -> (t.note ?: "") to Color.Gray
}

@Composable
private fun Buttons(items: List<Pair<String, () -> Unit>>, primaryIndex: Int = -1) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items.forEachIndexed { i, (label, action) ->
            val primary = i == primaryIndex
            Button(
                onClick = action,
                modifier = Modifier.weight(1f).height(44.dp),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (primary) Accent else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (primary) Color.White else MaterialTheme.colorScheme.onSurface,
                ),
            ) { Text(label, fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Composable
private fun TextBox(text: String, actions: Boolean) {
    val context = LocalContext.current
    Surface(Modifier.fillMaxWidth().padding(top = 10.dp), shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Text(text.take(2000), Modifier.padding(10.dp), fontSize = 15.sp)
    }
    if (!actions) return
    val url = text.trim().takeIf { Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(it) }
    val items = buildList<Pair<String, () -> Unit>> {
        add("Copia" to {
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("WaveDrop", text))
        })
        if (url != null) add("Apri link" to { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) })
    }
    Buttons(items, primaryIndex = if (url != null) 1 else -1)
}

@Composable
private fun SavedRow(f: SavedFile) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(f.name, fontSize = 14.sp, maxLines = 2)
            Text(bytes(context, f.size), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        SmallButton("Apri") {
            context.startActivity(
                Intent(Intent.ACTION_VIEW).setDataAndType(f.uri, f.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        }
        Spacer(Modifier.width(8.dp))
        SmallButton("Condividi") {
            context.startActivity(
                Intent.createChooser(
                    Intent(Intent.ACTION_SEND).setType(f.mime).putExtra(Intent.EXTRA_STREAM, f.uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                    f.name,
                ),
            )
        }
    }
}

@Composable
fun SmallButton(label: String, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.clip(RoundedCornerShape(9.dp)).clickable(onClick = onClick),
        shape = RoundedCornerShape(9.dp),
        color = Accent.copy(alpha = 0.14f),
    ) {
        Text(label, color = Accent, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp))
    }
}
