// Block model -> Markdown. imgPath(img) returns the relative path the image was saved under (or null).
import { htmlToRuns, runsToMd, listNumbers, htmlToText } from './inline.js';
const md = (html) => runsToMd(htmlToRuns(html));
export function blocksToMarkdown(blocks, { imgPath = () => null, pageLink = () => null } = {}) {
  const num = listNumbers(blocks), out = [];
  const img = (im, alt) => { const p = imgPath(im); return p ? `![${(alt || im.alt || '').replace(/[\[\]]/g, '')}](${p})` : `*[image not exported: ${im.src}]*`; };
  for (const b of blocks) {
    const ind = '  '.repeat(b.indent || 0);
    switch (b.type) {
      case 'h1': out.push(`# ${md(b.html)}`); break; case 'h2': out.push(`## ${md(b.html)}`); break; case 'h3': out.push(`### ${md(b.html)}`); break;
      case 'ul': out.push(`${ind}- ${md(b.html)}`); break; case 'ol': out.push(`${ind}${num[b.id] || 1}. ${md(b.html)}`); break;
      case 'todo': out.push(`${ind}- [${b.checked ? 'x' : ' '}] ${md(b.html)}`); break;
      case 'quote': out.push(md(b.html).split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'callout': out.push(md(b.html).split('\n').map((l, k) => `> ${k ? '' : '**Note:** '}${l}`).join('\n')); break;
      case 'hr': out.push('---'); break;
      case 'code': out.push('```' + (b.lang || '') + '\n' + htmlToText(b.html) + '\n```'); break;
      case 'table': {
        const rows = (b.rows || []).map((r) => r.map((c) => md(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))); if (!rows.length) break;
        const n = Math.max(...rows.map((r) => r.length)), pad = (r) => [...r, ...Array(n - r.length).fill('')];
        out.push([`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(n).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n')); break;
      }
      case 'image': out.push(img(b) + (b.caption ? `\n*${md(b.caption)}*` : '')); break;
      case 'gallery': out.push((b.imgs || []).map((i) => img(i)).join('\n\n') + (b.caption ? `\n*${md(b.caption)}*` : '')); break;
      case 'file': out.push(`[${b.name || 'attachment'}](${imgPath(b) || '#'})`); break;
      case 'pagelink': { const l = pageLink(b.pageId); out.push(l ? `[${l.title}](${l.path})` : '[linked page]'); break; }
      case 'toc': out.push('*[Table of contents]*'); break;
      default: out.push(md(b.html || ''));
    }
  }
  const same = (a, b) => a && b && ['ul', 'ol', 'todo'].includes(a.type) && a.type === b.type;
  return out.reduce((a, s, i) => a + (i ? (same(blocks[i - 1], blocks[i]) ? '\n' : '\n\n') : '') + s, '') + '\n';
}
