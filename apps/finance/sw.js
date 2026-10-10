// Caches only Orbit's own app shell (HTML, JS, CSS, icons). /api/ is never cached (sw-core.js), so no balances or transactions ever land in a browser cache.
self.UNIVERSE_SW = { prefix: 'universe-finance', version: 'v1', shell: [
  '/apps/finance/', '/apps/finance/app.js', '/apps/finance/styles.css', '/apps/finance/lib/api.js', '/apps/finance/lib/fmt.js', '/apps/finance/lib/charts.js', '/apps/finance/lib/forms.js',
  '/apps/finance/views/lock.js', '/apps/finance/views/home.js', '/apps/finance/views/activity.js', '/apps/finance/views/accounts.js', '/apps/finance/views/categories.js',
  '/apps/finance/views/plan.js', '/apps/finance/views/reports.js', '/apps/finance/views/assistant.js', '/apps/finance/views/settings.js',
  '/shared/theme.css', '/shared/icons.js', '/shared/ui.js', '/shared/auth.js', '/shared/account.js', '/shared/pwa.js',
  '/apps/finance/icons/icon-192.png', '/apps/finance/icons/icon.svg',
] };
importScripts('/shared/sw-core.js');
