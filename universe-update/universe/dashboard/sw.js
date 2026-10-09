self.UNIVERSE_SW = { prefix: 'universe-dashboard', version: 'v2', shell: [
  '/dashboard/', '/dashboard/app.js', '/dashboard/assistant.js', '/dashboard/reports.js', '/dashboard/settings.js', '/dashboard/styles.css',
  '/shared/theme.css', '/shared/icons.js', '/shared/ui.js', '/shared/auth.js', '/shared/account.js', '/shared/pwa.js', '/shared/widgets.js',
  '/dashboard/icons/icon-192.png', '/dashboard/icons/icon.svg',
] };
importScripts('/shared/sw-core.js');
