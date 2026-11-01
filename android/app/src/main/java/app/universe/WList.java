package app.universe;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

/** List (4x3): the latest items, up to six rows. */
public class WList extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        Widgets.Snap s = Widgets.Snap.read(c);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_list);
        header(c, v);
        boolean empty = Widgets.Snap.count(s.rows) == 0;
        rows(v, s.rows, 6);
        v.setViewVisibility(R.id.div, empty ? View.GONE : View.VISIBLE);
        v.setViewVisibility(R.id.msg, empty ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.msg, empty ? s.status : "");
        v.setViewVisibility(R.id.status, empty ? View.GONE : View.VISIBLE);
        v.setTextViewText(R.id.status, s.status);
        return v;
    }
}
