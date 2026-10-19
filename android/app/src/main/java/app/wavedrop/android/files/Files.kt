package app.wavedrop.android.files

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Size
import android.webkit.MimeTypeMap
import app.wavedrop.android.crypto.Proto
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream

/** Something picked or shared on the phone, ready to send. */
data class Item(val uri: Uri, val name: String, val size: Long, val mime: String)

/** A file received from a PC, already in the phone's gallery or Downloads. */
data class SavedFile(val name: String, val uri: Uri, val mime: String, val size: Long)

object Files {
    fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    /** Name and size of a content URI; copies it to the cache when the size is unknown. */
    fun describe(context: Context, uri: Uri): Item {
        var name = uri.lastPathSegment ?: "file"
        var size = -1L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        val mime = context.contentResolver.getType(uri) ?: mimeOf(name)
        if (size >= 0) return Item(uri, name, size, mime)
        val copy = File(context.cacheDir, "share-${System.nanoTime()}-${safeName(name)}")
        context.contentResolver.openInputStream(uri)!!.use { input -> copy.outputStream().use { input.copyTo(it) } }
        return Item(Uri.fromFile(copy), name, copy.length(), mime)
    }

    /** Small JPEG preview (data URL) shown in the PC's notification. */
    fun thumbnail(context: Context, item: Item): String? = runCatching {
        if (!item.mime.startsWith("image/") && !item.mime.startsWith("video/")) return null
        val bmp = context.contentResolver.loadThumbnail(item.uri, Size(192, 192), null)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 75, out)
        "data:image/jpeg;base64," + Proto.b64(out.toByteArray())
    }.getOrNull()

    fun safeName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimEnd('.').ifEmpty { "file" }.take(150)

    // ───────────── saving received files ─────────────

    class Pending(val uri: Uri, val output: OutputStream, val name: String, val mime: String)

    /**
     * Creates an entry in MediaStore: photos in Pictures/WaveDrop, videos in
     * Movies/WaveDrop, everything else in Download/WaveDrop. Folder structure
     * from the PC is kept as sub-folders.
     */
    fun create(context: Context, relName: String): Pending {
        val parts = relName.split('/', '\\').map(::safeName).filter { it.isNotEmpty() }
        val name = parts.lastOrNull() ?: "file"
        val sub = parts.dropLast(1).joinToString("/")
        val mime = mimeOf(name)
        val (collection, base) = when {
            mime.startsWith("image/") -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to "Pictures/WaveDrop"
            mime.startsWith("video/") -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to "Movies/WaveDrop"
            else -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to "Download/WaveDrop"
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (sub.isEmpty()) base else "$base/$sub")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(collection, values) ?: error("Impossibile salvare $name")
        val output = resolver.openOutputStream(uri) ?: error("Impossibile scrivere $name")
        return Pending(uri, output, name, mime)
    }

    fun finish(context: Context, pending: Pending, size: Long): SavedFile {
        pending.output.close()
        context.contentResolver.update(pending.uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return SavedFile(pending.name, pending.uri, pending.mime, size)
    }

    fun discard(context: Context, pending: Pending) {
        runCatching { pending.output.close() }
        runCatching { context.contentResolver.delete(pending.uri, null, null) }
    }

}
