package app.wavedrop.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.wavedrop.android.ui.MainActivity

object Notifier {
    const val CHANNEL_OFFERS = "offers"
    const val CHANNEL_SERVICE = "service"
    const val SERVICE_ID = 1

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_OFFERS, "File in arrivo", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Quando un PC o un telefono vuole inviarti qualcosa"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "Raggiungibile in background", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Mantiene il collegamento con i PC e gli altri telefoni quando l'app è chiusa"
            },
        )
    }

    private fun openApp(context: Context) = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun allowed(context: Context) =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun offer(context: Context, id: String, title: String, text: String) {
        if (!allowed(context)) return
        val n = Notification.Builder(context, CHANNEL_OFFERS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id.hashCode(), n)
    }

    fun clear(context: Context, id: String) {
        context.getSystemService(NotificationManager::class.java).cancel(id.hashCode())
    }

    fun service(context: Context): Notification = Notification.Builder(context, CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_stat)
        .setContentTitle("WaveDrop è raggiungibile")
        .setContentText("I tuoi PC e telefoni possono inviarti file anche con l'app chiusa.")
        .setContentIntent(openApp(context))
        .setOngoing(true)
        .build()
}
