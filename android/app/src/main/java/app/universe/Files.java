package app.universe;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Saves and shares files made inside the web page (PDF statements, CSV exports, backups, share pictures).
 * A WebView cannot download blob: links or use navigator.share with files, so the page streams the bytes here in
 * chunks (begin, chunk..., end) and we either put the file in Downloads or open the Android share sheet.
 */
final class Files {
    private static final class Pending {
        final File file; final OutputStream out; final String name, mime;
        Pending(File file, OutputStream out, String name, String mime) { this.file = file; this.out = out; this.name = name; this.mime = mime; }
    }

    private static final Map<String, Pending> OPEN = new ConcurrentHashMap<>();
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    private Files() {}

    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n.isEmpty() ? "file" : n;
    }

    static String mimeFor(String name, String given) {
        if (given != null && !given.isEmpty() && !"application/octet-stream".equals(given)) return given;
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
        String m = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    /** Starts a transfer. Returns a token, or "" if the file could not be opened. */
    static String begin(Context c, String name, String mime) {
        try {
            File dir = new File(c.getCacheDir(), "shared");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 24L * 3600 * 1000) { //noinspection ResultOfMethodCallIgnored
                f.delete(); }
            String safe = safeName(name), token = UUID.randomUUID().toString();
            File f = new File(dir, token.substring(0, 8) + "-" + safe);
            OPEN.put(token, new Pending(f, new FileOutputStream(f), safe, mimeFor(safe, mime)));
            return token;
        } catch (Exception e) {
            return "";
        }
    }

    static boolean chunk(String token, String base64) {
        Pending p = OPEN.get(token);
        if (p == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (p.file.length() + bytes.length > MAX_BYTES) throw new IOException("too big");
            p.out.write(bytes);
            return true;
        } catch (Exception e) {
            abort(token);
            return false;
        }
    }

    static void abort(String token) {
        Pending p = OPEN.remove(token);
        if (p == null) return;
        try { p.out.close(); } catch (IOException ignored) { /* closing anyway */ }
        //noinspection ResultOfMethodCallIgnored
        p.file.delete();
    }

    /** Finishes the transfer. action = "save" (Downloads) or "share" (share sheet). Returns "ok" or an error sentence. */
    static String end(final Activity act, String token, String action, final String title, final String text) {
        final Pending p = OPEN.remove(token);
        if (p == null) return "The file transfer was interrupted. Try again.";
        try { p.out.close(); } catch (IOException e) { return "Could not write the file."; }
        try {
            boolean share = "share".equals(action) || Build.VERSION.SDK_INT < 29; // Android 9 and older: no storage permission, so let the person choose where it goes
            if (!share) { saveToDownloads(act, p); return "ok"; }
            final Uri uri = FileProvider.getUriForFile(act, BuildConfig.APPLICATION_ID + ".files", p.file);
            act.runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND).setType(p.mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
                    if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
                    send.setClipData(ClipData.newRawUri(p.name, uri));
                    try { act.startActivity(Intent.createChooser(send, title == null || title.isEmpty() ? p.name : title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); }
                    catch (Exception ignored) { /* nothing can receive it */ }
                }
            });
            return "ok";
        } catch (Exception e) {
            return "Could not save the file.";
        }
    }

    private static void saveToDownloads(Context c, Pending p) throws IOException {
        ContentResolver cr = c.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, p.name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, p.mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("no Downloads access");
        try (InputStream in = new FileInputStream(p.file); OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("no output");
            byte[] buf = new byte[64 * 1024]; int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            cr.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, done, null, null);
        //noinspection ResultOfMethodCallIgnored
        p.file.delete();
    }
}
