// Small DOM helpers shared by the components.  No framework, no templates:
// every node is built with createElement/textContent so untrusted text can
// never reach an HTML parser.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key in node && key !== 'list' && key !== 'form') node[key] = value;
    else if (value === false) continue;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(label, props = {}) {
  return el('button', { type: 'button', ...props, text: label });
}

export function iconButton(label, glyph, props = {}) {
  const node = el('button', { type: 'button', 'aria-label': label, title: label, ...props });
  node.append(el('span', { 'aria-hidden': 'true', text: glyph }));
  return node;
}

export function srOnly(text) {
  return el('span', { class: 'sr-only', text });
}

// Only http and https are turned into links.  Anything else stays text.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

export function linkify(parent, text) {
  let index = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > index) parent.append(document.createTextNode(text.slice(index, match.index)));
    let href = match[0];
    let trailing = '';
    // Trailing sentence punctuation is almost never part of the address.
    const trailingMatch = href.match(/[.,;:!?)\]}]+$/);
    if (trailingMatch) {
      trailing = trailingMatch[0];
      href = href.slice(0, href.length - trailing.length);
    }
    let safe = null;
    try {
      const parsed = new URL(href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safe = parsed.href;
    } catch (_) {
      safe = null;
    }
    if (safe) {
      parent.append(el('a', { href: safe, rel: 'noopener noreferrer', target: '_blank', text: href }));
    } else {
      parent.append(document.createTextNode(href));
    }
    if (trailing) parent.append(document.createTextNode(trailing));
    index = match.index + match[0].length;
  }
  if (index < text.length) parent.append(document.createTextNode(text.slice(index)));
}

export function initials(name) {
  const cleaned = String(name || '?').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic hue from the sender JID.  Saturation and lightness are fixed
// per theme in styles.css so every avatar sits in one tonal range and the
// initials keep their contrast whatever the hue.
export function avatarHue(key) {
  const text = String(key || '');
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function shortTime(date) {
  return TIME_FORMAT.format(date);
}

export function dayLabel(date) {
  const today = new Date();
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (date.getFullYear() === today.getFullYear()) return DAY_FORMAT.format(date);
  return DAY_YEAR_FORMAT.format(date);
}

export function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function localPart(jid) {
  const at = String(jid || '').indexOf('@');
  return at > 0 ? String(jid).slice(0, at) : String(jid || '');
}

export function bareJid(jid) {
  return String(jid || '').split('/')[0];
}

// Dialog focus management: remember the opener, move focus to the first
// sensible control, and put focus back when the dialog closes.
export function openDialog(dialog, initialFocus = null) {
  if (dialog.open) return;
  dialog.dataset.opener = '';
  dialog.__opener = document.activeElement;
  dialog.showModal();
  const target = initialFocus
    || dialog.querySelector('[autofocus]')
    || dialog.querySelector('input:not([type="hidden"]), textarea, select, button');
  target?.focus();
}

export function closeDialog(dialog) {
  if (!dialog.open) return;
  dialog.close();
}

export function wireDialogRestore(dialog) {
  dialog.addEventListener('close', () => {
    const opener = dialog.__opener;
    dialog.__opener = null;
    if (opener && document.contains(opener)) opener.focus();
  });
}

// --- component base ---------------------------------------------------------

import { store } from './store.js';

// Light-DOM custom element base.  Builds its subtree once, then re-renders
// from the store whenever the store emits `change`.
export class FmElement extends HTMLElement {
  connectedCallback() {
    this.store = store;
    if (!this.built) {
      this.build();
      this.built = true;
    }
    this.onStoreChange = () => this.update();
    store.addEventListener('change', this.onStoreChange);
    this.update();
  }

  disconnectedCallback() {
    if (this.onStoreChange) store.removeEventListener('change', this.onStoreChange);
  }

  build() {}

  update() {}
}

export function request(node, name, detail = {}) {
  node.dispatchEvent(new CustomEvent('fm-request', { detail: { name, ...detail }, bubbles: true }));
}

export function toast(text, tone = 'info') {
  document.dispatchEvent(new CustomEvent('fm-toast', { detail: { text, tone } }));
}
