// Protocol log pretty-printer and syntax highlighter.  Moved unchanged in
// behaviour from the pilot client's app.js.

function escapeXmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function serializeXmlNode(node, depth, lines) {
  const indent = '  '.repeat(depth);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const attributes = Array.from(node.attributes)
      .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
      .join('');
    const children = Array.from(node.childNodes)
      .filter((child) => child.nodeType !== Node.TEXT_NODE || child.nodeValue.trim());
    if (!children.length) {
      lines.push(`${indent}<${node.nodeName}${attributes}/>`);
      return;
    }
    if (children.every((child) => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE)) {
      const text = children.map((child) => escapeXmlText(child.nodeValue)).join('');
      lines.push(`${indent}<${node.nodeName}${attributes}>${text}</${node.nodeName}>`);
      return;
    }
    lines.push(`${indent}<${node.nodeName}${attributes}>`);
    for (const child of children) serializeXmlNode(child, depth + 1, lines);
    lines.push(`${indent}</${node.nodeName}>`);
  } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    if (node.nodeValue.trim()) lines.push(`${indent}${escapeXmlText(node.nodeValue)}`);
  } else if (node.nodeType === Node.COMMENT_NODE) {
    lines.push(`${indent}<!--${node.nodeValue}-->`);
  }
}

export function prettyXml(xml) {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) return xml;
  const lines = [];
  serializeXmlNode(parsed.documentElement, 0, lines);
  return lines.join('\n');
}

function addSyntaxSpan(parent, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.append(span);
}

function highlightXmlTag(parent, source) {
  const match = source.match(/^(<\/?)([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?>)$/);
  if (!match) {
    addSyntaxSpan(parent, 'xml-text', source);
    return;
  }
  addSyntaxSpan(parent, 'xml-punctuation', match[1]);
  addSyntaxSpan(parent, 'xml-tag', match[2]);
  const attributes = match[3];
  const attributePattern = /(\s+)([A-Za-z_][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
  let offset = 0;
  let attributeMatch;
  while ((attributeMatch = attributePattern.exec(attributes))) {
    parent.append(document.createTextNode(attributes.slice(offset, attributeMatch.index) + attributeMatch[1]));
    addSyntaxSpan(parent, 'xml-attribute', attributeMatch[2]);
    addSyntaxSpan(parent, 'xml-punctuation', attributeMatch[3]);
    addSyntaxSpan(parent, 'xml-value', attributeMatch[4]);
    offset = attributePattern.lastIndex;
  }
  parent.append(document.createTextNode(attributes.slice(offset)));
  addSyntaxSpan(parent, 'xml-punctuation', match[4]);
}

export function highlightXml(parent, xml) {
  for (const line of prettyXml(xml).split('\n')) {
    const row = document.createElement('div');
    row.className = 'xml-line';
    for (const segment of line.match(/<[^>]+>|[^<]+/g) || []) {
      if (segment.startsWith('<')) {
        highlightXmlTag(row, segment);
      } else {
        addSyntaxSpan(row, 'xml-text', segment);
      }
    }
    parent.append(row);
  }
}

export function stanzaToString(stanza) {
  if (typeof stanza === 'string') return stanza;
  if (stanza instanceof Node) return new XMLSerializer().serializeToString(stanza);
  return String(stanza);
}
