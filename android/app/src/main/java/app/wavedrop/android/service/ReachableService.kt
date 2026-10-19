package app.wavedrop.android.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import app.wavedrop.android.Notifier
import app.wavedrop.android.wave

/** Keeps the PC connections open while the app is closed (opt-in in Settings). */
class ReachableService : Service() {
    override fun onCreate() {
        super.onCreate()
        startForeground(Notifier.SERVICE_ID, Notifier.service(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        wave.hub.attach("service")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() {
        wave.hub.detach("service")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun sync(context: Context) {
            val intent = Intent(context, ReachableService::class.java)
            if (context.wave.store.stayReachable) context.startForegroundService(intent) else context.stopService(intent)
        }
    }
}
