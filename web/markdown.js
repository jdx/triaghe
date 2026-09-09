/**
 * Markdown for text written by strangers.
 *
 * Every body and comment on this board came from the public internet, so this
 * parses to a plain-data tree and then builds DOM nodes from that tree. No HTML
 * string is produced anywhere in this file. That is the whole design: there is
 * no innerHTML for a payload to reach, and raw HTML inside the markdown is
 * never handed to an HTML parser — `<img onerror=…>` survives as the characters
 * the author typed and is displayed as those characters.
 *
 * Two halves so the security-relevant decisions can be tested without a DOM:
 * `parseMarkdown` is pure and returns data, `renderMarkdown` walks that data and
 * only ever calls createElement / createTextNode / textContent.
 *
 * The subset is what issue threads actually contain: fenced code, code spans,
 * headings, lists, blockquotes, emphasis, links, and GitHub's @mention and #123
 * autolinks. Anything unrecognised — tables, footnotes, raw HTML — falls through
 * to text rather than to a second, looser parser.
 */

/**
 * Nesting cap for blockquotes and lists. Ingest already truncates bodies (8k for
 * items, 2k for comments), so length is bounded, but 2k of `>>>>>>…` is not:
 * recursion depth is the one input dimension that stays unbounded, and blowing
 * the stack here hangs the owner's browser. Past the cap the remaining text is
 * shown as paragraphs, which is degraded but still readable.
 */
const MAX_DEPTH = 8;

/* ---------- block grammar ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*(?:\s#+)?\s*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^([ ]*)([-*+]|\d{1,9}[.)])(?:[ ]+(.*))?$/;

const isBlockStart = (line) =>
  FENCE.test(line) || RULE.test(line) || HEADING.test(line)
  || QUOTE.test(line) || ITEM.test(line);

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

/** @returns {Array} block nodes; see the type strings below for the shapes. */
export function parseMarkdown(text, opts = {}) {
  if (text == null || text === '') return [];
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    // Leading tabs only, so indentation is comparable as a character count.
    // Tabs inside a line are content and are left alone.
    .replace(/^\t+/gm, (t) => '    '.repeat(t.length))
    .split('\n');
  return parseBlocks(lines, { repo: opts.repo ?? null, depth: 0 });
}

function parseBlocks(lines, ctx) {
  if (ctx.depth > MAX_DEPTH) {
    return [{ type: 'paragraph', children: parseInline(lines.join('\n'), ctx) }];
  }
  const deeper = { ...ctx, depth: ctx.depth + 1 };
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      // The info string (```js) is dropped rather than becoming a class name:
      // it is attacker-controlled, and no highlighting reads it.
      const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}[ \t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or one past the end when it was never closed
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    // Before ITEM: `- - -` and `***` match both, and a rule is the older claim.
    if (RULE.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2] ?? '', ctx),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        if (QUOTE.test(lines[i])) { inner.push(lines[i].replace(QUOTE, '')); i++; continue; }
        // Lazy continuation: an unprefixed line still belongs to the quote's
        // current paragraph, which is how most people actually type them.
        if (inner.length && lines[i].trim() && !isBlockStart(lines[i])) { inner.push(lines[i]); i++; continue; }
        break;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner, deeper) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const baseIndent = item[1].length;
      const items = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || RULE.test(lines[i])) break;
        // A different marker family or a different indent is a different list.
        if (m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + 1;
        const chunk = [m[3] ?? ''];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            // A blank line ends the item unless indented content follows it,
            // which is what makes multi-paragraph and nested-list items work.
            const next = lines[i + 1];
            if (next && next.trim() && indentOf(next) >= contentIndent) { chunk.push(''); i++; continue; }
            break;
          }
          if (indentOf(lines[i]) >= contentIndent) { chunk.push(lines[i].slice(contentIndent)); i++; continue; }
          if (isBlockStart(lines[i])) break;
          chunk.push(lines[i]); // lazy continuation of the item's paragraph
          i++;
        }
        items.push(parseBlocks(chunk, deeper));
      }
      blocks.push({
        type: 'list',
        ordered,
        start: ordered ? Number.parseInt(item[2], 10) : null,
        items,
      });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    // Only reachable if `isBlockStart` disagrees with the dispatch above. It
    // does not today; the guard is here because the cost of being wrong is an
    // infinite loop in the owner's browser rather than a misrendered list.
    if (!para.length) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n'), ctx) });
  }

  return blocks;
}

