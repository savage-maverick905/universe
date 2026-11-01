package app.universe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives taps on the player widgets and the notification buttons. */
public class MediaCommandReceiver extends BroadcastReceiver {
    private static final String PREFIX = "app.universe.cmd.";

    @Override
    public void onReceive(Context c, Intent i) {
        String a = i == null ? null : i.getAction();
        if (a == null || !a.startsWith(PREFIX)) return;
        Hub.load(c);
        if (Hub.web == null) {
            // The app isn't running, so there is no player to command. Try to open it.
            try { c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { /* blocked */ }
            return;
        }
        Hub.command(c, a.substring(PREFIX.length()), 0);
    }
}
