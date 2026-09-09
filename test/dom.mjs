/**
 * The smallest document `markdown.js` can render into.
 *
 * Deliberately not jsdom, and deliberately missing `innerHTML`: the renderer is
 * only allowed to build nodes, so a document that cannot be handed a string of
 * markup proves that at run time rather than by review. If the renderer ever
 * reaches for one, the property lands on a plain object, never reaches
 * `serialize`, and the assertion about the missing content fails.
 *
 * `serialize` is the only code in the repository that turns a DOM tree into an
 * HTML string, and it escapes. That direction matters: the tests assert on what
 * the browser would have to parse to reproduce this tree, so a payload that
 * survived as text is visibly inert in the output.
 */

class El {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.textContent = '';
    this.children = [];
  }

  append(...nodes) { this.children.push(...nodes); }

  replaceChildren(...nodes) { this.children = nodes; }
}

export const doc = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => ({ text: String(text) }),
};

export const root = () => new El('div');

const escape = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const ATTRS = ['className', 'href', 'target', 'rel', 'start'];
const ATTR_NAME = { className: 'class' };
const VOID = new Set(['br', 'hr', 'img']);

export function serialize(node) {
  if (node.text != null) return escape(node.text);
  const attrs = ATTRS
    .filter((k) => node[k] != null && node[k] !== '')
    .map((k) => ` ${ATTR_NAME[k] ?? k}="${escape(node[k])}"`)
    .join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  const inner = node.children.length
    ? node.children.map(serialize).join('')
    : escape(node.textContent);
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/** Every element in the tree, so a test can ask what was actually built. */
export function walk(node, out = []) {
  if (node.text != null) return out;
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

export const hrefs = (node) => walk(node).filter((n) => n.href).map((n) => n.href);
export const tags = (node) => walk(node).map((n) => n.tag);
