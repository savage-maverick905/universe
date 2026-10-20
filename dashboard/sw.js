self.UNIVERSE_SW = { prefix: 'universe-dashboard', version: 'v7', shell: [
  '/dashboard/', '/dashboard/app.js', '/dashboard/assistant.js', '/dashboard/reports.js', '/dashboard/settings.js', '/dashboard/styles.css',
  '/shared/pdf.js', '/shared/theme.css', '/shared/icons.js', '/shared/ui.js', '/shared/auth.js', '/shared/account.js', '/shared/pwa.js', '/shared/widgets.js', '/shared/pin-gate.js', '/shared/markdown.js',
  '/dashboard/icons/icon-192.png', '/dashboard/icons/icon.svg',
] };
importScripts('/shared/sw-core.js');
