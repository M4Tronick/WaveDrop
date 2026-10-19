package app.wavedrop.android.net

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private val JSON = "application/json".toMediaType()
private val BYTES = "application/octet-stream".toMediaType()

class HttpResult(val code: Int, val bytes: ByteArray) {
    val json: JSONObject get() = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrDefault(JSONObject())
}

/** Runs a call without blocking a thread; cancelling the coroutine cancels the call. */
suspend fun OkHttpClient.await(request: Request): HttpResult = suspendCancellableCoroutine { cont ->
    val call = newCall(request)
    cont.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            val result = response.use { r -> runCatching { HttpResult(r.code, r.body.bytes()) } }
            if (!cont.isActive) return
            result.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
        }
    })
}

suspend fun OkHttpClient.postJson(url: String, body: JSONObject) =
    await(Request.Builder().url(url).post(body.toString().toRequestBody(JSON)).build())

suspend fun OkHttpClient.postBytes(url: String, body: ByteArray) =
    await(Request.Builder().url(url).post(body.toRequestBody(BYTES)).build())

suspend fun OkHttpClient.get(url: String) = await(Request.Builder().url(url).get().build())
