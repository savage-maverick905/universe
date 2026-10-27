// Storage upkeep for the MEDIA branch only. Nothing here can touch the Universe data branch: the media store refuses to use it.
//
// Weekly history rebuild: every upload and listening-history save is a Git commit, so history grows. The rebuild replaces the branch's
// history with ONE commit that points at the very same file tree (verified before and after), then moves the media branch to it.
// Current songs, artwork and analytics files are untouched. It is skipped if anything was added in the last 15 minutes or if the
// branch moved while it was running. Caveat: GitHub may keep old commits reachable by their hash until it garbage-collects them, so
// this limits history growth; it does not promise immediate physical erasure.
export function makeMaintenance(s, media, lib) {
  async function rebuild({ force = false } = {}) {
    if (!force) {
      const all = await lib.cols.tracks.find({ orderBy: { field: 'createdAt', dir: 'desc' }, limit: 1 });
      if (all[0] && Date.now() - Date.parse(all[0].createdAt) < 15 * 60_000) return { skipped: 'A track was added in the last 15 minutes; will retry next week.' };
    }
    const r = await media.rebuildHistory();
    s.log.info?.('Jupiter history rebuild:', r.skipped || `ok ${String(r.before).slice(0, 7)} -> ${String(r.after).slice(0, 7)}`);
    return r;
  }
  // Report only. Files in the media branch that no track or artwork record points at (for example after a failed delete cleanup).
  async function orphanReport() {
    const files = await media.list(), keep = new Set();
    const tracks = await lib.cols.tracks.find({ limit: 10000 });
    for (const t of tracks) { t.parts.forEach((_, i) => keep.add(lib.partPath(t.id, i))); if (t.artKey) keep.add(`art/${t.artKey}`); }
    for (const c of [lib.cols.albums, lib.cols.artists, lib.cols.playlists]) for (const d of await c.find({ limit: 10000 })) if (d.artKey) keep.add(`art/${d.artKey}`);
    const orphans = files.filter((f) => (f.path.startsWith('tracks/') || f.path.startsWith('art/')) && !keep.has(f.path));
    const missing = [...keep].filter((p) => !files.some((f) => f.path === p));
    return { files: files.length, orphanCount: orphans.length, orphanBytes: orphans.reduce((n, f) => n + f.size, 0), orphans: orphans.slice(0, 50).map((f) => f.path), missingCount: missing.length, missing: missing.slice(0, 50), note: 'Report only. Nothing is deleted automatically.' };
  }
  return { rebuild, orphanReport };
}
