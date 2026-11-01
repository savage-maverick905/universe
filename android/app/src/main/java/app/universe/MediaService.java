package app.universe;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Foreground service behind the music notification. Keeps the app (and its audio) alive with the screen off. */
public class MediaService extends Service {
    static void show(Context c) {
        Intent i = new Intent(c, MediaService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception ignored) {
            // Android refused a background start: the notification just isn't shown
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, MediaService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = Hub.notification(this);
        if (Build.VERSION.SDK_INT >= 29) startForeground(Hub.NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(Hub.NOTIF_ID, n);
        if (!Hub.hasTrack()) {
            stopForeground(true);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Hub.web = null;
        Hub.reset(this);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
