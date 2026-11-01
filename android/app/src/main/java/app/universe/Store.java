package app.universe;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/** Tiny app-private store: the session cookie copied from the WebView, the last widget data, the player and the notification ids already shown. */
final class Store {
    private Store() {}

    private static final Object SEEN_LOCK = new Object();

    private static SharedPreferences p(Context c) {
        return c.getApplicationContext().getSharedPreferences("universe", Context.MODE_PRIVATE);
    }

    static String cookie(Context c) { return p(c).getString("cookie", ""); }
    static void setCookie(Context c, String v) { p(c).edit().putString("cookie", v == null ? "" : v).apply(); }

    /** "", "ok", "signin" or "error" - the result of the last refresh. */
    static String state(Context c) { return p(c).getString("state", ""); }
    static void setState(Context c, String v) { p(c).edit().putString("state", v).apply(); }

    static void setData(Context c, String json) {
        p(c).edit().putString("data", json).putLong("time", System.currentTimeMillis()).apply();
    }
    static long time(Context c) { return p(c).getLong("time", 0L); }

    static JSONObject data(Context c) {
        String s = p(c).getString("data", null);
        if (s == null) return null;
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }

    /** The last track (so the player widgets still show something after the app was closed). */
    static String player(Context c) { return p(c).getString("player", ""); }
    static void setPlayer(Context c, String json) { p(c).edit().putString("player", json == null ? "" : json).apply(); }

    /** Whether the notification permission prompt has been shown already. */
    static boolean asked(Context c) { return p(c).getBoolean("asked", false); }
    static void setAsked(Context c) { p(c).edit().putBoolean("asked", true).apply(); }

    /** True the first time an id is seen (and remembers it), false afterwards. Remembers the last 300. */
    static boolean markSeen(Context c, String id) {
        synchronized (SEEN_LOCK) {
            try {
                JSONArray old = new JSONArray(p(c).getString("seen", "[]"));
                for (int i = 0; i < old.length(); i++) {
                    if (id.equals(old.optString(i))) return false;
                }
                JSONArray next = new JSONArray();
                for (int i = Math.max(0, old.length() - 299); i < old.length(); i++) next.put(old.optString(i));
                next.put(id);
                p(c).edit().putString("seen", next.toString()).apply();
                return true;
            } catch (Exception e) {
                return true;
            }
        }
    }
}
