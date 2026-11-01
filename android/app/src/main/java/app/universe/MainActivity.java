package app.universe;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Full-screen shell around one Universe app (the same site you use in the browser). It also hands the
 * sign-in cookie to the home-screen widget, so the widget can read the app's own widget endpoints.
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 17;

    private WebView web;
    private ValueCallback<Uri[]> chooser;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // localStorage + IndexedDB (Jupiter offline downloads)
        s.setMediaPlaybackRequiresUserGesture(false); // let the next track start by itself
        s.setUserAgentString(s.getUserAgentString() + " UniverseApp/1");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme) || "javascript".equals(scheme)) return false;
                String host = u.getHost();
                if (host != null && host.equals(Uri.parse(BuildConfig.BASE_URL).getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                shareSessionWithWidget();
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

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(BuildConfig.BASE_URL + getString(R.string.app_path));
    }

    /** Copies the session cookie (HttpOnly, so page JS can't see it) into app storage for the widget. */
    private void shareSessionWithWidget() {
        String ck = CookieManager.getInstance().getCookie(BuildConfig.BASE_URL);
        String old = Store.cookie(this);
        if (ck != null && ck.contains("universe_sid=")) {
            if (!ck.equals(old)) {
                Store.setCookie(this, ck);
                if (UniverseWidget.hasWidgets(this)) UniverseWidget.refreshNow(this);
            }
        } else if (!old.isEmpty()) { // signed out
            Store.setCookie(this, "");
            Store.setState(this, "signin");
            UniverseWidget.renderAll(this);
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
        shareSessionWithWidget();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