/* ---------- inline grammar ---------- */

// Sticky, so the scanner matches at a position instead of re-slicing the string
// on every character.
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!~>|])/y;
const CODE_SPAN = /(`+)([^]*?)\1(?!`)/y;
// Label only. The destination cannot be expressed as a regex because it may
// contain balanced parentheses — see readDestination.
const LABEL = /(!?)\[([^\]]*)\]\(/y;
const AUTOLINK = /<([A-Za-z][A-Za-z\d+.-]*:[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/y;
// GitHub's own login rule: alphanumerics and single internal hyphens, max 39.
const MENTION = /@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})/y;
const ISSUE_NUM = /#(\d{1,9})(?![\w-])/y;
const REPO_TAIL = /(?:^|[\s([])([A-Za-z\d][\w.-]*\/[\w.-]+)$/;

/**
 * Read a link destination starting just after the `(`.
 *
 * A regex cannot do this. `[docs](https://en.wikipedia.org/wiki/Function_(mathematics))`
 * is an ordinary Wikipedia link and extremely common in GitHub Markdown, but
 * any `[^\s)]*` destination stops at the first `)` and leaves the whole thing
 * as literal text. CommonMark's rule is that unescaped parentheses are allowed
 * while they stay balanced, so this counts them.
 *
 * The depth cap is not politeness: the counter is driven by attacker-controlled
 * input, and without it `(((((…` merely runs long, but with a cap the scan is
 * bounded by the string it is already walking.
 *
 * `MAX_DEST` is what keeps the whole parse linear. A failed candidate returns
 * null and the caller advances one character, so an unbounded scan makes
 * `[a](<` repeated to fill a body quadratic: every `[` walks the entire
 * remainder before giving up. Bounding one scan bounds the product. 2 KB is
 * past any address anyone will paste and far below the point where n·MAX_DEST
 * is noticeable.
 *
 * @returns {{ dest: string, end: number } | null} `end` is the index after `)`.
 */
const MAX_DEST = 2048;

function readDestination(text, start) {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;

  const limit = Math.min(text.length, i + MAX_DEST);
  let dest = '';
  let depth = 0;

  // The <...> form takes anything except a newline or an unescaped '>'.
  if (text[i] === '<') {
    i++;
    while (i < limit && text[i] !== '>' && text[i] !== '\n') {
      if (text[i] === '\\' && i + 1 < limit) { dest += text[++i]; i++; continue; }
      dest += text[i++];
    }
    if (text[i] !== '>') return null;
    i++;
  } else {
    for (; i < limit; i++) {
      const c = text[i];
      if (c === '\\' && i + 1 < text.length) { dest += text[++i]; continue; }
      if (c === '(') {
        if (++depth > MAX_DEPTH) return null;
        dest += c;
        continue;
      }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        dest += c;
        continue;
      }
      // Whitespace ends the destination; a title may follow.
      if (/\s/.test(c)) break;
      dest += c;
    }
    if (depth !== 0) return null;
  }

  while (i < text.length && /[ \t]/.test(text[i])) i++;

  // Optional title, in any of the three delimiters CommonMark allows. Bounded
  // for the same reason the destination is: an unclosed quote is the same
  // quadratic shape as an unclosed angle bracket, just one branch further in.
  const titleLimit = Math.min(text.length, i + MAX_DEST);
  const open = text[i];
  if (open === '"' || open === "'" || open === '(') {
    const close = open === '(' ? ')' : open;
    i++;
    while (i < titleLimit && text[i] !== close) {
      if (text[i] === '\\') i++;
      i++;
    }
    if (text[i] !== close) return null;
    i++;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
  }

  if (text[i] !== ')') return null;
  return { dest, end: i + 1 };
}

/** @returns {Array} inline nodes: text, code, link, strong, em, strike, break. */
export function parseInline(text, ctx = {}) {
  // Inline nesting is capped separately from block nesting.
  //
  // The block cap alone left this open: emphasis and link labels both recurse
  // through here, and the renderer's `fill` then walks whatever tree comes out.
  // A 2k comment of `*`-runs or `[[[[[…` is a few thousand frames deep, and
  // whether that overflows is a property of the engine rather than of anything
  // this file controls. Past the cap the remaining text is emitted verbatim,
  // which is degraded but never wrong.
  const depth = ctx.inlineDepth ?? 0;
  if (depth > MAX_DEPTH) return text ? [{ type: 'text', text }] : [];
  const nested = { ...ctx, inlineDepth: depth + 1 };
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  const push = (node) => { flush(); out.push(node); };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const before = i > 0 ? text[i - 1] : '';

    if (c === '\\') {
      const m = matchAt(ESCAPE, text, i);
      if (m) { buf += m[1]; i += m[0].length; continue; }
    }

    if (c === '`') {
      const m = matchAt(CODE_SPAN, text, i);
      if (m) {
        // One space is stripped from each end when both are present, so
        // `` ` `` renders a backtick rather than a padded one.
        const inner = /^ [^]*[^ ]/.test(m[2]) && m[2].endsWith(' ') ? m[2].slice(1, -1) : m[2];
        push({ type: 'code', text: inner });
        i += m[0].length;
        continue;
      }
    }

    if (c === '!' || c === '[') {
      const m = matchAt(LABEL, text, i);
      const dest = m && readDestination(text, i + m[0].length);
      if (m && dest) {
        const isImage = m[1] === '!';
        const label = m[2];
        const raw = text.slice(i, dest.end);
        const href = safeUrl(dest.dest);
        if (href && isImage) {
          // Images are rendered as links, deliberately. The CSP has no remote
          // img-src so an <img> would render broken anyway, and the reason the
          // CSP says that is that a remote image in a stranger's issue is a
          // read receipt for the maintainer's IP address. A link is opt-in.
          push({ type: 'link', href, image: true, children: [{ type: 'text', text: label || href }] });
          i = dest.end;
          continue;
        }
        if (href) {
          // `inLink` stops the label's own `@name` or bare URL from autolinking
          // inside the anchor: nested <a> is invalid, and appending elements
          // gets no parser fixup to rescue it the way innerHTML would.
          push({ type: 'link', href, children: parseInline(label, { ...nested, inLink: true }) });
          i = dest.end;
          continue;
        }
        // A rejected destination is not silently dropped: the label and the URL
        // both stay visible as text, so `[click here](javascript:…)` reads as
        // what it is instead of looking like an ordinary word.
        push({ type: 'text', text: raw });
        i = dest.end;
        continue;
      }
    }

    if (c === '<' && !ctx.inLink) {
      const m = matchAt(AUTOLINK, text, i);
      if (m) {
        const href = safeUrl(m[1]);
        push(href
          ? { type: 'link', href, children: [{ type: 'text', text: m[1] }] }
          : { type: 'text', text: m[0] });
        i += m[0].length;
        continue;
      }
    }

    const emph = emphasisAt(text, i);
    if (emph) {
      push({ type: emph.type, children: parseInline(emph.inner, nested) });
      i += emph.len;
      continue;
    }

    // `ship@example.com` is an address, not a mention — same edge rule the
    // server-side owner matcher uses.
    if (c === '@' && !ctx.inLink && !/[\w/]/.test(before)) {
      const m = matchAt(MENTION, text, i);
      if (m) {
        push({ type: 'link', href: `https://github.com/${m[1]}`, mention: true, children: [{ type: 'text', text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    if (c === '#' && !ctx.inLink) {
      const m = matchAt(ISSUE_NUM, text, i);
      // `owner/repo#12` is already in the buffer by the time the scanner reaches
      // the `#`, so the qualifier is recovered from behind rather than given its
      // own trigger character.
      const qualified = m ? REPO_TAIL.exec(buf) : null;
      const repo = qualified ? qualified[1] : ctx.repo;
      if (m && repo && (qualified || !/[\w/]/.test(before))) {
        if (qualified) buf = buf.slice(0, buf.length - qualified[1].length);
        push({
          type: 'link',
          href: `https://github.com/${repo}/issues/${m[1]}`,
          children: [{ type: 'text', text: (qualified ? qualified[1] : '') + m[0] }],
        });
        i += m[0].length;
        continue;
      }
    }

    if (c === 'h' && !ctx.inLink && !/[\w@/]/.test(before)) {
      const m = matchAt(BARE_URL, text, i);
      if (m) {
        // Trailing sentence punctuation belongs to the prose, not the URL.
        const url = m[0].replace(/[.,;:!?'"]+$/, '');
        const href = safeUrl(url);
        if (href) {
          push({ type: 'link', href, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if (c === '\n') {
      // GitHub renders a single newline inside a comment as a line break.
      // Dropping them turns a bug report's numbered steps into one paragraph.
      push({ type: 'break' });
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

function matchAt(re, text, i) {
  re.lastIndex = i;
  return re.exec(text);
}

/**
 * Emphasis by nearest matching delimiter rather than by CommonMark's flanking
 * rules. It gets `**bold**`, `*em*` and `~~strike~~` right, and where it differs
 * it under-matches — the delimiter shows up as a literal asterisk, which is a
 * cosmetic loss on text nobody controls the formatting of anyway.
 */
function emphasisAt(text, i) {
  const two = text.slice(i, i + 2);
  if (two === '**' || two === '__' || two === '~~') {
    const close = text.indexOf(two, i + 2);
    if (close > i + 2) {
      return { len: close + 2 - i, type: two === '~~' ? 'strike' : 'strong', inner: text.slice(i + 2, close) };
    }
    return null;
  }

  const c = text[i];
  if (c !== '*' && c !== '_') return null;
  // snake_case identifiers are everywhere in this text; an underscore touching
  // a word character is part of a name, not a delimiter.
  if (c === '_' && /\w/.test(text[i - 1] ?? '')) return null;
  if (/[\s*_]/.test(text[i + 1] ?? '')) return null;
  const close = text.indexOf(c, i + 1);
  if (close <= i + 1) return null;
  if (/\s/.test(text[close - 1])) return null;
  if (c === '_' && /\w/.test(text[close + 1] ?? '')) return null;
  return { len: close + 1 - i, type: 'em', inner: text.slice(i + 1, close) };
}

/**
 * The only place a URL becomes a link.
 *
 * Allowlist, not a blocklist: http, https and mailto are the schemes that can
 * appear in a GitHub thread, and everything else — `javascript:`, `data:`,
 * `vbscript:`, relative paths, bare fragments — comes back null and is rendered
 * as text.
 *
 * The test runs on a copy with control characters removed because a browser
 * strips tabs and newlines from a URL before deciding what scheme it is:
 * `java\nscript:alert(1)` is a javascript: URL to the browser, and would sail
 * past a prefix test done on the raw string. The stripped copy is what gets
 * used, so what was checked is what is assigned.
 */
export function safeUrl(raw) {
  const url = String(raw ?? '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  return /^(?:https?:|mailto:)/i.test(url) ? url : null;
}

/* ---------- rendering ---------- */

/**
 * Appends `text` to `container` as DOM. `opts.repo` qualifies bare `#123`
 * references; `opts.document` exists so tests can drive this exact code path
 * against a document that has no innerHTML to reach for.
 */
export function renderMarkdown(container, text, opts = {}) {
  const doc = opts.document ?? globalThis.document;
  for (const block of parseMarkdown(text, opts)) container.append(renderBlock(doc, block, opts));
  return container;
}

function mk(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function anchor(doc, node) {
  const a = mk(doc, 'a', node.image ? 'mdlink img' : node.mention ? 'mdlink at' : 'mdlink');
  a.href = node.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  return a;
}

function renderBlock(doc, block, opts) {
  switch (block.type) {
    case 'code':
      return mk(doc, 'pre', 'mdcode', block.text);
    case 'rule':
      return mk(doc, 'hr');
    case 'heading': {
      // Capped at h4: the detail pane's own headings are h2/h3, and a body that
      // opens with `# ` should not outrank the item's title.
      const h = mk(doc, `h${Math.min(block.level + 3, 6)}`, 'mdh');
      return fill(doc, h, block.children, opts);
    }
    case 'blockquote': {
      const q = mk(doc, 'blockquote', 'mdquote');
      for (const child of block.children) q.append(renderBlock(doc, child, opts));
      return q;
    }
    case 'list': {
      const list = mk(doc, block.ordered ? 'ol' : 'ul', 'mdlist');
      if (block.ordered && block.start > 1) list.start = block.start;
      for (const item of block.items) {
        const li = mk(doc, 'li');
        // The item's opening paragraph goes straight into the <li>, so a list
        // with a nested list under one entry still reads as a tight list rather
        // than growing a paragraph's worth of space around that one entry.
        const rest = item[0]?.type === 'paragraph'
          ? (fill(doc, li, item[0].children, opts), item.slice(1))
          : item;
        for (const child of rest) li.append(renderBlock(doc, child, opts));
        list.append(li);
      }
      return list;
    }
    default:
      return fill(doc, mk(doc, 'p', 'mdp'), block.children, opts);
  }
}

/**
 * Unreachable today, and kept anyway.
 *
 * `parseInline` caps depth, and every tree that reaches here came from it, so
 * this limit cannot currently trigger — there is no test for it because there
 * is no input that produces it. It stays because the two caps protect the same
 * stack from opposite ends: raise MAX_DEPTH, add a nesting inline type, or
 * export a tree-taking entry point, and this is what stops that change from
 * being a browser hang rather than a rendering bug.
 *
 * Past the cap the subtree is flattened to its text, so nothing leaves the
 * page — only its formatting does.
 */
function fill(doc, parent, children, opts, depth = 0) {
  if (depth > MAX_DEPTH * 2) {
    parent.append(doc.createTextNode(flatten(children)));
    return parent;
  }
  const down = (el, node) => fill(doc, el, node.children, opts, depth + 1);
  for (const node of children) {
    switch (node.type) {
      case 'text': parent.append(doc.createTextNode(node.text)); break;
      case 'break': parent.append(mk(doc, 'br')); break;
      case 'code': parent.append(mk(doc, 'code', 'mdcodespan', node.text)); break;
      case 'link': parent.append(down(anchor(doc, node), node)); break;
      case 'strong': parent.append(down(mk(doc, 'strong'), node)); break;
      case 'em': parent.append(down(mk(doc, 'em'), node)); break;
      case 'strike': parent.append(down(mk(doc, 'del'), node)); break;
      // No default: an unknown inline type is a bug in this file, and dropping
      // it is better than guessing at an element for it.
    }
  }
  return parent;
}

/** Text of an inline subtree, iteratively — the point here is to not recurse. */
function flatten(children) {
  let out = '';
  const stack = [...children].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.text) out += node.text;
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}
