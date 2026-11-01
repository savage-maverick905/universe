package app.universe;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/** Base for every home-screen widget: shared header, stat tiles, list rows and the music controls. */
public abstract class BaseWidget extends AppWidgetProvider {
    private static final int[] ST = { R.id.st1, R.id.st2, R.id.st3, R.id.st4 };
    private static final int[] STV = { R.id.st1v, R.id.st2v, R.id.st3v, R.id.st4v };
    private static final int[] STL = { R.id.st1l, R.id.st2l, R.id.st3l, R.id.st4l };
    private static final int[] RW = { R.id.rw1, R.id.rw2, R.id.rw3, R.id.rw4, R.id.rw5, R.id.rw6 };
    private static final int[] RWT = { R.id.rw1t, R.id.rw2t, R.id.rw3t, R.id.rw4t, R.id.rw5t, R.id.rw6t };
    private static final int[] RWS = { R.id.rw1s, R.id.rw2s, R.id.rw3s, R.id.rw4s, R.id.rw5s, R.id.rw6s };

    /** Draws this widget from the latest data. Every instance of a widget shows the same thing. */
    abstract RemoteViews build(Context c);

    @Override
    public void onEnabled(Context c) {
        Widgets.schedule(c);
        Widgets.refreshNow(c);
    }

    @Override
    public void onDisabled(Context c) {
        Widgets.maybeCancel(c);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, build(c));
        Widgets.refreshNow(c);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        super.onReceive(c, i);
        if (i != null && Widgets.ACTION_REFRESH.equals(i.getAction())) Widgets.refreshNow(c);
    }

    PendingIntent refreshIntent(Context c) {
        Intent r = new Intent(c, getClass()).setAction(Widgets.ACTION_REFRESH);
        return PendingIntent.getBroadcast(c, 1, r, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** App name, tap-anywhere-to-open, and the refresh arrow. */
    void header(Context c, RemoteViews v) {
        v.setTextViewText(R.id.title, BuildConfig.APP_NAME);
        v.setOnClickPendingIntent(R.id.root, Widgets.open(c, Widgets.REQ_OPEN, null));
        v.setOnClickPendingIntent(R.id.refresh, refreshIntent(c));
    }

    static void stats(RemoteViews v, JSONArray a, int max) {
        for (int i = 0; i < max; i++) {
            JSONObject s = a == null ? null : a.optJSONObject(i);
            if (s == null) {
                v.setViewVisibility(ST[i], View.GONE);
                continue;
            }
            v.setViewVisibility(ST[i], View.VISIBLE);
            v.setTextViewText(STV[i], s.optString("value"));
            v.setTextViewText(STL[i], s.optString("label"));
        }
    }

    static void rows(RemoteViews v, JSONArray a, int max) {
        for (int i = 0; i < max; i++) {
            JSONObject r = a == null ? null : a.optJSONObject(i);
            if (r == null) {
                v.setViewVisibility(RW[i], View.GONE);
                continue;
            }
            v.setViewVisibility(RW[i], View.VISIBLE);
            v.setTextViewText(RWT[i], r.optString("t"));
            v.setTextViewText(RWS[i], r.optString("s"));
        }
    }

    /** Shared by the Now playing and Mini player widgets. */
    static void bindPlayer(Context c, RemoteViews v, boolean full) {
        Hub.load(c);
        boolean has = Hub.hasTrack();
        v.setTextViewText(R.id.p_title, has ? Hub.title : "Nothing playing");
        v.setTextViewText(R.id.p_artist, has ? Hub.artist : "Tap to open " + BuildConfig.APP_NAME);
        Hub.ensureArt(c);
        Bitmap art = Hub.widgetArt();
        if (art != null) v.setImageViewBitmap(R.id.p_art, art);
        else v.setImageViewResource(R.id.p_art, R.drawable.art_placeholder);
        v.setImageViewResource(R.id.p_play, Hub.playing ? R.drawable.ic_pause : R.drawable.ic_play);
        v.setOnClickPendingIntent(R.id.p_prev, Hub.cmdIntent(c, "prev"));
        v.setOnClickPendingIntent(R.id.p_play, Hub.cmdIntent(c, "toggle"));
        v.setOnClickPendingIntent(R.id.p_next, Hub.cmdIntent(c, "next"));
        v.setOnClickPendingIntent(R.id.root, Widgets.open(c, Widgets.REQ_OPEN, null));
        if (full) {
            v.setProgressBar(R.id.p_progress, 1000, Hub.progress(), false);
            v.setTextViewText(R.id.p_time, has ? Hub.timeText() : "");
        }
    }
}
