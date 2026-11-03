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

    // ---- Saving and sharing files made by the page (a WebView cannot download blob: links or share files by itself) ----
    /** Starts a file transfer. Returns a token, or an empty string if it could not start. */
    @JavascriptInterface
    public String fileBegin(String name, String mime) { return Files.begin(act.getApplicationContext(), name, mime); }

    /** One base64 piece of the file, in order. */
    @JavascriptInterface
    public boolean fileChunk(String token, String base64) { return Files.chunk(token, base64); }

    /** Finishes it. action is "save" (Downloads) or "share" (share sheet). Returns "ok" or a message to show. */
    @JavascriptInterface
    public String fileEnd(String token, String action, String title, String text) { return Files.end(act, token, action, title, text); }

    @JavascriptInterface
    public void fileAbort(String token) { Files.abort(token); }

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
