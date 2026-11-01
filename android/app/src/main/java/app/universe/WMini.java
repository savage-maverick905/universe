package app.universe;

import android.content.Context;
import android.widget.RemoteViews;

/** Mini player (4x1): small artwork, title and the three controls. */
public class WMini extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_mini);
        bindPlayer(c, v, false);
        return v;
    }
}
