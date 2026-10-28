# Pulsar

A Notion-style personal workspace inside Universe. No npm dependencies. Folder: `apps/pulsar/` (id `pulsar`).

## What it does (status)
| Feature | Status |
|---|---|
| Dashboard, sidebar tree, breadcrumbs, favorites, tags, covers, icons, quick search (Ctrl/Cmd+K), filtered search | Implemented, browser-tested |
| Collections, nested pages, move / duplicate / trash / restore / delete forever | Implemented (API tested) |
| Block editor: formatting, lists, checklists, quotes, callouts, code, dividers, tables, contents, page links, slash menu, markdown shortcuts, undo/redo, block selection, drag reorder, paste | Implemented; core flows browser-tested, not every key combination |
| Images anywhere between blocks (insert, paste, drop, resize, align, caption, alt, replace, image rows) and file attachments | Implemented; insert + reload persistence browser-tested |
| Autosave (debounced, queued, revision conflict check, local draft recovery, status indicator) | Implemented |
| Journal: calendar, daily template, previous/next day, search, private by default | Implemented |
| Databases: 9 property types, table / board / calendar views, sort, filter, search, entries open as pages | Implemented; lightly browser-tested |
| Export: page PDF, combined collection PDF (contents + bookmarks), ZIP of PDFs, Markdown ZIP, JSON backup (single file or ZIP), everything ZIP, restore | Implemented; PDFs checked with qpdf/pdftotext, ZIPs with unzip -t, restore tested in a browser |
| Settings: theme, text size, width, default/custom templates, device PIN lock; PWA install | Implemented |
| Real-time collaboration, sharing, encryption, offline edit queue, Markdown import | Not built |

## Data
Collections `pulsar_nodes` (pages, collections, databases, entries, journal; schemaVersion 1), `pulsar_assets`, `pulsar_settings`. Blocks are JSON; inline formatting is a sanitised HTML subset (sanitised again on the server). Images are never stored inside page JSON.

## Image storage
* Cloudinary (recommended; required on Vercel with the GitHub driver): set `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET` (unsigned), same as Inventory.
* Local (SQLite driver only): stored in the database, max 3 MB each, auto-shrunk.
* Otherwise uploads are disabled with a clear message.

## Limits
* PDFs use built-in Latin fonts: emoji and non-Latin scripts become "?" (export reports how many). Markdown/JSON keep everything.
* The PIN lock is a screen cover on the device, not encryption.
* Vercel caps request bodies (~4.5 MB): each save and upload must stay under that.
