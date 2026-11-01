package app.universe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real Android notifications for events, tasks, budgets... from your apps. Shown once per item; one channel per app. */
final class Notifier {
    private Notifier() {}

    static boolean allowed(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm.areNotificationsEnabled();
    }

    private static String nameOf(String app) {
        switch (app) {
            case "nova": return "Nova";
            case "finance": return "Orbit";
            case "pulsar": return "Pulsar";
            case "jupiter": return "Jupiter";
            case "inventory": return "Inventory";
            default: return "Universe";
        }
    }

    private static String pathOf(String app) {
        return "dashboard".equals(app) ? "/dashboard/" : "/apps/" + app + "/";
    }

    private static boolean installed(Context c, String app) {
        try {
            c.getPackageManager().getPackageInfo("app.universe." + app, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static void post(Context c, String app, String id, String title, String body, String url) {
        if (id == null || id.isEmpty() || title == null || title.isEmpty() || !allowed(c)) return;
        if (!Store.markSeen(c, id)) return;
        String appId = app == null || app.isEmpty() ? BuildConfig.APP_ID : app;
        String text = body == null ? "" : body;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        String channel = "n_" + appId;
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(channel, nameOf(appId), NotificationManager.IMPORTANCE_DEFAULT));

        // Open the app the item belongs to if its APK is installed, otherwise this one.
        Intent target = appId.equals(BuildConfig.APP_ID) ? null : c.getPackageManager().getLaunchIntentForPackage("app.universe." + appId);
        if (target == null) target = new Intent(c, MainActivity.class);
        target.putExtra("url", url == null || url.isEmpty() ? pathOf(appId) : url);
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, id.hashCode(), target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_glyph)
                .setColor(0xFFFF6B1A)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true);
        nm.notify(id.hashCode(), b.build());
    }

    /** Background check of this app's notification feeds (the page does the same every minute while it is open). */
    static void poll(Context c) {
        if (BuildConfig.NOTIFY_APPS.isEmpty() || !allowed(c)) return;
        String cookie = Store.cookie(c);
        if (cookie.isEmpty()) return;
        for (String app : BuildConfig.NOTIFY_APPS.split(",")) {
            if (app.isEmpty()) continue;
            if (!app.equals(BuildConfig.APP_ID) && installed(c, app)) continue; // that app's own APK covers it
            JSONObject j = Fetcher.getJson("/api/apps/" + app + "/notifications", cookie);
            JSONArray items = j == null ? null : j.optJSONArray("items");
            if (items == null) continue;
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                post(c, app, it.optString("id"), it.optString("title"), it.optString("body"), it.optString("url"));
            }
        }
    }
}
