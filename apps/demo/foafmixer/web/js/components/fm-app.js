import { FmElement, el, button, request, openDialog, wireDialogRestore } from '../dom.js';
import './fm-sidebar.js';
import './fm-conversation.js';
import './fm-details.js';
import './fm-sign-in.js';
import './fm-channel-dialog.js';
import './fm-protocol-log.js';
import './fm-status.js';

const MOBILE_QUERY = '(max-width: 47.999rem)';

// Layout shell: regions, the mobile two-view stack, keyboard shortcuts, the
// theme attribute and the dialogs.
export class FmApp extends FmElement {
  build() {
    this.sidebar = document.createElement('fm-sidebar');
    this.conversation = document.createElement('fm-conversation');
    this.details = document.createElement('fm-details');
    this.signIn = document.createElement('fm-sign-in');
    this.channelDialog = document.createElement('fm-channel-dialog');
    this.protocolLog = document.createElement('fm-protocol-log');
    this.status = document.createElement('fm-status');

    this.nav = el('nav', { class: 'sidebar', 'aria-label': 'Channels' }, [this.sidebar]);
    this.main = el('main', { class: 'conversation', 'aria-labelledby': 'conversation-title' }, [this.conversation]);
    this.aside = el('aside', { class: 'details', 'aria-label': 'Channel details' }, [this.details]);
    this.scrim = el('div', { class: 'scrim', hidden: true });
    this.scrim.addEventListener('click', () => this.store.setDetailsOpen(false));

    this.shell = el('div', { class: 'shell', dataset: { view: 'channels' } }, [
      this.nav, this.main, this.aside, this.scrim,
    ]);

    this.switcher = this.buildSwitcher();

    this.append(this.shell, this.switcher, this.signIn, this.channelDialog, this.protocolLog, this.status);

    this.mobile = window.matchMedia(MOBILE_QUERY);
    this.mobile.addEventListener('change', () => this.update());

    document.addEventListener('keydown', (event) => this.onKeydown(event));
    window.addEventListener('popstate', () => {
      if (this.store.state.view === 'conversation') this.store.setView('channels');
    });
    document.addEventListener('fm-request', (event) => this.onRequest(event));
  }

  buildSwitcher() {
    const dialog = el('dialog', { class: 'dialog dialog-switcher', 'aria-labelledby': 'switcher-title' });
    this.switcherInput = el('input', {
      id: 'switcher-input',
      type: 'text',
      autocomplete: 'off',
      'data-1p-ignore': '',
      placeholder: 'Filter channels',
      'aria-controls': 'switcher-results',
      spellcheck: false,
    });
    this.switcherResults = el('ul', { id: 'switcher-results', class: 'switcher-results', role: 'listbox', 'aria-label': 'Channels' });
    this.switcherInput.addEventListener('input', () => this.renderSwitcher());
    this.switcherInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.switcherResults.querySelector('button')?.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.switcherResults.querySelector('button')?.click();
      }
    });
    dialog.append(
      el('div', { class: 'dialog-head' }, [el('h2', { id: 'switcher-title', text: 'Go to channel' })]),
      el('div', { class: 'field' }, [
        el('label', { class: 'sr-only', for: 'switcher-input', text: 'Filter channels' }),
        this.switcherInput,
      ]),
      this.switcherResults,
    );
    wireDialogRestore(dialog);
    return dialog;
  }

  renderSwitcher() {
    const filter = this.switcherInput.value.trim().toLowerCase();
    this.switcherResults.replaceChildren();
    const matches = this.store.state.channels.filter((channel) => (
      !filter || channel.jid.toLowerCase().includes(filter) || (channel.name || '').toLowerCase().includes(filter)
    ));
    if (!matches.length) {
      this.switcherResults.append(el('li', { class: 'switcher-empty', text: 'No channel matches that filter.' }));
      return;
    }
    for (const channel of matches) {
      const entry = button(channel.name || channel.jid.split('@')[0], { class: 'switcher-option' });
      entry.append(el('span', { class: 'switcher-jid', text: channel.jid }));
      entry.addEventListener('click', () => {
        this.switcher.close();
        this.openChannel(channel.jid);
      });
      this.switcherResults.append(el('li', { role: 'option', 'aria-selected': 'false' }, [entry]));
    }
  }

  onKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      if (this.store.state.status !== 'connected') return;
      this.switcherInput.value = '';
      this.renderSwitcher();
      openDialog(this.switcher, this.switcherInput);
      return;
    }
    if (event.key === 'Escape' && this.store.state.detailsOpen && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      this.store.setDetailsOpen(false);
    }
  }

  onRequest(event) {
    const { name } = event.detail;
    if (name === 'select-channel') this.openChannel(event.detail.jid);
    else if (name === 'back') this.goBack();
    else if (name === 'toggle-details') {
      const open = 'open' in event.detail ? event.detail.open : !this.store.state.detailsOpen;
      this.store.setDetailsOpen(open);
      if (open) this.details.querySelector('button')?.focus();
    } else if (name === 'open-channel-dialog') this.channelDialog.open();
    else if (name === 'open-log') openDialog(this.protocolLog.dialog, this.protocolLog.copy);
    else if (name === 'set-setting') this.store.setSetting(event.detail.key, event.detail.value);
  }

  openChannel(jid) {
    const wasList = this.store.state.view === 'channels';
    this.store.setActiveChannel(jid, { view: 'conversation' });
    if (this.mobile.matches && wasList) {
      history.pushState({ view: 'conversation' }, '');
    }
  }

  goBack() {
    if (this.mobile.matches && history.state?.view === 'conversation') {
      history.back();
    } else {
      this.store.setView('channels');
    }
  }

  update() {
    const state = this.store.state;
    const root = document.documentElement;
    if (state.settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.settings.theme);

    this.shell.dataset.view = state.view;
    this.shell.dataset.details = state.detailsOpen ? 'open' : 'closed';
    const overlay = !window.matchMedia('(min-width: 64rem)').matches;
    this.aside.hidden = !state.detailsOpen;
    this.scrim.hidden = !(state.detailsOpen && overlay);
    this.nav.hidden = false;
  }
}

customElements.define('fm-app', FmApp);
