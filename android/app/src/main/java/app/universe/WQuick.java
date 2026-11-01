package app.universe;

import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;

/** Quick action (4x1): the app, one headline number, and a big orange button that jumps straight to the action. */
public class WQuick extends BaseWidget {
    @Override
    RemoteViews build(Context c) {
        Widgets.Snap s = Widgets.Snap.read(c);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_quick);
        v.setTextViewText(R.id.title, BuildConfig.APP_NAME);
        JSONObject first = s.stats == null ? null : s.stats.optJSONObject(0);
        v.setTextViewText(R.id.sub, first == null ? s.status : first.optString("value") + " " + first.optString("label"));
        v.setOnClickPendingIntent(R.id.root, Widgets.open(c, Widgets.REQ_OPEN, null));
        v.setOnClickPendingIntent(R.id.action, Widgets.open(c, Widgets.REQ_QUICK, BuildConfig.QUICK_PATH));
        return v;
    }
}
