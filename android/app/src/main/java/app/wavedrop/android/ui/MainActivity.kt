package app.wavedrop.android.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.wavedrop.android.R
import app.wavedrop.android.crypto.Proto
import app.wavedrop.android.net.Hub
import app.wavedrop.android.net.PcState
import app.wavedrop.android.net.PhoneState
import app.wavedrop.android.net.UiState
import app.wavedrop.android.net.Target
import app.wavedrop.android.service.ReachableService
import app.wavedrop.android.wave
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** A pairing link handed to the app (wavedrop://pair?u=… or an extra), consumed by the UI. */
    private val incomingLink = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        takeLink(intent)
        setContent {
            WaveTheme {
                WaveDropScreen(wave.hub, incomingLink)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    private fun takeLink(intent: Intent?) {
        val link = intent?.getStringExtra(EXTRA_PAIR_URL) ?: intent?.dataString?.takeIf { it.startsWith("wavedrop://") }
        if (link != null) incomingLink.value = link
    }

    override fun onStart() {
        super.onStart()
        wave.hub.attach("activity")
        ReachableService.sync(this)
        wave.updater.checkIfDue()
    }

    override fun onStop() {
        wave.hub.detach("activity")
        super.onStop()
    }

    companion object {
        const val EXTRA_PAIR_URL = "pair_url"
    }
}

@Composable
private fun WaveDropScreen(hub: Hub, incomingLink: MutableStateFlow<String?>) {
    val context = LocalContext.current
    val state by hub.state.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var settings by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var textDialog by remember { mutableStateOf(false) }
    var pasteDialog by remember { mutableStateOf(false) }
    var pairing by remember { mutableStateOf(false) }

    val targets = state.targets
    val target: Target? = targets.find { it.id == selected } ?: targets.firstOrNull { it.online } ?: targets.firstOrNull()

    fun pair(text: String) {
        pairing = true
        scope.launch {
            val message = runCatching { hub.pair(text) }.fold({ "Collegato a $it ✓" }, { it.message ?: "Collegamento non riuscito" })
            pairing = false
            snackbar.showSnackbar(message)
        }
    }

    LaunchedEffect(Unit) { hub.notices.collect { snackbar.showSnackbar(it) } }

    val link by incomingLink.collectAsState()
    LaunchedEffect(link) {
        link?.let {
            incomingLink.value = null
            pair(it)
        }
    }

    // Ask once for notifications, so incoming files can be announced.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && !hub.store.askedNotifications) {
            hub.store.askedNotifications = true
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    val scan = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(::pair) }
    fun scanQr(prompt: String = "Inquadra il codice QR di WaveDrop, sul PC o sull'altro telefono") {
        scan.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(prompt)
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }
    val startScan = { scanQr() }
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) target?.let { hub.sendFiles(it.id, uris) }
    }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) target?.let { hub.sendFiles(it.id, uris) }
    }

    fun closeSettings() {
        settings = false
        hub.announce() // the name may have changed
    }
    BackHandler(enabled = settings) { closeSettings() }

    Box(Modifier.fillMaxSize()) {
        if (settings) {
            SettingsScreen(hub, state, onBack = ::closeSettings, onAddPc = startScan)
        } else {
            LazyColumn(
                Modifier.fillMaxSize().safeDrawingPadding(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 40.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("WaveDrop", fontSize = 32.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        IconButton(onClick = { settings = true }) {
                            Icon(painterResource(R.drawable.ic_settings), "Impostazioni", tint = Accent)
                        }
                    }
                }
                item { UpdateBanner(context.wave.updater) }
                items(state.requests, key = { "request:" + it.id }) { request ->
                    PairRequestCard(request, onShowQr = {
                        hub.dismissRequest(request.id)
                        hub.showQr()
                    }, onIgnore = { hub.dismissRequest(request.id) })
                }
                if (targets.isEmpty()) {
                    item { Onboarding(pairing, onScan = startScan, onShowQr = { hub.showQr() }, onPaste = { pasteDialog = true }) }
                } else {
                    item {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            items(targets, key = { it.id }) { t ->
                                TargetTile(t, selected = t.id == target?.id) { selected = t.id }
                            }
                        }
                    }
                    item {
                        val online = target?.online == true
                        Column {
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                ActionTile(R.drawable.ic_photo, "Foto e video", online, Modifier.weight(1f)) {
                                    pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                                }
                                ActionTile(R.drawable.ic_file, "File", online, Modifier.weight(1f)) { pickFiles.launch(arrayOf("*/*")) }
                                ActionTile(R.drawable.ic_text, "Testo o link", online, Modifier.weight(1f)) { textDialog = true }
                            }
                            if (!online && target != null) {
                                Text(
                                    if (target.isPhone) "${target.name} non è raggiungibile: apri WaveDrop sull'altro telefono, sulla stessa rete Wi-Fi."
                                    else "${target.name} non è raggiungibile: apri WaveDrop sul PC e collegati alla stessa rete Wi-Fi.",
                                    fontSize = 13.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 10.dp, start = 4.dp),
                                )
                            }
                        }
                    }
                }
                item { SectionTitle("Telefoni vicini") }
                item {
                    NearbyPhones(
                        state.nearby,
                        onPair = { phone ->
                            hub.requestPair(phone)
                            scanQr("Inquadra il codice QR comparso su ${phone.name}")
                        },
                        onShowQr = { hub.showQr() },
                        onScan = startScan,
                    )
                }
                if (state.transfers.isNotEmpty()) item { SectionTitle("Trasferimenti") }
                items(state.transfers, key = { it.id }) { t ->
                    TransferCard(
                        t,
                        onAccept = { hub.accept(t.id) },
                        onDecline = { hub.decline(t.id) },
                        onCancel = { hub.cancel(t.id) },
                        onDismiss = { hub.dismiss(t.id) },
                    )
                }
                if (state.pcs.isNotEmpty()) {
                    item {
                        TextButton(onClick = startScan, modifier = Modifier.fillMaxWidth()) { Text("Collega un altro PC o telefono") }
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).safeDrawingPadding())
    }

    if (textDialog && target != null) {
        TextInputDialog(
            title = "Invia a ${target.name}",
            hint = "Scrivi un testo o incolla un link",
            confirm = "Invia",
            onDismiss = { textDialog = false },
            onConfirm = {
                textDialog = false
                hub.sendText(target.id, it)
            },
        )
    }
    state.qr?.let { qr -> QrDialog(qr, onClose = { hub.hideQr() }) }
    if (pasteDialog) {
        TextInputDialog(
            title = "Incolla il link del PC",
            hint = "http://192.168.…/m/#k=…",
            confirm = "Collega",
            onDismiss = { pasteDialog = false },
            onConfirm = {
                pasteDialog = false
                pair(it)
            },
        )
    }
}

