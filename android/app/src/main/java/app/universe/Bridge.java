package app.universe;

import android.webkit.JavascriptInterface;
import org.json.JSONObject;

/** What the web pages can call: window.UniverseNative.* */
public final class Bridge {
    private final MainActivity act;

    Bridge(MainActivity act) { this.act = act; }

    /** Jupiter reports what is playing (JSON). Drives the notification, lock screen and widgets. */
    @JavascriptInterface
    public void player(String json) { Hub.update(act.getApplicationContext(), json); }

    @JavascriptInterface
    public boolean canNotify() { return Notifier.allowed(act.getApplicationContext()); }

    @JavascriptInterface
    public void requestPermission() {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.askNotifications(); }
        });
    }

    /** Shows a notification: {id, app, title, body, url}. */
    @JavascriptInterface
    public void pushNotice(String json) {
        try {
            JSONObject o = new JSONObject(json);
            Notifier.post(act.getApplicationContext(), o.optString("app"), o.optString("id"), o.optString("title"), o.optString("body"), o.optString("url"));
        } catch (Exception ignored) {
            // bad payload
        }
    }
}
