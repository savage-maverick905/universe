package app.universe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Calls the app's own widget endpoints (the same ones the Universe dashboard uses) with the session cookie
 * the WebView received at sign-in, and flattens the three widget shapes (stat / list / chart) into one
 * {"stats":[{label,value}], "rows":[{t,s}]} document for the home-screen widgets.
 */
final class Fetcher {
    static final int MAX_STATS = 4;
    static final int MAX_ROWS = 6;

    private Fetcher() {}

    /** Returns "ok", "signin" (no/expired session) or "error" (offline, server error). Stores data on "ok". */
    static String refresh(Context ctx) {
        String cookie = Store.cookie(ctx);
        if (cookie.isEmpty()) return "signin";

        String[] endpoints = BuildConfig.DATA_ENDPOINTS.isEmpty() ? new String[0] : BuildConfig.DATA_ENDPOINTS.split(",");
        if (endpoints.length == 0) return "ok";
        JSONArray stats = new JSONArray();
        JSONArray rows = new JSONArray();
        boolean ok = false;
        boolean unauthorized = false;

        for (String ep : endpoints) {
            if (ep == null || ep.trim().isEmpty()) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(BuildConfig.BASE_URL + ep.trim()).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                c.setRequestProperty("Cookie", cookie);
                c.setRequestProperty("Accept", "application/json");
                int code = c.getResponseCode();
                if (code == 401) { unauthorized = true; continue; }
                if (code != 200) continue;
                merge(new JSONObject(new String(readAll(c.getInputStream()), "UTF-8")), stats, rows);
                ok = true;
            } catch (Exception e) {
                // offline or an unreadable reply: carry on with the next endpoint
            } finally {
                if (c != null) c.disconnect();
            }
        }

        if (!ok) return unauthorized ? "signin" : "error";
        try {
            JSONObject out = new JSONObject();
            out.put("stats", stats);
            out.put("rows", rows);
            Store.setData(ctx, out.toString());
        } catch (JSONException e) {
            return "error";
        }
        return "ok";
    }

    /** GET a JSON document from the site with the session cookie; null on any failure. */
    static JSONObject getJson(String path, String cookie) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BuildConfig.BASE_URL + path).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Cookie", cookie);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) return null;
            return new JSONObject(new String(readAll(c.getInputStream()), "UTF-8"));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Downloads an image (sending the cookie for our own site) and shrinks it so its longest side is at most max pixels. */
    static Bitmap bitmap(String url, String cookie, int max) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            if (!cookie.isEmpty() && url.startsWith(BuildConfig.BASE_URL)) c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() != 200) return null;
            byte[] data = readAll(c.getInputStream());
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
            int sample = 1;
            while (bounds.outWidth / (sample * 2) >= max && bounds.outHeight / (sample * 2) >= max) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap b = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
            if (b == null) return null;
            int side = Math.max(b.getWidth(), b.getHeight());
            if (side > max) {
                float k = (float) max / side;
                b = Bitmap.createScaledBitmap(b, Math.round(b.getWidth() * k), Math.round(b.getHeight() * k), true);
            }
            return b;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void merge(JSONObject j, JSONArray stats, JSONArray rows) throws JSONException {
        JSONArray s = j.optJSONArray("stats");
        if (s != null) {
            for (int i = 0; i < s.length() && stats.length() < MAX_STATS; i++) {
                JSONObject o = s.optJSONObject(i);
                if (o == null) continue;
                stats.put(new JSONObject().put("label", o.optString("label")).put("value", o.optString("value")));
            }
        }
        JSONArray items = j.optJSONArray("items");
        if (items != null) {
            for (int i = 0; i < items.length() && rows.length() < MAX_ROWS; i++) {
                JSONObject o = items.optJSONObject(i);
                if (o == null) continue;
                rows.put(new JSONObject().put("t", o.optString("title")).put("s", o.optString("subtitle")));
            }
        }
        JSONArray series = j.optJSONArray("series");
        if (series != null) {
            for (int i = 0; i < series.length() && rows.length() < MAX_ROWS; i++) {
                JSONObject o = series.optJSONObject(i);
                if (o == null) continue;
                rows.put(new JSONObject().put("t", o.optString("label")).put("s", o.optString("value")));
            }
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }
}
