/**
 * STORAGE INTERFACE (what every driver must implement)
 *
 *   storage.collection(name, { indexes?: string[] }) -> Collection
 *   storage.transaction(async (storage) => result)   // callback must ONLY do storage calls
 *   storage.exportAll({ exclude?: string[] })        -> { format, schemaVersion, collections }
 *   storage.importAll(data, { mode: 'merge'|'replace' })
 *   storage.close()                                  // may return a promise (github driver saves first): await it
 *
 *   Collection (all methods async, documents are plain JSON objects with a string `id`):
 *     insert(doc)              -> doc          (throws code DUPLICATE_ID)
 *     upsert(doc)              -> doc
 *     get(id)                  -> doc | null
 *     find({ where, orderBy:{field,dir}, limit, offset }) -> doc[]
 *     count(where)             -> number
 *     update(id, patch)        -> doc | null   (shallow merge)
 *     delete(id)               -> boolean
 *     deleteWhere(where)       -> number
 *
 *   where: { field: value } (equality) or { field: { $lt, $lte, $gt, $gte, $in } }
 *          fields may be dotted paths, e.g. "status.state"
 *
 * Application code must only use this interface, never a vendor SDK.
 */
export async function createStorage(config) {
  switch (config.driver) {
    case 'sqlite': {
      const { SqliteStorage } = await import('./drivers/sqlite.js');
      return new SqliteStorage(config.sqlitePath);
    }
    case 'github': {
      const { GithubStorage } = await import('./drivers/github.js');
      return GithubStorage.open(config.github || {});
    }
    default:
      throw new Error(`Unknown STORAGE_DRIVER "${config.driver}". Supported: sqlite, github`);
  }
}
