package app.wavedrop.android.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.ArrayDeque

/** A phone heard over Bonjour, with the address its server listens on. */
data class NearbyPhone(val id: String, val name: String, val platform: String, val url: String, val seenAt: Long)

/**
 * Finds other phones running WaveDrop and announces this one, over Bonjour /
 * DNS-SD (service type _wavedrop._tcp). Bonjour is what iOS allows apps to use
 * on the local network without a special entitlement, and Android speaks it
 * through NsdManager, so Android and iPhone find each other.
 *
 * Service instance name: the device id. TXT record: id, n (name), pf
 * (platform), v (protocol version), ip and port of the server.
 */
class Nearby(context: Context, private val onChange: (List<NearbyPhone>) -> Unit) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val phones = LinkedHashMap<String, NearbyPhone>()
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var selfId = ""

    @Synchronized
    fun start(id: String, name: String, port: Int, visible: Boolean) {
        selfId = id
        if (visible) advertise(id, name, port) else unadvertise()
        if (discovery == null) browse()
    }

    @Synchronized
    fun stop() {
        unadvertise()
        discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        discovery = null
        pending.clear()
        phones.clear()
        onChange(emptyList())
    }

    /** Name or visibility changed: announce again. */
    @Synchronized
    fun update(id: String, name: String, port: Int, visible: Boolean) {
        unadvertise()
        if (visible) advertise(id, name, port)
    }

    private fun advertise(id: String, name: String, port: Int) {
        if (registration != null || port <= 0) return
        val info = NsdServiceInfo().apply {
            serviceName = id
            serviceType = TYPE
            setPort(port)
            setAttribute("id", id)
            setAttribute("n", name.take(40))
            setAttribute("pf", "android")
            setAttribute("v", "2")
            setAttribute("port", port.toString())
            localIpv4()?.let { setAttribute("ip", it) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {}
            override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) {
                Log.w(TAG, "register failed $error")
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) {}
        }
        registration = listener
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }.onFailure { registration = null }
    }

    private fun unadvertise() {
        registration?.let { runCatching { nsd.unregisterService(it) } }
        registration = null
    }

    private fun browse() {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, error: Int) {
                Log.w(TAG, "discovery failed $error")
                synchronized(this@Nearby) { if (discovery === this) discovery = null }
            }
            override fun onStopDiscoveryFailed(type: String, error: Int) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceName == selfId) return
                synchronized(this@Nearby) {
                    pending.add(info)
                    resolveNext()
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                synchronized(this@Nearby) {
                    if (phones.remove(info.serviceName) != null) onChange(phones.values.toList())
                }
            }
        }
        discovery = listener
        runCatching { nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener) }.onFailure { discovery = null }
    }

    // NsdManager resolves one service at a time.
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving) return
        val next = pending.pollFirst() ?: return
        resolving = true
        nsd.resolveService(next, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, error: Int) = done(null)
            override fun onServiceResolved(info: NsdServiceInfo) = done(info)

            private fun done(info: NsdServiceInfo?) = synchronized(this@Nearby) {
                resolving = false
                info?.let(::found)
                resolveNext()
            }
        })
    }

    @Suppress("DEPRECATION")
    private fun found(info: NsdServiceInfo) {
        val attrs = info.attributes.mapValues { (_, v) -> v?.let { String(it, Charsets.UTF_8) }.orEmpty() }
        val id = attrs["id"]?.takeIf { Regex("^[0-9a-f]{20}$").matches(it) } ?: return
        if (id == selfId || discovery == null) return
        val port = attrs["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: info.port
        val ip = attrs["ip"]?.takeIf { Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(it) }
            ?: (info.host as? Inet4Address)?.hostAddress
            ?: return
        phones[info.serviceName] = NearbyPhone(id, attrs["n"].orEmpty().ifEmpty { "Telefono" }.take(40), attrs["pf"].orEmpty().take(16), "http://$ip:$port", System.currentTimeMillis())
        onChange(phones.values.toList())
    }

    companion object {
        const val TYPE = "_wavedrop._tcp"
        private const val TAG = "WaveDropNearby"

        /** This phone's IPv4 address on the local network (Wi-Fi first). */
        fun localIpv4(): String? = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                ?.hostAddress
        }.getOrNull()
    }
}