@Composable
private fun Onboarding(busy: Boolean, onScan: () -> Unit, onShowQr: () -> Unit, onPaste: () -> Unit) {
    Card {
        Column(Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(painterResource(R.drawable.ic_pc), null, tint = Accent, modifier = Modifier.size(54.dp))
            Text("Collega un PC o un telefono", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 10.dp))
            Text(
                "Sul PC apri WaveDrop e scegli «Collega telefono», poi inquadra il codice QR. Con un altro telefono: su uno tocca «Mostra il mio codice QR», sull'altro inquadralo. I dispositivi si scambiano le chiavi di cifratura.",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp, bottom = 18.dp),
            )
            Button(
                onClick = onScan,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) {
                Icon(painterResource(R.drawable.ic_qr), null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (busy) "Collegamento…" else "Scansiona il codice QR", fontWeight = FontWeight.SemiBold)
            }
            TextButton(onClick = onShowQr, enabled = !busy) { Text("Mostra il mio codice QR") }
            TextButton(onClick = onPaste, enabled = !busy) { Text("Oppure incolla il link del PC") }
        }
    }
}

@Composable
fun TextInputDialog(title: String, hint: String, confirm: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(value, { value = it }, placeholder = { Text(hint) }, minLines = 3, modifier = Modifier.fillMaxWidth())
        },
        confirmButton = { TextButton(onClick = { if (value.isNotBlank()) onConfirm(value) }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annulla") } },
    )
}


