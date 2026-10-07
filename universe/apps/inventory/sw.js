self.UNIVERSE_SW = { prefix: 'universe-inventory', version: 'v1', shell: [
  '/apps/inventory/', '/apps/inventory/app.js', '/apps/inventory/services/api.js', '/apps/inventory/services/media.js', '/apps/inventory/styles.css',
  '/shared/theme.css', '/shared/icons.js', '/shared/ui.js', '/shared/auth.js', '/shared/account.js', '/shared/pwa.js', '/shared/widgets.js',
  '/apps/inventory/icons/icon-192.png', '/apps/inventory/icons/icon.svg',
] };
importScripts('/shared/sw-core.js');
