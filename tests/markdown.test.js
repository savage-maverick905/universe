import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtml, parseInline, parseMarkdown } from '../shared/markdown.js';

test('markdown: the table from a real Nebula reply becomes a table, bold becomes bold', () => {
  const b = parseMarkdown('Here is **this month**:\n\n| Category | Spent | % Used |\n|---|---|---|\n| Bills & Utilities | **₦0.00** | **0%** |\n\n**Caveat:** nothing recorded yet.');
  assert.deepEqual(b.map((x) => x.t), ['p', 'table', 'p']);
  assert.deepEqual(b[1].head, ['Category', 'Spent', '% Used']); assert.deepEqual(b[1].rows, [['Bills & Utilities', '**₦0.00**', '**0%**']]);
  assert.deepEqual(parseInline('**₦0.00**'), [{ t: 'b', v: '₦0.00' }]);
});
test('markdown: lists, headings, code, links; only http(s) links', () => {
  const b = parseMarkdown('## Title\n- one\n- two\n\n1. first\n2. second\n\n```\nx = 1\n```');
  assert.deepEqual(b.map((x) => x.t), ['h', 'list', 'list', 'code']); assert.equal(b[2].ordered, true);
  assert.deepEqual(parseInline('see [docs](https://a.io/x) now'), [{ t: 'text', v: 'see ' }, { t: 'a', v: 'docs', href: 'https://a.io/x' }, { t: 'text', v: ' now' }]);
  assert.deepEqual(parseInline('[bad](javascript:alert(1))'), [{ t: 'text', v: '[bad](javascript:alert(1))' }]);
});
test('markdown: stray HTML is converted or dropped, never kept as tags', () => {
  const t = cleanHtml('<p>Hello<br>there <b>you</b> <script>alert(1)</script><div class="x">ok</div></p>');
  assert.ok(!/[<>]/.test(t)); assert.match(t, /Hello\nthere \*\*you\*\*/);
  assert.equal(cleanHtml('3 < 5 and 7 > 2'), '3 < 5 and 7 > 2');
});
