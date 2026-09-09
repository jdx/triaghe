/**
 * What the renderer is for: the markdown that actually shows up in issue
 * threads. The hostile cases live in markdown-hostile.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdown } from '../web/markdown.js';
import { doc, root, serialize, hrefs } from './dom.mjs';

const render = (text, opts) => renderMarkdown(root(), text, { document: doc, ...opts });
const html = (text, opts) => serialize(render(text, opts));

test('paragraphs, headings and rules', () => {
  const out = html('## Steps\n\nfirst para\n\n---\n\nsecond para');
  assert.match(out, /<h5 class="mdh">Steps<\/h5>/, 'body headings sit below the pane\'s own h2/h3');
  assert.match(out, /<p class="mdp">first para<\/p>/);
  assert.match(out, /<hr>/);
  assert.match(out, /second para/);
});

test('a single newline is a line break, the way GitHub renders one', () => {
  // Without this a bug report's numbered steps collapse into one line.
  const out = html('do this\nthen this\n\nand later that');
  assert.match(out, /do this<br>then this/);
  assert.equal(out.split('<p class="mdp">').length - 1, 2);
});

test('emphasis, strikethrough and code spans', () => {
  assert.match(html('**bold** and *em* and ~~gone~~'),
    /<strong>bold<\/strong> and <em>em<\/em> and <del>gone<\/del>/);
  assert.match(html('call `render(x)` first'),
    /<code class="mdcodespan">render\(x\)<\/code>/);
});

test('a code span wins over the emphasis inside it', () => {
  const out = html('`a * b * c` and `**not bold**`');
  assert.doesNotMatch(out, /<em>|<strong>/);
  assert.match(out, /a \* b \* c/);
});

test('underscores inside identifiers are not emphasis', () => {
  // snake_case is everywhere in the text this renders, and italicising half a
  // variable name was the first thing that looked wrong.
  const out = html('set body_truncated and last_human_at');
  assert.doesNotMatch(out, /<em>/);
  assert.match(out, /body_truncated and last_human_at/);
});

test('fenced code keeps its content verbatim, info string dropped', () => {
  const blocks = parseMarkdown('```js\nconst a = "**x**";\n  indented\n```');
  assert.deepEqual(blocks, [{ type: 'code', text: 'const a = "**x**";\n  indented' }]);
  assert.match(html('~~~\ntilde fence\n~~~'), /<pre class="mdcode">tilde fence<\/pre>/);
});

test('lists, nested and ordered', () => {
  const out = html('- one\n- two\n  - nested\n\n1. first\n2. second');
  assert.match(out, /<ul class="mdlist"><li>one<\/li><li>two<ul class="mdlist"><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(out, /<ol class="mdlist"><li>first<\/li><li>second<\/li><\/ol>/);
});

test('an ordered list keeps the number it started at', () => {
  const [list] = parseMarkdown('3. three\n4. four');
  assert.equal(list.start, 3);
  assert.match(html('3. three'), /start="3"/);
});

test('a list marker line that is really a rule stays a rule', () => {
  assert.deepEqual(parseMarkdown('- - -').map((b) => b.type), ['rule']);
  assert.deepEqual(parseMarkdown('***').map((b) => b.type), ['rule']);
});

test('blockquotes nest and take lazy continuations', () => {
  const out = html('> quoted\ncontinued\n\n> > deeper');
  assert.match(out, /<blockquote class="mdquote"><p class="mdp">quoted<br>continued<\/p><\/blockquote>/);
  assert.match(out, /<blockquote class="mdquote"><blockquote class="mdquote">/);
});

test('links: inline, autolinked and bare', () => {
  assert.match(html('[the docs](https://example.test/a)'),
    /<a class="mdlink" href="https:\/\/example.test\/a" target="_blank" rel="noopener noreferrer nofollow">the docs<\/a>/);
  assert.deepEqual(hrefs(render('see <https://example.test/b> or https://example.test/c')),
    ['https://example.test/b', 'https://example.test/c']);
});

test('a bare URL gives back the sentence punctuation after it', () => {
  assert.deepEqual(hrefs(render('fixed in https://example.test/pr/9.')), ['https://example.test/pr/9']);
});

test('link text is itself markdown, but does not autolink inside itself', () => {
  assert.match(html('[**bold** link](https://example.test)'), /<strong>bold<\/strong> link/);
  // Nested anchors are invalid HTML, and building nodes gets none of the parser
  // fixup that would otherwise paper over it.
  assert.deepEqual(hrefs(render('[@octocat, https://a.test](https://b.test)', { repo: 'x/y' })),
    ['https://b.test']);
});

test('@mentions link to the person, addresses do not', () => {
  assert.deepEqual(hrefs(render('thanks @octocat')), ['https://github.com/octocat']);
  assert.deepEqual(hrefs(render('mail ship@example.test')), [],
    'an address is not a mention — the same edge rule the server-side matcher uses');
});

test('#123 resolves against the thread it was written in', () => {
  assert.deepEqual(hrefs(render('fixes #42', { repo: 'jdx/mise' })),
    ['https://github.com/jdx/mise/issues/42']);
  assert.deepEqual(hrefs(render('see other/repo#7', { repo: 'jdx/mise' })),
    ['https://github.com/other/repo/issues/7']);
  assert.match(html('see other/repo#7', { repo: 'jdx/mise' }), />other\/repo#7</,
    'the qualifier is part of the link text, not left stranded before it');
});

test('#123 without a repo context stays plain text', () => {
  // The feed and any future caller that does not know the repo must not guess.
  assert.deepEqual(hrefs(render('fixes #42')), []);
  assert.match(html('fixes #42'), /fixes #42/);
});

test('a colour like #fff is not an issue reference', () => {
  assert.deepEqual(hrefs(render('use #fff', { repo: 'jdx/mise' })), []);
});

test('images render as labelled links', () => {
  const out = html('![a screenshot](https://example.test/s.png)');
  assert.match(out, /<a class="mdlink img" href="https:\/\/example.test\/s.png"/);
  assert.match(out, />a screenshot<\/a>/);
});

test('backslash escapes suppress the markup they precede', () => {
  const out = html('\\*not em\\* and \\`not code\\`');
  assert.doesNotMatch(out, /<em>|<code/);
  assert.match(out, /\*not em\* and `not code`/);
});

test('empty and whitespace-only input renders nothing at all', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown('\n\n   \n'), []);
});
