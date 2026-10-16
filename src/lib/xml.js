// Minimal XML parser for DASH manifests: service workers have no DOMParser.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

/** @returns {{name: string, attrs: Record<string, string>, children: object[], text: string}} the document node */
export function parseXml(source) {
  const doc = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s>/!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(source))) {
    const current = stack[stack.length - 1];
    if (m[1] != null) {
      current.text += m[1];
    } else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: '' };
      current.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) {
      current.text += decode(m[6]);
    }
  }
  return doc;
}

const local = (name) => name.slice(name.indexOf(':') + 1);

export function children(el, name) {
  return el ? el.children.filter((c) => local(c.name) === name) : [];
}

export function child(el, name) {
  return el?.children.find((c) => local(c.name) === name) || null;
}
