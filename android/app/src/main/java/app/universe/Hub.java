package app.universe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** The one place that knows what is playing: feeds the media notification, lock screen, headsets and the player widgets, and sends their buttons back to the page. */
final class Hub {
    static final String CHANNEL = "universe_player";
    static final int NOTIF_ID = 4242;

    static volatile WebView web;
    static volatile boolean playing;
    static volatile String id = "", title = "", artist = "", album = "", artUrl = "";
    static volatile long pos, dur, at;

    private static volatile Bitmap art, widgetArt;
    private static volatile String loadingArt = "";
    private static boolean loaded;
    private static MediaSession session;
    private static long lastWidgetPush;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private Hub() {}

    static synchronized void load(Context c) {
        if (loaded) return;
        loaded = true;
        try {
            String s = Store.player(c);
            if (s.isEmpty()) return;
            JSONObject o = new JSONObject(s);
            id = o.optString("id");
            title = o.optString("title");
            artist = o.optString("artist");
            album = o.optString("album");
            artUrl = o.optString("art");
            pos = o.optLong("pos");
            dur = o.optLong("dur");
            playing = false;
            at = SystemClock.elapsedRealtime();
        } catch (Exception ignored) {
            // no saved track
        }
    }

    static boolean hasTrack() { return !id.isEmpty(); }
    static Bitmap widgetArt() { return widgetArt; }

    static int progress() {
        if (dur <= 0) return 0;
        long p = pos + (playing ? SystemClock.elapsedRealtime() - at : 0);
        return (int) Math.max(0, Math.min(1000, p * 1000 / dur));
    }

    static String timeText() {
        long p = pos + (playing ? SystemClock.elapsedRealtime() - at : 0);
        if (dur > 0) p = Math.min(p, dur);
        return fmt(p) + (dur > 0 ? " / " + fmt(dur) : "");
    }

    private static String fmt(long ms) {
        long s = Math.max(0, ms / 1000);
        return String.format(Locale.US, "%d:%02d", s / 60, s % 60);
    }

    /** Called from the page (any thread) with what is playing now. {"id":""} means stopped. */
    static void update(Context ctx, String json) {
        final Context app = ctx.getApplicationContext();
        JSONObject o;
        try { o = new JSONObject(json); } catch (Exception e) { return; }
        load(app);
        final String nid = o.optString("id");
        if (nid.isEmpty()) { reset(app); return; }
        final String oldId = id;
        final boolean wasPlaying = playing;
        id = nid;
        title = o.optString("title");
        artist = o.optString("artist");
        album = o.optString("album");
        playing = o.optBoolean("playing");
        pos = o.optLong("pos");
        dur = o.optLong("dur");
        at = SystemClock.elapsedRealtime();
        String na = o.optString("art");
        if (!na.equals(artUrl)) { artUrl = na; art = null; widgetArt = null; loadingArt = ""; }
        persist(app);
        final boolean changed = !nid.equals(oldId) || wasPlaying != playing;
        MAIN.post(new Runnable() {
            @Override public void run() {
                if (changed) MediaService.show(app); else refreshSession(app);
                loadArt(app);
                long now = SystemClock.elapsedRealtime();
                if (changed || now - lastWidgetPush > 9000) {
                    lastWidgetPush = now;
                    Widgets.updatePlayer(app);
                }
            }
        });
    }

    static void reset(final Context ctx) {
        final Context app = ctx.getApplicationContext();
        id = ""; title = ""; artist = ""; album = ""; artUrl = "";
        playing = false; pos = 0; dur = 0; art = null; widgetArt = null; loadingArt = "";
        Store.setPlayer(app, "");
        MAIN.post(new Runnable() {
            @Override public void run() {
                MediaService.stop(app);
                releaseSession();
                Widgets.updatePlayer(app);
            }
        });
    }

