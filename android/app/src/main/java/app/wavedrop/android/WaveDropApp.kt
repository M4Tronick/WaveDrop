package app.wavedrop.android

import android.app.Application
import android.content.Context
import app.wavedrop.android.data.Store
import app.wavedrop.android.net.Hub
import app.wavedrop.android.update.Updater

class WaveDropApp : Application() {
    lateinit var store: Store
        private set
    lateinit var hub: Hub
        private set
    val updater: Updater by lazy { Updater(this, hub.http) }

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        hub = Hub(this, store)
        Notifier.createChannels(this)
    }
}

val Context.wave: WaveDropApp get() = applicationContext as WaveDropApp
