export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, { auth = true, bodyLimit } = {}) {
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, rx, names, handler, auth, bodyLimit });
  }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.rx.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = ''; } });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}
