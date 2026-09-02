import { FmElement, el, button, wireDialogRestore } from '../dom.js';
import { highlightXml } from '../xml.js';

// The pilot client's log renderer and copy action, inside a dialog.
export class FmProtocolLog extends FmElement {
  build() {
    this.entries = [];

    this.dialog = el('dialog', { class: 'dialog dialog-wide', 'aria-labelledby': 'protocol-log-title' });
    this.log = el('div', { class: 'protocol-log', role: 'log', 'aria-live': 'off' });
    this.copyStatus = el('p', { class: 'copy-status', role: 'status' });

    this.copy = button('Copy log', { class: 'primary' });
    this.copy.addEventListener('click', () => {
      this.copyLog().catch(() => {
        this.copyStatus.textContent = 'The log could not be copied.';
      });
    });
    this.closeButton = button('Close', { class: 'secondary' });
    this.closeButton.addEventListener('click', () => this.dialog.close());

    this.dialog.append(
      el('div', { class: 'dialog-head' }, [
        el('h2', { id: 'protocol-log-title', text: 'Developer log' }),
        this.closeButton,
      ]),
      el('p', {
        class: 'caution',
        text: 'The log can contain authentication exchanges. Read it before you share it.',
      }),
      el('div', { class: 'dialog-actions' }, [this.copy]),
      this.copyStatus,
      this.log,
    );
    wireDialogRestore(this.dialog);
    this.append(this.dialog);

    document.addEventListener('fm-log', (event) => this.write(event.detail));
  }

  write({ label, timestamp, xml }) {
    this.entries.push({ label, timestamp, xml });
    const entry = el('section', { class: `protocol-entry protocol-${label.toLowerCase()}` });
    entry.append(el('div', { class: 'protocol-entry-heading', text: `[${timestamp}] ${label}` }));
    const stanza = el('div', { class: 'protocol-stanza' });
    highlightXml(stanza, xml);
    entry.append(stanza);
    this.log.append(entry);
    this.log.scrollTop = this.log.scrollHeight;
  }

  rawLog() {
    return this.entries
      .map(({ timestamp, label, xml }) => `[${timestamp}] ${label}\n${xml}`)
      .join('\n\n');
  }

  async copyLog() {
    const text = this.rawLog();
    if (!text) {
      this.copyStatus.textContent = 'The log is empty.';
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const temporary = el('textarea', { class: 'clipboard-fallback', readonly: '' });
      temporary.value = text;
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand('copy');
      temporary.remove();
      if (!copied) throw new Error('copy failed');
    }
    this.copyStatus.textContent = 'Log copied.';
  }

  update() {}
}

customElements.define('fm-protocol-log', FmProtocolLog);
