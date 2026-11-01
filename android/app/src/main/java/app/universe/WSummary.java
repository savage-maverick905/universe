package app.universe;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

/** Overview (4x2): up to four numbers over up to three rows. */
public class WSummary extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        Widgets.Snap s = Widgets.Snap.read(c);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_summary);
        header(c, v);
        int ns = Widgets.Snap.count(s.stats);
        int nr = Widgets.Snap.count(s.rows);
        boolean empty = ns == 0 && nr == 0;
        stats(v, s.stats, 4);
        rows(v, s.rows, 3);
        v.setViewVisibility(R.id.statrow, ns > 0 ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.div, ns > 0 && nr > 0 ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.msg, empty ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.msg, s.status);
        v.setViewVisibility(R.id.status, empty ? View.GONE : View.VISIBLE);
        v.setTextViewText(R.id.status, s.status);
        return v;
    }
}
