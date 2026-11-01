package app.universe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.text.format.DateFormat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.Date;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Shared plumbing for the home-screen widgets: which exist, redrawing them, the background job, and what a tap opens. */
final class Widgets {
    static final String ACTION_REFRESH = "app.universe.REFRESH";
    static final int REQ_OPEN = 100;
    static final int REQ_QUICK = 101;
    private static final String PERIODIC = "universe-periodic";
    private static final String NOW = "universe-now";

    private Widgets() {}

    private static BaseWidget[] all() {
        return new BaseWidget[] { new WSummary(), new WStats(), new WList(), new WQuick(), new WPlayer(), new WMini() };
    }

    static boolean hasAny(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (BaseWidget w : all()) {
            if (m.getAppWidgetIds(new ComponentName(c, w.getClass())).length > 0) return true;
        }
        return false;
    }

    static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (BaseWidget w : all()) push(c, m, w);
    }

    /** Only the music widgets (cheap; called whenever the track or play state changes). */
    static void updatePlayer(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        push(c, m, new WPlayer());
        push(c, m, new WMini());
    }

    private static void push(Context c, AppWidgetManager m, BaseWidget w) {
        int[] ids = m.getAppWidgetIds(new ComponentName(c, w.getClass()));
        if (ids.length > 0) m.updateAppWidget(ids, w.build(c));
    }

    /** This app has something to fetch in the background (widget data or notifications). */
    private static boolean needsWork() {
        return !BuildConfig.NOTIFY_APPS.isEmpty() || !BuildConfig.DATA_ENDPOINTS.isEmpty();
    }

    static void schedule(Context c) {
        if (!needsWork()) return;
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(RefreshWorker.class, 15, TimeUnit.MINUTES).setConstraints(net).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    static void maybeCancel(Context c) {
        if (BuildConfig.NOTIFY_APPS.isEmpty() && !hasAny(c)) WorkManager.getInstance(c).cancelUniqueWork(PERIODIC);
    }

    static void refreshNow(Context c) {
        if (!needsWork()) return;
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(RefreshWorker.class).build());
    }

    /** A tap target that opens this app (optionally on a page, e.g. "#/new"). Use a different req for each different target. */
    static PendingIntent open(Context c, int req, String url) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (url != null && !url.isEmpty()) i.putExtra("url", url);
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** What the data widgets show: the last stats and rows, plus a one-line status. */
    static final class Snap {
        final JSONArray stats;
        final JSONArray rows;
        final String status;

        private Snap(JSONArray stats, JSONArray rows, String status) {
            this.stats = stats;
            this.rows = rows;
            this.status = status;
        }

        static int count(JSONArray a) { return a == null ? 0 : a.length(); }

        static Snap read(Context c) {
            String state = Store.state(c);
            boolean signedIn = !Store.cookie(c).isEmpty() && !"signin".equals(state);
            JSONObject data = signedIn ? Store.data(c) : null;
            String status;
            if (!signedIn) {
                status = "Open " + BuildConfig.APP_NAME + " and sign in";
            } else if (data == null) {
                status = "error".equals(state) ? "Can't reach the server" : "Loading\u2026";
            } else {
                status = "Updated " + DateFormat.getTimeFormat(c).format(new Date(Store.time(c)));
                if ("error".equals(state)) status += " \u00B7 offline";
            }
            return new Snap(data == null ? null : data.optJSONArray("stats"), data == null ? null : data.optJSONArray("rows"), status);
        }
    }
}
