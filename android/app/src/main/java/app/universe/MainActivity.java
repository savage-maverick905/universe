package app.universe;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Full-screen shell around one Universe app: black, no scrollbars, no zoom, native notifications, music controls and widgets. */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 17;
    private static final int REQ_NOTIF = 7;

    private WebView web;
    private ValueCallback<Uri[]> chooser;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " UniverseApp/2");
        CookieManager.getInstance().setAcceptCookie(true);

        Hub.load(getApplicationContext());
        Hub.web = web;
        web.addJavascriptInterface(new Bridge(this), "UniverseNative");
        Widgets.schedule(this);
        if (!Store.asked(this)) {
            Store.setAsked(this);
            askNotifications();
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme) || "javascript".equals(scheme)) return false;
                String host = u.getHost();
                if (host != null && host.equals(Uri.parse(BuildConfig.BASE_URL).getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { /* nothing can open it */ }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                shareSession();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) view.loadDataWithBaseURL(BuildConfig.BASE_URL, offlineHtml(), "text/html", "UTF-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    chooser = null;
                    return false;
                }
                return true;
            }
        });

        if (saved != null) {
            web.restoreState(saved);
        } else {
            String u = urlFrom(getIntent());
            web.loadUrl(u != null ? u : BuildConfig.BASE_URL + BuildConfig.APP_PATH);
        }
    }

    /** "/apps/nova/", "#/new" (a page inside this app) or a full URL on our own site. Anything else is ignored. */
    private String urlFrom(Intent i) {
        String u = i == null ? null : i.getStringExtra("url");
        if (u == null || u.isEmpty()) return null;
        if (u.startsWith("#")) return BuildConfig.BASE_URL + BuildConfig.APP_PATH + u;
        if (u.startsWith("/")) return BuildConfig.BASE_URL + u;
        if (u.startsWith(BuildConfig.BASE_URL)) return u;
        return null;
    }

    private static String offlineHtml() {
        return "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='margin:0;background:#000;color:#f2f2f2;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center'>"
                + "<div style='padding:32px'><div style='font-size:46px;color:#FF6B1A'>&#9679;</div>"
                + "<h2 style='margin:12px 0 6px'>You're offline</h2>"
                + "<p style='color:#a6a6a6;margin:0 0 26px'>" + BuildConfig.APP_NAME + " can't reach the server.</p>"
                + "<a href='" + BuildConfig.BASE_URL + BuildConfig.APP_PATH + "' style='background:#FF6B1A;color:#000;padding:13px 30px;border-radius:26px;text-decoration:none;font-weight:600'>Try again</a>"
                + "</div></body></html>";
    }

    void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQ_NOTIF);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String u = urlFrom(intent);
        if (u != null) web.loadUrl(u);
    }

    /** Copies the session cookie (HttpOnly, so page JS can't see it) into app storage for widgets and background notifications. */
    private void shareSession() {
        String ck = CookieManager.getInstance().getCookie(BuildConfig.BASE_URL);
        String old = Store.cookie(this);
        if (ck != null && ck.contains("universe_sid=")) {
            if (!ck.equals(old)) {
                Store.setCookie(this, ck);
                Widgets.schedule(this);
                Widgets.refreshNow(this);
            }
        } else if (!old.isEmpty()) { // signed out
            Store.setCookie(this, "");
            Store.setState(this, "signin");
            Widgets.updateAll(this);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (chooser != null) {
                chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
                chooser = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        // Deliberately NOT calling web.onPause(): keeps audio playing with the screen off.
        CookieManager.getInstance().flush();
        shareSession();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else if (Hub.playing) moveTaskToBack(true); // keep the music going instead of closing the player
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            Hub.web = null;
            Hub.reset(getApplicationContext());
        }
        web.destroy();
        super.onDestroy();
    }
}
