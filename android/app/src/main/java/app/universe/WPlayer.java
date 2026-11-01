package app.universe;

import android.content.Context;
import android.widget.RemoteViews;

/** Now playing (4x2): artwork, title, artist, progress and previous / play-pause / next. */
public class WPlayer extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_player);
        bindPlayer(c, v, true);
        return v;
    }
}
