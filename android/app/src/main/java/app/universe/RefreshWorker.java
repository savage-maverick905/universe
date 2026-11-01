package app.universe;

import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Runs in the background (every ~15 min while a widget exists, or on demand) and redraws the widget. */
public class RefreshWorker extends Worker {
    public RefreshWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        Store.setState(c, Fetcher.refresh(c));
        UniverseWidget.renderAll(c);
        return Result.success();
    }
}
