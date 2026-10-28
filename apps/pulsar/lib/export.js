// Pulsar export/import orchestration (browser). Builds PDFs, Markdown, ZIPs and JSON backups from live data.
// Nothing is dropped silently: every problem (failed image, unsupported characters, failed page) is collected in `report`.
import { buildPdf, makeImageRegistry } from './pdf.js';
import { buildZip, readZip } from './zip.js';
import { blocksToMarkdown } from './md.js';
import { htmlToRuns, htmlToText } from './inline.js';

const enc = new TextEncoder(), dec = new TextDecoder();
export const safeName = (s, fb = 'Untitled') => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || fb);
export function download(data, name, type) { const blob = data instanceof Blob ? data : new Blob([data], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 8000); return blob.size; }

export function makeExporter({ api, onProgress = () => {} }) {
  const cache = new Map(), imgCache = new Map(), rawCache = new Map();
  const node = async (id) => { if (!cache.has(id)) cache.set(id, api('GET', `/nodes/${id}`).then((r) => r.node)); return cache.get(id); };
  async function fetchBlob(src) { if (!rawCache.has(src)) rawCache.set(src, fetch(src, { credentials: 'same-origin' }).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })); return rawCache.get(src); }
  // Re-encode any image as a baseline RGB JPEG (flattening transparency on white), at most 2000 px, so the PDF engine can embed it.
  async function toJpeg(src) {
    if (!imgCache.has(src)) imgCache.set(src, (async () => {
      const blob = await fetchBlob(src); const bmp = await createImageBitmap(blob); const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc)); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88)); if (!out) throw new Error('could not encode'); return new Uint8Array(await out.arrayBuffer());
    })());
    return imgCache.get(src);
  }
  // ----- tree helpers -----
  const children = (all, id) => all.filter((n) => n.parentId === id && !n.trashedAt).sort((a, b) => (a.order || 0) - (b.order || 0));
  function flatten(all, rootIds, level0 = 0, { journal = true } = {}) { const out = []; const walk = (n, lv) => { if (n.journalDate && !journal) return; out.push({ n, level: lv }); for (const c of children(all, n.id)) if (c.kind !== 'entry') walk(c, lv + 1); else out.push({ n: c, level: lv + 1 }); }; for (const id of rootIds) { const n = all.find((x) => x.id === id); if (n) walk(n, level0); } return out; }
  const valueText = (db, p, val, titles) => { if (val == null || val === '') return ''; if (p.type === 'checkbox') return val ? '✓' : ''; if (['select', 'status'].includes(p.type)) return p.options?.find((o) => o.id === val)?.name || val; if (p.type === 'multi_select') return (val || []).map((i) => p.options?.find((o) => o.id === i)?.name || i).join(', '); if (p.type === 'relation') return (val || []).map((i) => titles.get(i) || '(missing page)').join(', '); return String(val); };
  async function dbTable(dbNode, all) { const titles = new Map(all.map((n) => [n.id, n.title || 'Untitled'])), entries = children(all, dbNode.id), props = dbNode.schema?.props || [];
    const rows = [['Name', ...props.map((p) => p.name)].map((x) => x.replace(/[<>&]/g, '')), ...(await Promise.all(entries.map(async (e) => { const full = await node(e.id); return [full.title || 'Untitled', ...props.map((p) => valueText(dbNode, p, full.props?.[p.id], titles))].map((x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')); })))];
    return { id: 'dbt', type: 'table', header: true, rows }; }
  async function prepareBlocks(n, all, imgReg, report) {
    const titles = new Map(all.map((x) => [x.id, x.title || 'Untitled'])); const blocks = [];
    if (n.kind === 'database') blocks.push(await dbTable(n, all));
    for (const b of n.blocks || []) {
      const o = { ...b, caption: b.caption ? htmlToRuns(b.caption) : [] };
      if (b.type === 'image') { try { o.img = imgReg.add(b.src, await toJpeg(b.src)); if (!o.img) throw new Error('unsupported image'); } catch (e) { o.img = null; report.warnings.push(`Image in "${n.title || 'Untitled'}" could not be loaded (${e.message}).`); } }
      if (b.type === 'gallery') o.imgs = await Promise.all((b.imgs || []).map(async (g) => { try { const im = imgReg.add(g.src, await toJpeg(g.src)); if (!im) throw new Error('unsupported image'); return { ...g, img: im }; } catch (e) { report.warnings.push(`An image in "${n.title || 'Untitled'}" could not be loaded (${e.message}).`); return { ...g, img: null }; } }));
      if (b.type === 'pagelink') o.title = titles.get(b.pageId) || b.title || 'Linked page';
      blocks.push(o);
    }
    return blocks;
  }
  const newReport = () => ({ warnings: [], failed: [], pages: 0 });
  async function buildItems(list, all, imgReg, report, base = 0) {
    const items = []; let i = 0;
    for (const { n: meta, level } of list) {
      onProgress(`Preparing “${meta.title || 'Untitled'}” (${++i}/${list.length})`);
      try { const full = await node(meta.id); items.push({ title: `${full.icon && /^[\x20-\x7e\xa0-\xff]/.test(full.icon) ? '' : ''}${full.title || 'Untitled'}`, level: Math.max(0, level - base), subtitle: full.journalDate || (full.tags?.length ? `Tags: ${full.tags.join(', ')}` : ''), blocks: await prepareBlocks(full, all, imgReg, report) }); report.pages++; }
      catch (e) { report.failed.push(`${meta.title || meta.id}: ${e.message}`); items.push({ title: meta.title || 'Untitled', level, blocks: [{ id: 'f', type: 'p', html: `<i>This page could not be exported: ${String(e.message).replace(/[<>&]/g, '')}</i>` }] }); }
    }
    return items;
  }
  async function pdfFor(list, all, { title, toc = false, footer }, report) {
    const reg = makeImageRegistry(); const items = await buildItems(list, all, reg, report); onProgress('Writing PDF…');
    const r = buildPdf({ title, toc, footer: footer || title, items, images: reg.list, subtitle: `${items.length} page${items.length === 1 ? '' : 's'} · exported ${new Date().toLocaleDateString()}` });
    report.warnings.push(...r.warnings); return r;
  }
  return {
    node, newReport,
    async pagePdf(meta, all) { const report = newReport(); const r = await pdfFor([{ n: meta, level: 0 }], all, { title: meta.title || 'Untitled' }, report); return { bytes: r.bytes, pages: r.pages, report }; },
    async combinedPdf(rootIds, all, title, { journal = false } = {}) { const report = newReport(); const list = flatten(all, rootIds, 0, { journal }); const r = await pdfFor(list, all, { title, toc: list.length > 1 }, report); return { bytes: r.bytes, pages: r.pages, report }; },
    // one PDF per page, hierarchy kept as folders; returns ZIP bytes
    async zipOfPdfs(rootIds, all, { journal = false, includeSubpages = true } = {}) {
      const report = newReport(); const files = []; const seen = new Map(); const list = includeSubpages ? flatten(all, rootIds, 0, { journal }) : rootIds.map((id) => ({ n: all.find((x) => x.id === id), level: 0 })).filter((x) => x.n);
      const path = (n) => { const parts = []; let c = n; while (c) { parts.unshift(safeName(c.title)); c = all.find((x) => x.id === c.parentId); } return parts; };
      let i = 0;
      for (const { n } of list) {
        onProgress(`PDF ${++i} of ${list.length}: ${n.title || 'Untitled'}`);
        try { const r = await pdfFor([{ n, level: 0 }], all, { title: n.title || 'Untitled' }, report); const p = path(n); const folderKids = children(all, n.id).length; const rel = includeSubpages ? (folderKids ? [...p, `${p[p.length - 1]}.pdf`] : [...p.slice(0, -1), `${p[p.length - 1]}.pdf`]).join('/') : `${p[p.length - 1]}.pdf`; files.push({ name: rel, data: r.bytes }); }
        catch (e) { report.failed.push(`${n.title || n.id}: ${e.message}`); }
      }
      if (report.failed.length || report.warnings.length) files.push({ name: '_export-report.txt', data: [`Pulsar export report`, '', ...report.failed.map((f) => `FAILED: ${f}`), ...[...new Set(report.warnings)].map((w) => `WARNING: ${w}`)].join('\n') });
      if (!files.some((f) => f.name.endsWith('.pdf'))) throw new Error('No PDFs could be generated.');
      onProgress('Creating ZIP…'); return { bytes: buildZip(files), report, count: files.filter((f) => f.name.endsWith('.pdf')).length };
    },
    // Markdown files (+ assets/ folder) for the chosen pages
    async markdownFiles(rootIds, all, { journal = false } = {}) {
      const report = newReport(); const list = flatten(all, rootIds, 0, { journal }); const files = [], assetMap = new Map(); let k = 0;
      const pathOf = (n) => { const parts = []; let c = n; while (c) { parts.unshift(safeName(c.title)); c = all.find((x) => x.id === c.parentId); } return parts; };
      const fileOf = new Map(list.map(({ n }) => { const p = pathOf(n); return [n.id, (children(all, n.id).length ? [...p, `${p[p.length - 1]}.md`] : [...p.slice(0, -1), `${p[p.length - 1]}.md`]).join('/')]; }));
      const imgPath = (depth) => async (im) => null; void imgPath;
      for (const { n } of list) {
        onProgress(`Markdown: ${n.title || 'Untitled'}`);
        try {
          const full = await node(n.id); const dir = fileOf.get(n.id).split('/').slice(0, -1); const up = '../'.repeat(dir.length);
          const need = []; for (const b of full.blocks || []) { if (b.type === 'image' || b.type === 'file') need.push(b); if (b.type === 'gallery') need.push(...(b.imgs || [])); }
          for (const im of need) { if (!assetMap.has(im.src)) { try { const blob = await fetchBlob(im.src); const ext = (blob.type.split('/')[1] || (im.name || '').split('.').pop() || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'; const nm = `assets/${++k}-${safeName((im.name || im.alt || 'file').replace(/\.[^.]+$/, '')).replace(/\s/g, '_').slice(0, 30)}.${ext}`; assetMap.set(im.src, { name: nm, data: new Uint8Array(await blob.arrayBuffer()) }); } catch (e) { assetMap.set(im.src, null); report.warnings.push(`File in "${n.title || 'Untitled'}" could not be loaded (${e.message}); its link is marked as missing.`); } } }
          const body = blocksToMarkdown(full.blocks || [], { imgPath: (im) => (assetMap.get(im.src) ? up + assetMap.get(im.src).name : null), pageLink: (id) => { const f = fileOf.get(id); const t = all.find((x) => x.id === id); return f && t ? { title: t.title || 'Untitled', path: up + encodeURI(f) } : null; } });
          const front = `# ${full.title || 'Untitled'}\n\n${full.tags?.length ? `Tags: ${full.tags.join(', ')}\n\n` : ''}`; let dbmd = ''; if (full.kind === 'database') { const t = await dbTable(full, all); dbmd = blocksToMarkdown([{ ...t, rows: t.rows.map((r) => r.map((c) => c.replace(/&amp;/g, '&').replace(/&lt;/g, '<'))) }]) + '\n'; }
          files.push({ name: fileOf.get(n.id), data: front + dbmd + body }); report.pages++;
        } catch (e) { report.failed.push(`${n.title || n.id}: ${e.message}`); }
      }
      for (const a of assetMap.values()) if (a) files.push({ name: a.name, data: a.data });
      return { files, report };
    },
    async markdownZip(rootIds, all, opts) { const { files, report } = await this.markdownFiles(rootIds, all, opts); if (!files.length) throw new Error('Nothing could be exported.'); return { bytes: buildZip(files), report, count: files.filter((f) => f.name.endsWith('.md')).length }; },
    // Full JSON backup. zipAssets=true returns a ZIP (backup.json + assets/), otherwise one JSON file with assets embedded as base64.
    async backup(all, settings, { zipAssets = false, journal = true, includeTrash = false } = {}) {
      const report = newReport(); const metas = all.filter((n) => (includeTrash || !n.trashedAt) && (journal || !n.journalDate)); const nodes = [];
      let i = 0; for (const m of metas) { onProgress(`Backing up ${++i} of ${metas.length}`); try { const { ownerId, plain, ...full } = await node(m.id); nodes.push(full); } catch (e) { report.failed.push(`${m.title || m.id}: ${e.message}`); } }
      const srcs = new Set(); const add = (s) => { if (s && s.startsWith('/api/apps/pulsar/assets/')) srcs.add(s); };
      for (const n of nodes) { add(n.cover); for (const b of n.blocks || []) { add(b.src); (b.imgs || []).forEach((g) => add(g.src)); } }
      const assets = [], files = []; let k = 0;
      for (const s of srcs) { try { const blob = await fetchBlob(s); const buf = new Uint8Array(await blob.arrayBuffer()); if (zipAssets) { const nm = `assets/${++k}.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`; assets.push({ src: s, mime: blob.type, file: nm }); files.push({ name: nm, data: buf }); } else { let bin = ''; for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode(...buf.subarray(j, j + 0x8000)); assets.push({ src: s, mime: blob.type, data: btoa(bin) }); } } catch (e) { report.warnings.push(`Asset ${s} could not be included: ${e.message}`); } }
      const json = { format: 'pulsar-backup', version: 1, exportedAt: new Date().toISOString(), settings, nodes, assets };
      report.pages = nodes.length;
      return { bytes: zipAssets ? buildZip([{ name: 'backup.json', data: JSON.stringify(json, null, 1) }, ...files]) : enc.encode(JSON.stringify(json)), report, json };
    },
  };
}

// ----- restore -----
export async function readBackupFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer()); let json, blobs = new Map();
  if (buf[0] === 0x50 && buf[1] === 0x4b) { const files = await readZip(buf); const bj = files.find((f) => /(^|\/)backup\.json$/.test(f.name)); if (!bj) throw new Error('This ZIP has no backup.json. Only Pulsar backups can be restored.'); json = JSON.parse(dec.decode(bj.data)); for (const a of json.assets || []) { const f = files.find((x) => x.name === a.file || x.name.endsWith(`/${a.file}`)); if (f) blobs.set(a.src, new Blob([f.data], { type: a.mime })); } }
  else { json = JSON.parse(dec.decode(buf)); for (const a of json.assets || []) if (a.data) { const bin = atob(a.data), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); blobs.set(a.src, new Blob([u], { type: a.mime })); } }
  if (json?.format !== 'pulsar-backup' || !Array.isArray(json.nodes)) throw new Error('This file is not a Pulsar backup.');
  if (json.version > 1) throw new Error('This backup was made by a newer version of Pulsar.');
  return { json, blobs };
}
export async function restoreBackup({ json, blobs }, { api, uploadBlob, mode = 'merge', onProgress = () => {} }) {
  const map = new Map(), res = { imported: 0, skipped: 0, failed: [], assets: 0, assetFailures: 0 };
  const remap = async (src) => { if (!src || !blobs.has(src)) return src; if (!map.has(src)) { try { const a = await uploadBlob(blobs.get(src), src.split('/').slice(-2)[0] + '.' + (blobs.get(src).type.split('/')[1] || 'bin')); map.set(src, a.src); res.assets++; } catch { map.set(src, src); res.assetFailures++; } } return map.get(src); };
  let n = 0; for (const x of json.nodes) { onProgress(`Restoring assets ${++n}/${json.nodes.length}`); x.cover = await remap(x.cover); for (const b of x.blocks || []) { if (b.src) b.src = await remap(b.src); for (const g of b.imgs || []) g.src = await remap(g.src); } }
  for (let i = 0; i < json.nodes.length; i += 50) { onProgress(`Saving pages ${Math.min(json.nodes.length, i + 50)}/${json.nodes.length}`); const r = await api('POST', '/import', { mode, nodes: json.nodes.slice(i, i + 50).map(({ rev, createdAt, updatedAt, ownerId, ...n }) => n) }); res.imported += r.imported; res.skipped += r.skipped; res.failed.push(...r.failed); }
  if (json.settings && mode === 'replace') { try { await api('PUT', '/settings', json.settings); } catch { /* settings are optional */ } }
  return res;
}
