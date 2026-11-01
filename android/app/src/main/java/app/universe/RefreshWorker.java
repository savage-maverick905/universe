package app.universe;

import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Runs in the background (about every 15 min, or on demand): refreshes widget data and checks for new notifications. */
public class RefreshWorker extends Worker {
    public RefreshWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        try {
            if (!BuildConfig.DATA_ENDPOINTS.isEmpty()) {
                Store.setState(c, Fetcher.refresh(c));
                Widgets.updateAll(c);
            }
            Notifier.poll(c);
        } catch (Exception ignored) {
            // try again next time
        }
        return Result.success();
    }
}
