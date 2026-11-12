// Makes sure boards.css is loaded even if the page shell (index.html) was served from an older cache that has no <link> for it.
export function ensureBoardsCss() {
  if ([...document.styleSheets].some((s) => s.href && s.href.includes('/apps/pulsar/boards.css')) || document.querySelector('link[data-bdcss]')) return Promise.resolve();
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/apps/pulsar/boards.css'; l.dataset.bdcss = '1'; document.head.append(l);
  return new Promise((res) => { l.onload = l.onerror = res; setTimeout(res, 3000); });
}