@Composable
private fun SettingsScreen(hub: Hub, state: UiState, onBack: () -> Unit, onAddPc: () -> Unit) {
    val context = LocalContext.current
    val store = hub.store
    var name by remember { mutableStateOf(store.name) }
    var reachable by remember { mutableStateOf(store.stayReachable) }
    var visible by remember { mutableStateOf(hub.visibleToPhones) }
    var removing by remember { mutableStateOf<PcState?>(null) }
    var removingPhone by remember { mutableStateOf<PhoneState?>(null) }

    LazyColumn(Modifier.fillMaxSize().safeDrawingPadding(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 40.dp)) {
        item {
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_back), "Indietro", tint = Accent) }
                Text("Impostazioni", fontSize = 28.sp, fontWeight = FontWeight.Bold)
            }
        }
        item { SectionTitle("Questo telefono") }
        item {
            Card {
                Column(Modifier.padding(16.dp)) {
                    OutlinedTextField(
                        name,
                        { name = it; store.name = it },
                        label = { Text("Nome visto dagli altri dispositivi") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(Modifier.padding(top = 14.dp)) {
                        Text("Codice di sicurezza", Modifier.weight(1f))
                        Text(Proto.safetyCode(store.identity.pk), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        item { SectionTitle("Altri telefoni") }
        item {
            Card {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Visibile agli altri telefoni")
                        Text(
                            "I telefoni con WaveDrop sulla stessa rete Wi-Fi ti vedono e quelli abbinati possono inviarti file. Se lo spegni non ti vede nessuno; i PC collegati funzionano comunque.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        visible,
                        {
                            visible = it
                            hub.visibleToPhones = it
                        },
                        colors = SwitchDefaults.colors(checkedTrackColor = Ok),
                    )
                }
            }
        }
        items(state.phones, key = { "phone:" + it.phone.id }) { phoneState ->
            Card(Modifier.padding(top = 10.dp)) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(phoneState.phone.name, 44.dp, online = phoneState.online)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(phoneState.phone.name, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${platformLabel(phoneState.phone.platform)} · codice ${Proto.safetyCode(phoneState.phone.pkBytes)}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = { removingPhone = phoneState }) { Text("Rimuovi", color = Bad) }
                }
            }
        }
        item {
            TextButton(onClick = { hub.showQr() }, modifier = Modifier.fillMaxWidth()) { Text("Mostra il mio codice QR") }
        }
        item { SectionTitle("In background") }
        item {
            Card {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Resta raggiungibile con l'app chiusa")
                        Text(
                            "Mostra una notifica fissa e tiene il collegamento con i PC e gli altri telefoni, così puoi ricevere file in qualsiasi momento.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        reachable,
                        {
                            reachable = it
                            store.stayReachable = it
                            ReachableService.sync(context)
                        },
                        colors = SwitchDefaults.colors(checkedTrackColor = Ok),
                    )
                }
            }
        }
        item { SectionTitle("PC collegati") }
        items(state.pcs, key = { it.pc.id }) { pcState ->
            Card(Modifier.padding(bottom = 10.dp)) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(pcState.pc.name, 44.dp, online = pcState.online)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(pcState.pc.name, fontWeight = FontWeight.SemiBold)
                        Text("Codice ${Proto.safetyCode(pcState.pc.pkBytes)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(pcState.pc.url.removePrefix("http://"), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { removing = pcState }) { Text("Rimuovi", color = Bad) }
                }
            }
        }
        item {
            TextButton(onClick = onAddPc, modifier = Modifier.fillMaxWidth()) { Text("Collega un altro PC") }
        }
        item {
            Text(
                "I file viaggiano cifrati end-to-end (X25519 + ChaCha20-Poly1305): solo questo telefono e l'altro dispositivo possono leggerli. " +
                    "I codici di sicurezza devono coincidere con quelli mostrati sul PC o sull'altro telefono. " +
                    "La chiave privata è protetta dall'Android Keystore.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 14.dp),
            )
        }
        item { SectionTitle("Aggiornamenti") }
        item { UpdateSettings(context.wave.updater) }
        aboutItems()
    }

    removing?.let { pcState ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Scollegare ${pcState.pc.name}?") },
            text = { Text("Per ricollegarlo servirà un nuovo codice QR.") },
            confirmButton = {
                TextButton(onClick = {
                    hub.removePc(pcState.pc.id)
                    removing = null
                }) { Text("Scollega", color = Bad) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Annulla") } },
        )
    }
    removingPhone?.let { phoneState ->
        AlertDialog(
            onDismissRequest = { removingPhone = null },
            title = { Text("Dimenticare ${phoneState.phone.name}?") },
            text = { Text("Per scambiare di nuovo file dovrete riabbinarvi con il codice QR.") },
            confirmButton = {
                TextButton(onClick = {
                    hub.removePhone(phoneState.phone.id)
                    removingPhone = null
                }) { Text("Dimentica", color = Bad) }
            },
            dismissButton = { TextButton(onClick = { removingPhone = null }) { Text("Annulla") } },
        )
    }
}
