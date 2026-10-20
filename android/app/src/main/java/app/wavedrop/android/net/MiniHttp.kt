package app.wavedrop.android.net

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * A deliberately small HTTP/1.1 server for the phone-to-phone protocol: one
 * thread per connection, keep-alive, bodies with Content-Length only (what
 * OkHttp, URLSession and Node send). Nothing here knows the protocol; see
 * PeerServer for the routes.
 */
class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: ByteArray,
    val remoteAddress: String,
) {
    val json: JSONObject? get() = runCatching { JSONObject(String(body, Charsets.UTF_8)) }.getOrNull()
}

class HttpResponse(val status: Int, val body: ByteArray = ByteArray(0), val type: String = "application/json") {
    companion object {
        fun json(status: Int, body: JSONObject = JSONObject()) = HttpResponse(status, body.toString().toByteArray(Charsets.UTF_8))
    }
}

/** What a handler can ask about the connection while it waits (a held-open /Ask). */
fun interface ClientProbe {
    /** True once the client has closed the connection. Takes up to [waitMs]. */
    fun gone(waitMs: Int): Boolean
}

fun interface HttpHandler {
    /** Returns null to close the connection without answering. */
    fun handle(request: HttpRequest, probe: ClientProbe): HttpResponse?
}

class MiniHttpServer(
    private val handler: HttpHandler,
    private val maxBody: Int = 2 * 1024 * 1024 + 64 * 1024,
    private val maxConnections: Int = 32,
) {
    private var server: ServerSocket? = null
    private var pool: ExecutorService? = null
    private val open = AtomicInteger()

    val port: Int get() = server?.localPort ?: 0

    /** Listens on [preferredPort], or on any free port when that one is taken. */
    @Synchronized
    fun start(preferredPort: Int = 0): Int {
        server?.let { return it.localPort }
        val socket = ServerSocket()
        socket.reuseAddress = true
        try {
            socket.bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), preferredPort), 50)
        } catch (e: IOException) {
            if (preferredPort == 0) throw e
            socket.bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0), 50)
        }
        server = socket
        val threads = Executors.newCachedThreadPool { r -> Thread(r, "wavedrop-http").apply { isDaemon = true } }
        pool = threads
        threads.execute { acceptLoop(socket, threads) }
        return socket.localPort
    }

    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        server = null
        pool?.shutdownNow()
        pool = null
    }

    private fun acceptLoop(socket: ServerSocket, threads: ExecutorService) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                break
            }
            if (open.incrementAndGet() > maxConnections) {
                open.decrementAndGet()
                runCatching { client.close() }
                continue
            }
            try {
                threads.execute { serve(client) }
            } catch (e: Exception) {
                open.decrementAndGet()
                runCatching { client.close() }
            }
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.use {
                socket.soTimeout = IDLE_MS
                socket.tcpNoDelay = true
                val input = BufferedInputStream(socket.getInputStream(), 64 * 1024)
                val output = socket.getOutputStream()
                val remote = socket.inetAddress?.hostAddress ?: ""
                while (true) {
                    val head = readHead(input) ?: return
                    val request = parse(head, input, output, remote) ?: return
                    val probe = ClientProbe { waitMs -> probeGone(socket, input, waitMs) }
                    val response = runCatching { handler.handle(request, probe) }
                        .getOrElse { HttpResponse.json(500, JSONObject().put("error", it.message ?: "error")) }
                        ?: return
                    val close = request.headers["connection"].equals("close", ignoreCase = true)
                    write(output, response, close)
                    if (close) return
                }
            }
        } catch (e: IOException) {
            // Client went away or idled out.
        } finally {
            open.decrementAndGet()
        }
    }

    /** Reads up to the blank line ending the request head; null at a clean end of stream. */
    private fun readHead(input: InputStream): String? {
        val buf = StringBuilder()
        var matched = 0
        while (true) {
            val b = try {
                input.read()
            } catch (e: SocketTimeoutException) {
                return null
            }
            if (b < 0) return null
            buf.append(b.toChar())
            matched = when {
                (matched == 0 || matched == 2) && b == '\r'.code -> matched + 1
                (matched == 1 || matched == 3) && b == '\n'.code -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) return buf.toString()
            if (buf.length > MAX_HEAD) throw IOException("request head too large")
        }
    }

    private fun parse(head: String, input: InputStream, output: OutputStream, remote: String): HttpRequest? {
        val lines = head.split("\r\n")
        val parts = lines.first().split(' ')
        if (parts.size < 3) {
            write(output, HttpResponse.json(400), close = true)
            return null
        }
        val headers = mutableMapOf<String, String>()
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        if (headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true) {
            write(output, HttpResponse.json(411), close = true)
            return null
        }
        val length = headers["content-length"]?.toLongOrNull() ?: 0L
        if (length < 0 || length > maxBody) {
            write(output, HttpResponse.json(413), close = true)
            return null
        }
        if (headers["expect"].equals("100-continue", ignoreCase = true)) {
            output.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray(Charsets.US_ASCII))
            output.flush()
        }
        val body = ByteArray(length.toInt())
        var off = 0
        while (off < body.size) {
            val n = input.read(body, off, body.size - off)
            if (n < 0) throw IOException("body cut short")
            off += n
        }
        val target = parts[1]
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.associate {
            val k = it.substringBefore('=')
            val v = it.substringAfter('=', "")
            decode(k) to decode(v)
        }
        return HttpRequest(parts[0].uppercase(), decode(path), query, headers, body, remote)
    }

    private fun decode(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

    private fun write(output: OutputStream, r: HttpResponse, close: Boolean) {
        val head = buildString {
            append("HTTP/1.1 ${r.status} ${reason(r.status)}\r\n")
            append("Content-Type: ${r.type}\r\n")
            append("Content-Length: ${r.body.size}\r\n")
            append("Cache-Control: no-store\r\n")
            append(if (close) "Connection: close\r\n" else "Connection: keep-alive\r\n")
            append("\r\n")
        }
        output.write(head.toByteArray(Charsets.US_ASCII))
        output.write(r.body)
        output.flush()
    }

    // While a request is held open the client sends nothing more, so a read
    // that ends the stream means it hung up; a read that times out means it is
    // still there.
    private fun probeGone(socket: Socket, input: InputStream, waitMs: Int): Boolean {
        val saved = socket.soTimeout
        return try {
            socket.soTimeout = waitMs.coerceAtLeast(1)
            input.mark(1)
            val b = input.read()
            if (b >= 0) input.reset()
            b < 0
        } catch (e: SocketTimeoutException) {
            false
        } catch (e: SocketException) {
            true
        } catch (e: IOException) {
            true
        } finally {
            runCatching { socket.soTimeout = saved }
        }
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        202 -> "Accepted"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        409 -> "Conflict"
        410 -> "Gone"
        411 -> "Length Required"
        413 -> "Payload Too Large"
        429 -> "Too Many Requests"
        else -> if (status >= 500) "Server Error" else "Status"
    }

    private companion object {
        const val IDLE_MS = 60_000
        const val MAX_HEAD = 16 * 1024
    }
}
