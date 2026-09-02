import { FmElement, el } from '../dom.js';

const TOAST_MS = 6000;

// One polite and one assertive live region.  Both stay in the accessibility
// tree for the whole session; the visible toast is removed after six seconds.
export class FmStatus extends FmElement {
  build() {
    this.polite = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    this.assertive = el('div', { class: 'toast-stack', role: 'alert', 'aria-live': 'assertive' });
    this.append(this.polite, this.assertive);
    document.addEventListener('fm-toast', (event) => {
      this.show(event.detail.text, event.detail.tone || 'info');
    });
  }

  show(text, tone) {
    if (!text) return;
    const target = tone === 'error' ? this.assertive : this.polite;
    const toast = el('p', { class: `toast toast-${tone}`, text });
    target.append(toast);
    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 200);
    }, TOAST_MS);
  }
}

customElements.define('fm-status', FmStatus);
