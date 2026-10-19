package app.wavedrop.android

import android.app.Application
import android.content.Context
import app.wavedrop.android.data.Store
import app.wavedrop.android.net.Hub

class WaveDropApp : Application() {
    lateinit var store: Store
        private set
    lateinit var hub: Hub
        private set

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        hub = Hub(this, store)
        Notifier.createChannels(this)
    }
}

val Context.wave: WaveDropApp get() = applicationContext as WaveDropApp
