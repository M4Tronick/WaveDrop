package app.wavedrop.android.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * New versions from the project's GitHub releases: the latest release is
 * compared with this app's versionName; its APK is downloaded, checked against
 * the release's SHA256SUMS.txt and handed to Android's package installer.
 * Releases are signed with the same key, so Android installs them over this one.
 */
class Updater(private val context: Context, private val http: OkHttpClient) {

    enum class Status { Idle, Checking, Latest, Available, Downloading, Ready, Error }

    data class State(
        val status: Status = Status.Idle,
        val current: String = "",
        val latest: String? = null,
        val notes: String = "",
        val pageUrl: String = RELEASES_PAGE,
        val progress: Float = 0f,
        val error: String? = null,
        val checkedAt: Long = 0,
    )

    private class Release(val version: String, val notes: String, val page: String, val apkName: String?, val apkUrl: String?, val sumsUrl: String?)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = context.getSharedPreferences("wavedrop.update", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(State(current = currentVersion(context)))
    val state: StateFlow<State> = _state.asStateFlow()
    private var release: Release? = null
    private var job: Job? = null

    var autoCheck: Boolean
        get() = prefs.getBoolean("auto", true)
        set(value) = prefs.edit().putBoolean("auto", value).apply()

    /** Called when the app comes to the foreground: checks at most every 6 hours. */
    fun checkIfDue() {
        if (!autoCheck || System.currentTimeMillis() - prefs.getLong("lastCheck", 0) < CHECK_EVERY_MS) return
        check()
    }

    fun check() {
        if (job?.isActive == true) return
        job = scope.launch {
            _state.update { it.copy(status = Status.Checking, error = null) }
            try {
                val r = fetchLatest()
                release = r
                prefs.edit().putLong("lastCheck", System.currentTimeMillis()).apply()
                val available = isNewer(r.version, _state.value.current)
                _state.update {
                    it.copy(
                        status = if (available) Status.Available else Status.Latest,
                        latest = r.version,
                        notes = r.notes,
                        pageUrl = r.page,
                        checkedAt = System.currentTimeMillis(),
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(status = Status.Error, error = friendly(e), checkedAt = System.currentTimeMillis()) }
            }
        }
    }

    fun download() {
        val r = release ?: return
        if (job?.isActive == true) return
        if (r.apkUrl == null || r.sumsUrl == null || r.apkName == null) {
            _state.update { it.copy(error = "Questa release non contiene l'APK: aprila su GitHub.") }
            return
        }
        job = scope.launch {
            _state.update { it.copy(status = Status.Downloading, progress = 0f, error = null) }
            try {
                val expected = parseSums(getText(r.sumsUrl))[r.apkName]
                    ?: throw IOException("SHA256SUMS.txt non elenca ${r.apkName}.")
                val file = apkFile(context)
                val hash = downloadTo(r.apkUrl, file)
                if (hash != expected) {
                    file.delete()
                    throw IOException("Il file scaricato non corrisponde all'impronta della release: aggiornamento annullato.")
                }
                _state.update { it.copy(status = Status.Ready, progress = 1f) }
                withContext(Dispatchers.Main) { install() }
            } catch (e: Exception) {
                _state.update { it.copy(status = Status.Available, error = friendly(e)) }
            }
        }
    }

    /** Opens Android's installer on the downloaded APK (asking first to allow installs from WaveDrop). */
    fun install() {
        val file = apkFile(context)
        if (!file.exists()) return
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            _state.update { it.copy(error = "Consenti a WaveDrop di installare app, poi torna qui e tocca Installa.") }
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    // ───────────── network ─────────────

    private fun request(url: String) = Request.Builder().url(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "WaveDrop-Android-updater")
        .build()

    private fun fetchLatest(): Release {
        http.newCall(request(LATEST_API)).execute().use { res ->
            if (!res.isSuccessful) throw IOException("GitHub ha risposto ${res.code}")
            val json = JSONObject(res.body.string())
            val assets = json.optJSONArray("assets")
            var apkName: String? = null
            var apkUrl: String? = null
            var sumsUrl: String? = null
            for (i in 0 until (assets?.length() ?: 0)) {
                val a = assets!!.getJSONObject(i)
                val name = a.optString("name")
                val url = a.optString("browser_download_url")
                if (APK_ASSET.matches(name)) {
                    apkName = name
                    apkUrl = url
                }
                if (name == "SHA256SUMS.txt") sumsUrl = url
            }
            return Release(
                version = json.optString("tag_name").removePrefix("v"),
                notes = json.optString("body").take(4000),
                page = json.optString("html_url", RELEASES_PAGE),
                apkName = apkName,
                apkUrl = apkUrl,
                sumsUrl = sumsUrl,
            )
        }
    }

    private fun getText(url: String): String =
        http.newCall(request(url)).execute().use { res ->
            if (!res.isSuccessful) throw IOException("Download non riuscito (${res.code}).")
            res.body.string()
        }

    private fun downloadTo(url: String, file: File): String {
        file.parentFile?.mkdirs()
        val digest = MessageDigest.getInstance("SHA-256")
        http.newCall(request(url)).execute().use { res ->
            if (!res.isSuccessful) throw IOException("Download non riuscito (${res.code}).")
            val total = res.body.contentLength().takeIf { it > 0 } ?: -1L
            var got = 0L
            var lastEmit = 0L
            res.body.byteStream().use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                        got += n
                        if (total > 0 && System.currentTimeMillis() - lastEmit > 200) {
                            lastEmit = System.currentTimeMillis()
                            _state.update { it.copy(progress = got.toFloat() / total) }
                        }
                    }
                }
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val REPO = "M4Tronick/WaveDrop"
        const val RELEASES_PAGE = "https://github.com/$REPO/releases"
        private const val LATEST_API = "https://api.github.com/repos/$REPO/releases/latest"
        private const val CHECK_EVERY_MS = 6 * 60 * 60_000L
        private val APK_ASSET = Regex("""WaveDrop-Android-.*\.apk""", RegexOption.IGNORE_CASE)

        fun currentVersion(context: Context): String =
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"

        fun apkFile(context: Context) = File(context.cacheDir, "updates/WaveDrop.apk")

        /** "1.2.3" > "1.2.0"; pre-release suffixes are ignored. */
        fun isNewer(a: String, b: String): Boolean {
            val pa = a.removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: 0 }
            val pb = b.removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until 3) {
                val x = pa.getOrElse(i) { 0 }
                val y = pb.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }

        /** "<sha256>  <name>" lines → name → hash */
        fun parseSums(text: String): Map<String, String> =
            text.lineSequence().mapNotNull { line ->
                Regex("""^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$""").find(line)?.let { it.groupValues[2] to it.groupValues[1].lowercase() }
            }.toMap()

        private fun friendly(e: Exception): String = when (e) {
            is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException -> "Nessuna connessione a GitHub."
            else -> e.message ?: "Errore sconosciuto."
        }
    }
}
