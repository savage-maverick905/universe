self.UNIVERSE_SW = { prefix: 'universe-nova', version: 'v6', shell: [
  '/apps/nova/', '/apps/nova/app.js', '/apps/nova/lib.js', '/apps/nova/services/api.js', '/apps/nova/views/overview.js', '/apps/nova/views/tasks.js', '/apps/nova/views/taskui.js',
  '/apps/nova/views/calendar.js', '/apps/nova/views/schedule.js', '/apps/nova/views/eventui.js', '/apps/nova/views/projects.js', '/apps/nova/views/settings.js', '/apps/nova/styles.css',
  '/apps/nova/views/celebrate.js', '/shared/notify.js', '/shared/confetti.js', '/shared/theme.css', '/shared/icons.js', '/shared/ui.js', '/shared/auth.js', '/shared/account.js', '/shared/pwa.js',
  '/apps/nova/icons/icon-192.png', '/apps/nova/icons/icon.svg',
] };
importScripts('/shared/sw-core.js');
