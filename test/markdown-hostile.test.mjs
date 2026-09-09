/**
 * The renderer against input written to attack it.
 *
 * Everything this board displays was typed by a stranger into a public issue
 * tracker, and the owner opens it in a browser holding a Cloudflare Access
 * session that can approve posts to GitHub. Script execution here is not a
 * defacement, it is an authenticated write.
 *
 * These tests assert on `serialize` output — the HTML a browser would need to
 * parse to reproduce the tree that was actually built — because "no <script>
 * element exists" and "the characters `<script>` appear as text" are different
 * claims and only the second one is safe to make.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown, renderMarkdown, safeUrl } from '../web/markdown.js';
import { doc, root, serialize, hrefs, tags, walk } from './dom.mjs';

const render = (text, opts) => renderMarkdown(root(), text, { document: doc, ...opts });
const html = (text, opts) => serialize(render(text, opts));

/** Any `on…` property anywhere in the built tree — there should never be one. */
const handlerProps = (tree) =>
  walk(tree).flatMap((n) => Object.keys(n).filter((k) => /^on[a-z]/.test(k)));

test('a script tag is text, not an element', () => {
  const out = html('hello <script>alert(document.cookie)</script> there');
  assert.equal(tags(render('<script>alert(1)</script>')).includes('script'), false);
  assert.match(out, /&lt;script&gt;alert\(document.cookie\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /<script/);
});

test('an img onerror payload never becomes an element or an attribute', () => {
  const tree = render('<img src=x onerror="alert(1)">');
  assert.equal(tags(tree).includes('img'), false);
  assert.deepEqual(handlerProps(tree), [], 'nothing set an on* property on a node');
  // The characters are still shown — they are what the author wrote — but they
  // are shown, which is the entire difference.
  assert.match(serialize(tree), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('nested and malformed html survives as characters', () => {
  // The classic naive-stripper bypass: removing `<script>` once leaves one.
  const out = html('<<script>script>alert(1)<</script>/script>');
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<\/script/);
  assert.match(out, /&lt;&lt;script&gt;script&gt;/);
});

test('an unclosed tag does not swallow the rest of the body', () => {
  const tree = render('<div style="position:fixed;top:0" onclick="alert(1)"\n\nreal text below');
  assert.match(serialize(tree), /real text below/, 'an HTML parser would have eaten this');
  assert.deepEqual(tags(tree).filter((t) => t === 'div').length, 1, 'only the container');
  assert.deepEqual(handlerProps(tree), []);
});

test('javascript: link destinations are refused, and stay visible as text', () => {
  const tree = render('[click here](javascript:alert(1))');
  assert.deepEqual(hrefs(tree), [], 'no anchor at all');
  assert.match(serialize(tree), /\[click here\]\(javascript:alert\(1\)\)/,
    'refusing silently would leave the label looking like ordinary prose');
});

test('scheme rejection is case- and whitespace-insensitive', () => {
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), null);
  // A browser strips tabs and newlines out of a URL before deciding its scheme,
  // so the check has to be made on the stripped form.
  assert.equal(safeUrl('java\nscript:alert(1)'), null);
  assert.equal(safeUrl('java\tscript:alert(1)'), null);
  assert.equal(safeUrl('  javascript:alert(1)'), null);
  assert.equal(safeUrl('\u0000javascript:alert(1)'), null);
  assert.equal(safeUrl('vbscript:msgbox(1)'), null);
  assert.equal(safeUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(safeUrl('file:///etc/passwd'), null);
  assert.equal(safeUrl('//evil.test/x'), null, 'protocol-relative is not http(s)');
  assert.equal(safeUrl('/api/items'), null, 'a same-origin path is not a link either');
  assert.equal(safeUrl('https://github.test/x'), 'https://github.test/x');
  assert.equal(safeUrl('mailto:someone@example.test'), 'mailto:someone@example.test');
});

test('entity-encoded schemes are not decoded into live ones', () => {
  // Nothing in this path parses HTML, so `&#106;` is six characters. The test
  // exists because the usual place this bypass lands is a sanitiser that
  // decodes entities before checking the scheme.
  const tree = render('[x](&#106;avascript:alert(1))');
  assert.deepEqual(hrefs(tree), []);
  assert.match(serialize(tree), /&amp;#106;avascript:/);
});

test('a data: image is not rendered, and no img element is ever built', () => {
  const tree = render('![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
  assert.deepEqual(hrefs(tree), []);
  assert.equal(tags(render('![ok](https://evil.test/beacon.png)')).includes('img'), false,
    'even a well-formed image is a link: a remote fetch is a read receipt for the owner');
});

test('autolinked schemes are filtered too', () => {
  assert.deepEqual(hrefs(render('<javascript:alert(1)>')), []);
  assert.deepEqual(hrefs(render('<https://ok.test/a>')), ['https://ok.test/a']);
});

test('every link the renderer builds is http(s) or mailto, and opts out of referrer', () => {
  const body = [
    '[a](https://a.test) [b](javascript:1) <https://c.test> https://d.test',
    '@someone and #12 and other/repo#34',
    '![img](https://e.test/x.png)',
  ].join('\n\n');
  const anchors = walk(render(body, { repo: 'own/repo' })).filter((n) => n.href);
  assert.ok(anchors.length >= 6, `expected every reference to link, got ${anchors.length}`);
  for (const a of anchors) {
    assert.match(a.href, /^https:\/\//);
    assert.equal(a.rel, 'noopener noreferrer nofollow');
    assert.equal(a.target, '_blank');
  }
});

test('autolinked references cannot be steered off github.com', () => {
  // The href is built from a matched substring rather than from the raw text,
  // so the shape of the reference is fixed even when the text is not.
  const tree = render('@evil.test/x and evil.test/path#1 and @a/../../b', { repo: 'own/repo' });
  for (const href of hrefs(tree)) assert.match(href, /^https:\/\/github\.com\//);
  assert.equal(hrefs(tree).some((h) => h.includes('..')), false);
});

test('markdown inside a fenced block is shown, not interpreted', () => {
  const out = html('```\n<script>alert(1)</script>\n[x](javascript:1)\n```');
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<a /);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a fence that is never closed still terminates', () => {
  const blocks = parseMarkdown('text\n\n```\nunclosed forever');
  assert.equal(blocks.at(-1).type, 'code');
  assert.equal(blocks.at(-1).text, 'unclosed forever');
});

test('deeply nested and repetitive input terminates without blowing the stack', () => {
  // Bodies are capped at 8k by ingest, so length is bounded; nesting depth is
  // the dimension that is not, and a stack overflow here is a hung browser.
  for (const bomb of ['>'.repeat(4000), '> '.repeat(2000), '- '.repeat(2000),
    '*'.repeat(4000), '['.repeat(2000), '`'.repeat(2000), '#'.repeat(2000)]) {
    assert.doesNotThrow(() => html(bomb), `input starting ${bomb.slice(0, 4)} hung or threw`);
  }
});

test('the client never has an HTML-string sink to reach for', () => {
  // What makes every case above hold is structural, not per-payload: there is
  // no API in the client that parses a string as HTML. Asserted structurally,
  // because the next person to add a feature to app.js will not read this file.
  const SINKS = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\b/,
    /createContextualFragment/, /\beval\s*\(/, /new Function\s*\(/, /\bsrcdoc\b/];
  const web = path.join(import.meta.dirname, '..', 'web');
  for (const file of fs.readdirSync(web).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(web, file), 'utf8');
    for (const sink of SINKS) assert.doesNotMatch(src, sink, `${file} matches ${sink}`);
  }
});

test('deeply nested inline markup does not recurse without bound', () => {
  // The block cap did not cover this: emphasis and link labels both recurse
  // through parseInline, and the renderer then walks whatever tree comes out.
  // A comment is truncated at 2k on ingest, so that is the budget an attacker
  // has — and it is thousands of frames if nothing stops it.
  const payloads = {
    emphasis: '*'.repeat(2000) + 'x' + '*'.repeat(2000),
    labels: '['.repeat(2000) + 'x' + ']'.repeat(2000),
    // Prefixed deliberately. At the start of a line `~~~~` is a code fence, not
    // nested strikethrough, and the fence would swallow the payload before the
    // inline scanner ever saw it — which would make this test pass for the
    // wrong reason.
    strike: 'a ' + '~~'.repeat(1000) + 'x' + '~~'.repeat(1000),
    links: '[a](b'.repeat(400),
  };

  for (const [name, payload] of Object.entries(payloads)) {
    const out = render(payload);
    assert.ok(serialize(out).includes('x') || name === 'links',
      `${name}: the content is still shown`);
  }
});

test('the inline cap degrades to text rather than dropping content', () => {
  // Past the cap the remaining source is emitted verbatim. That is the property
  // worth pinning: a body that nests too deeply becomes less pretty, never less
  // complete, so nothing a person wrote can be made invisible by wrapping it in
  // enough asterisks.
  const deep = '*'.repeat(40) + 'findme' + '*'.repeat(40);
  assert.match(serialize(render(deep)), /findme/);
});

