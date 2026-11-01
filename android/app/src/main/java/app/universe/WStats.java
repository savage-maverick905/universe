package app.universe;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

/** Stats (2x2): four tiles with a big orange number each. */
public class WStats extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        Widgets.Snap s = Widgets.Snap.read(c);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_stats);
        header(c, v);
        boolean empty = Widgets.Snap.count(s.stats) == 0;
        stats(v, s.stats, 4);
        v.setViewVisibility(R.id.grid, empty ? View.GONE : View.VISIBLE);
        v.setViewVisibility(R.id.msg, empty ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.msg, s.status);
        return v;
    }
}
