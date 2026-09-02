import { FmElement, el, request, openDialog, wireDialogRestore } from '../dom.js';
import { SUPPORTED_PORTS } from '../store.js';

export class FmSignIn extends FmElement {
  build() {
    this.dialog = el('dialog', { class: 'dialog dialog-signin', 'aria-labelledby': 'sign-in-title' });

    this.jid = el('input', {
      id: 'sign-in-jid',
      type: 'text',
      autocomplete: 'username',
      placeholder: 'alice@foafmixer.test',
      required: true,
      spellcheck: false,
      autocapitalize: 'none',
    });
    this.password = el('input', {
      id: 'sign-in-password',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
    });
    this.remember = el('input', { id: 'sign-in-remember', type: 'checkbox', checked: true, 'data-1p-ignore': '' });
    this.host = el('input', { id: 'sign-in-host', type: 'text', autocomplete: 'off', required: true, 'data-1p-ignore': '', spellcheck: false });
    this.port = el('select', { id: 'sign-in-port', required: true, 'data-1p-ignore': '' });
    for (const value of SUPPORTED_PORTS) {
      this.port.append(el('option', { value, text: `Port ${value}` }));
    }
    this.submit = el('button', { type: 'submit', class: 'primary', text: 'Sign in' });
    this.status = el('p', { class: 'form-status', role: 'status' });

    const advanced = el('details', { class: 'advanced' });
    advanced.append(
      el('summary', { text: 'Advanced' }),
      el('div', { class: 'field' }, [el('label', { for: 'sign-in-host', text: 'WebSocket host' }), this.host]),
      el('div', { class: 'field' }, [el('label', { for: 'sign-in-port', text: 'WebSocket port' }), this.port]),
    );

    this.form = el('form', { class: 'dialog-form' }, [
      el('div', { class: 'field' }, [el('label', { for: 'sign-in-jid', text: 'Your XMPP address' }), this.jid]),
      el('div', { class: 'field' }, [el('label', { for: 'sign-in-password', text: 'Password' }), this.password]),
      el('label', { class: 'checkbox' }, [
        this.remember,
        el('span', { text: 'Remember the connection details for 20 minutes. The password is never saved.' }),
      ]),
      advanced,
      this.status,
      el('div', { class: 'dialog-actions' }, [this.submit]),
    ]);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      request(this, 'sign-in', {
        jid: this.jid.value.trim(),
        password: this.password.value,
        host: this.host.value.trim(),
        port: this.port.value,
        remember: this.remember.checked,
      });
    });

    this.dialog.append(
      el('div', { class: 'dialog-head' }, [
        el('h1', { id: 'sign-in-title', text: 'Foafmixer' }),
      ]),
      el('p', { class: 'dialog-lede', text: 'A private XMPP MIX server for people and their bots.' }),
      this.form,
    );
    // Sign-in is the only way in, so Escape must not dismiss it.
    this.dialog.addEventListener('cancel', (event) => event.preventDefault());
    wireDialogRestore(this.dialog);
    this.append(this.dialog);
  }

  clearPassword() {
    this.password.value = '';
  }

  update() {
    const state = this.store.state;
    if (!this.jid.value && state.restoredJid) this.jid.value = state.restoredJid;
    if (!this.host.value) this.host.value = state.host;
    this.port.value = state.port;
    this.status.textContent = state.signInMessage;
    this.status.dataset.tone = state.signInTone;
    this.submit.disabled = state.status === 'connecting';
    this.submit.textContent = state.status === 'connecting' ? 'Signing in' : 'Sign in';

    if (state.status === 'disconnected') {
      if (!this.dialog.open) {
        this.password.value = '';
        openDialog(this.dialog, this.jid.value ? this.password : this.jid);
      }
    } else if (this.dialog.open && state.status === 'connected') {
      this.password.value = '';
      this.dialog.close();
    }
  }
}

customElements.define('fm-sign-in', FmSignIn);
