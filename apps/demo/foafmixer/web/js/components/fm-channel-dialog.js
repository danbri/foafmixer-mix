import { FmElement, el, request, openDialog, wireDialogRestore, localPart } from '../dom.js';
import { DEFAULT_SERVICE, DEFAULT_CHANNEL } from '../store.js';

export class FmChannelDialog extends FmElement {
  build() {
    this.dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'channel-dialog-title' });

    this.service = el('input', { id: 'channel-service', type: 'text', value: DEFAULT_SERVICE, required: true, 'data-1p-ignore': '', spellcheck: false });
    this.channel = el('input', { id: 'channel-name', type: 'text', value: DEFAULT_CHANNEL, required: true, 'data-1p-ignore': '', spellcheck: false });
    this.nick = el('input', { id: 'channel-nick', type: 'text', 'data-1p-ignore': '', spellcheck: false });
    this.status = el('p', { class: 'form-status', role: 'status' });

    this.join = el('button', { type: 'submit', class: 'primary', text: 'Join channel' });
    this.create = el('button', { type: 'button', class: 'secondary', text: 'Create channel' });
    this.cancel = el('button', { type: 'button', class: 'secondary', text: 'Cancel' });

    this.create.addEventListener('click', () => this.dispatch('create-and-join'));
    this.cancel.addEventListener('click', () => this.dialog.close());

    this.form = el('form', { class: 'dialog-form' }, [
      el('div', { class: 'field' }, [el('label', { for: 'channel-name', text: 'Channel' }), this.channel]),
      el('div', { class: 'field' }, [el('label', { for: 'channel-service', text: 'Service' }), this.service]),
      el('div', { class: 'field' }, [el('label', { for: 'channel-nick', text: 'Your name in the channel' }), this.nick]),
      this.status,
      el('div', { class: 'dialog-actions' }, [this.cancel, this.create, this.join]),
    ]);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.dispatch('join');
    });

    this.dialog.append(
      el('div', { class: 'dialog-head' }, [
        el('h2', { id: 'channel-dialog-title', text: 'Join or create a channel' }),
      ]),
      this.form,
    );
    wireDialogRestore(this.dialog);
    this.append(this.dialog);
  }

  dispatch(name) {
    const channel = this.channel.value.trim();
    const service = this.service.value.trim();
    if (!channel || !service) {
      this.status.textContent = 'Enter both a channel and a service.';
      this.status.dataset.tone = 'error';
      return;
    }
    this.status.textContent = name === 'join' ? 'Joining.' : 'Creating, then joining.';
    this.status.dataset.tone = 'info';
    request(this, name, {
      service,
      channel,
      nick: this.nick.value.trim() || localPart(this.store.state.jid || ''),
    });
  }

  open() {
    this.status.textContent = '';
    if (!this.nick.value) this.nick.value = localPart(this.store.state.jid || '');
    openDialog(this.dialog, this.channel);
  }

  close() {
    this.dialog.close();
  }

  setStatus(text, tone = 'info') {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
  }

  update() {}
}

customElements.define('fm-channel-dialog', FmChannelDialog);
