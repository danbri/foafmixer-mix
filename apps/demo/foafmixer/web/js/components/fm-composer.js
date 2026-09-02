import { FmElement, el, request } from '../dom.js';

const MAX_ROWS_PX = 200;

export class FmComposer extends FmElement {
  build() {
    this.currentChannel = null;

    this.label = el('label', {
      class: 'sr-only',
      for: 'composer-input',
      text: 'Message',
    });
    this.input = el('textarea', {
      id: 'composer-input',
      rows: 1,
      'aria-describedby': 'composer-hint',
      'data-1p-ignore': '',
    });
    this.hint = el('p', { id: 'composer-hint', class: 'composer-hint' });
    this.send = el('button', { type: 'submit', class: 'composer-send', text: 'Send' });

    this.form = el('form', { class: 'composer' }, [
      this.label,
      el('div', { class: 'composer-row' }, [this.input, this.send]),
      this.hint,
    ]);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener('input', () => {
      this.autoGrow();
      this.store.setDraft(this.currentChannel, this.input.value);
    });
    this.input.addEventListener('keydown', (event) => this.onKeydown(event));
    this.append(this.form);
  }

  autoGrow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, MAX_ROWS_PX)}px`;
  }

  onKeydown(event) {
    if (event.key !== 'Enter') return;
    const modifier = event.metaKey || event.ctrlKey;
    const sendKey = this.store.state.settings.sendKey;
    if (sendKey === 'enter' && !event.shiftKey && !modifier) {
      event.preventDefault();
      this.submit();
    } else if (sendKey === 'modifier' && modifier) {
      event.preventDefault();
      this.submit();
    }
  }

  submit() {
    const text = this.input.value.trim();
    if (!text || this.input.disabled) return;
    request(this, 'send', { text });
    this.input.value = '';
    this.store.setDraft(this.currentChannel, '');
    this.autoGrow();
  }

  update() {
    const state = this.store.state;
    const channel = this.store.active;
    if (channel?.jid !== this.currentChannel) {
      this.currentChannel = channel?.jid || null;
      this.input.value = this.store.draft(this.currentChannel);
      this.autoGrow();
    }
    const ready = state.status === 'connected' && Boolean(channel) && channel.joined;
    this.input.disabled = !ready;
    this.send.disabled = !ready;
    if (state.status !== 'connected') {
      this.input.placeholder = 'Sign in to send messages.';
    } else if (!channel) {
      this.input.placeholder = 'Choose a channel to send messages.';
    } else if (!channel.joined) {
      this.input.placeholder = 'Join this channel to send messages.';
    } else {
      this.input.placeholder = `Message ${channel.name || channel.jid.split('@')[0]}`;
    }
    this.hint.textContent = state.settings.sendKey === 'enter'
      ? 'Enter sends. Shift and Enter start a new line.'
      : 'Ctrl and Enter, or Command and Enter, send. Enter starts a new line.';
  }
}

customElements.define('fm-composer', FmComposer);
