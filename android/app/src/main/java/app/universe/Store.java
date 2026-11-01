package app.universe;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Tiny app-private store: the session cookie copied from the WebView, and the last widget data. */
final class Store {
    private Store() {}

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
}
