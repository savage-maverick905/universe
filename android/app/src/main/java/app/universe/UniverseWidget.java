package app.universe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;
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

/** One resizable home-screen widget per app: stat tiles on top, up to five list rows below. Tap = open the app. */
public class UniverseWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "app.universe.REFRESH";

    private static final int[] STAT_BOX = { R.id.stat1, R.id.stat2, R.id.stat3, R.id.stat4 };
    private static final int[] STAT_VAL = { R.id.stat1v, R.id.stat2v, R.id.stat3v, R.id.stat4v };
    private static final int[] STAT_LBL = { R.id.stat1l, R.id.stat2l, R.id.stat3l, R.id.stat4l };
    private static final int[] ROW = { R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5 };

    @Override
    public void onEnabled(Context c) {
        schedule(c);
        refreshNow(c);
    }

    @Override
    public void onDisabled(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork("universe-widget-periodic");
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        render(c, m, ids);
        refreshNow(c);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        super.onReceive(c, i);
        if (ACTION_REFRESH.equals(i.getAction())) refreshNow(c);
    }

    static void schedule(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(RefreshWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(net).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("universe-widget-periodic", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    static void refreshNow(Context c) {
        WorkManager.getInstance(c).enqueueUniqueWork("universe-widget-now", ExistingWorkPolicy.REPLACE,
                new OneTimeWorkRequest.Builder(RefreshWorker.class).build());
    }

    static boolean hasWidgets(Context c) {
        return AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c, UniverseWidget.class)).length > 0;
    }

    static void renderAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, UniverseWidget.class));
        if (ids.length > 0) render(c, m, ids);
    }

    static void render(Context c, AppWidgetManager m, int[] ids) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
        String name = c.getString(R.string.app_name);
        v.setTextViewText(R.id.title, name);

        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 0, open, flags));
        Intent refresh = new Intent(c, UniverseWidget.class).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(c, 1, refresh, flags));

        String state = Store.state(c);
        boolean signedIn = !Store.cookie(c).isEmpty() && !"signin".equals(state);
        JSONObject data = signedIn ? Store.data(c) : null;
        JSONArray stats = data == null ? null : data.optJSONArray("stats");
        JSONArray rows = data == null ? null : data.optJSONArray("rows");

        for (int i = 0; i < STAT_BOX.length; i++) {
            JSONObject s = stats == null ? null : stats.optJSONObject(i);
            if (s == null) {
                v.setViewVisibility(STAT_BOX[i], View.GONE);
                continue;
            }
            v.setViewVisibility(STAT_BOX[i], View.VISIBLE);
            v.setTextViewText(STAT_VAL[i], s.optString("value"));
            v.setTextViewText(STAT_LBL[i], s.optString("label"));
        }

        for (int i = 0; i < ROW.length; i++) {
            JSONObject r = rows == null ? null : rows.optJSONObject(i);
            if (r == null) {
                v.setViewVisibility(ROW[i], View.GONE);
                continue;
            }
            String sub = r.optString("s");
            v.setViewVisibility(ROW[i], View.VISIBLE);
            v.setTextViewText(ROW[i], r.optString("t") + (sub.isEmpty() ? "" : "  \u00B7  " + sub));
        }

        String status;
        if (!signedIn) {
            status = "Open " + name + " and sign in";
        } else if (data == null) {
            status = "error".equals(state) ? "Can't reach the server" : "Loading\u2026";
        } else {
            status = "Updated " + DateFormat.getTimeFormat(c).format(new Date(Store.time(c)));
            if ("error".equals(state)) status += " \u00B7 offline";
        }
        v.setTextViewText(R.id.status, status);

        m.updateAppWidget(ids, v);
    }
}