    private static void persist(Context c) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id).put("title", title).put("artist", artist).put("album", album).put("art", artUrl).put("pos", pos).put("dur", dur);
            Store.setPlayer(c, o.toString());
        } catch (Exception ignored) {
            // not saved
        }
    }

    static void ensureArt(Context c) {
        if (hasTrack() && widgetArt == null) loadArt(c.getApplicationContext());
    }

    private static void loadArt(final Context app) {
        final String url = artUrl;
        if (url.isEmpty() || art != null || url.equals(loadingArt)) return;
        loadingArt = url;
        IO.execute(new Runnable() {
            @Override public void run() {
                Bitmap b = Fetcher.bitmap(url, Store.cookie(app), 600);
                if (b == null || !url.equals(artUrl)) return;
                art = b;
                widgetArt = rounded(b, 256, 36f);
                MAIN.post(new Runnable() {
                    @Override public void run() {
                        MediaService.show(app);
                        Widgets.updatePlayer(app);
                    }
                });
            }
        });
    }

    private static Bitmap rounded(Bitmap src, int size, float radius) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        cv.drawRoundRect(new RectF(0, 0, size, size), radius, radius, p);
        p.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        int s = Math.min(src.getWidth(), src.getHeight());
        Rect from = new Rect((src.getWidth() - s) / 2, (src.getHeight() - s) / 2, (src.getWidth() + s) / 2, (src.getHeight() + s) / 2);
        cv.drawBitmap(src, from, new Rect(0, 0, size, size), p);
        return out;
    }

    // ---- Buttons -> page ----

    static void command(Context c, String cmd, long arg) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window.__uniPlayer&&window.__uniPlayer('" + cmd + "'," + arg + ")";
        MAIN.post(new Runnable() {
            @Override public void run() { w.evaluateJavascript(js, null); }
        });
    }

    static PendingIntent cmdIntent(Context c, String cmd) {
        Intent i = new Intent(c, MediaCommandReceiver.class).setAction("app.universe.cmd." + cmd);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ---- Media session + notification ----

    static synchronized MediaSession session(final Context app) {
        if (session == null) {
            session = new MediaSession(app, "UniverseMedia");
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { command(app, "play", 0); }
                @Override public void onPause() { command(app, "pause", 0); }
                @Override public void onStop() { command(app, "pause", 0); }
                @Override public void onSkipToNext() { command(app, "next", 0); }
                @Override public void onSkipToPrevious() { command(app, "prev", 0); }
                @Override public void onSeekTo(long p) { command(app, "seek", p); }
            }, MAIN);
        }
        return session;
    }

    static synchronized void releaseSession() {
        if (session != null) {
            try { session.setActive(false); session.release(); } catch (Exception ignored) { /* already gone */ }
            session = null;
        }
    }

    static void refreshSession(Context c) {
        Context app = c.getApplicationContext();
        MediaSession s = session(app);
        MediaMetadata.Builder m = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
        Bitmap a = art;
        if (a != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, a);
        s.setMetadata(m.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        s.setPlaybackState(new PlaybackState.Builder().setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, pos, playing ? 1f : 0f, at).build());
        s.setActive(hasTrack());
    }

    static Notification notification(Context c) {
        Context app = c.getApplicationContext();
        refreshSession(app);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(c, CHANNEL);
        } else {
            b = new Notification.Builder(c);
            b.setPriority(Notification.PRIORITY_LOW);
        }
        boolean has = hasTrack();
        b.setSmallIcon(R.drawable.ic_glyph)
                .setColor(0xFFFF6B1A)
                .setContentTitle(has ? title : BuildConfig.APP_NAME)
                .setContentText(has ? artist : "Nothing playing")
                .setContentIntent(Widgets.open(c, Widgets.REQ_OPEN, null))
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(playing);
        if (has && !album.isEmpty()) b.setSubText(album);
        Bitmap a = art;
        if (a != null) b.setLargeIcon(a);
        b.addAction(action(c, R.drawable.ic_prev, "Previous", "prev"));
        b.addAction(action(c, playing ? R.drawable.ic_pause : R.drawable.ic_play, playing ? "Pause" : "Play", "toggle"));
        b.addAction(action(c, R.drawable.ic_next, "Next", "next"));
        b.setStyle(new Notification.MediaStyle().setMediaSession(session(app).getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private static Notification.Action action(Context c, int icon, String label, String cmd) {
        return new Notification.Action.Builder(Icon.createWithResource(c, icon), label, cmdIntent(c, cmd)).build();
    }
}
