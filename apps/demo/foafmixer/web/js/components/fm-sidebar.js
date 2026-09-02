import { FmElement, el, button, iconButton, request, initials, avatarHue, bareJid, localPart } from '../dom.js';

export class FmSidebar extends FmElement {
  build() {
    this.optionByJid = new Map();

    this.accountAvatar = el('span', { class: 'avatar', 'aria-hidden': 'true', text: '?' });
    this.accountJid = el('span', { class: 'account-jid', text: 'Not signed in' });
    this.connectionDot = el('span', { class: 'dot', 'aria-hidden': 'true' });
    this.connectionText = el('span', { class: 'account-state' });

    this.menuButton = iconButton('Account and settings', '\u22ef', {
      class: 'account-menu-button',
      'aria-expanded': 'false',
      'aria-controls': 'account-menu',
    });
    this.menuButton.addEventListener('click', () => this.toggleMenu());

    this.menu = this.buildMenu();

    const account = el('div', { class: 'account' }, [
      this.accountAvatar,
      el('div', { class: 'account-lines' }, [
        this.accountJid,
        el('span', { class: 'account-status' }, [this.connectionDot, this.connectionText]),
      ]),
      this.menuButton,
    ]);

    this.listbox = el('ul', {
      class: 'channel-list',
      role: 'listbox',
      'aria-label': 'Channels',
      tabindex: '-1',
    });
    this.listbox.addEventListener('keydown', (event) => this.onListKeydown(event));

    this.emptyList = el('p', { class: 'channel-empty', text: 'No channels yet.' });

    this.joinButton = button('Join or create a channel', { class: 'primary join-button' });
    this.joinButton.addEventListener('click', () => request(this, 'open-channel-dialog'));

    this.append(
      account,
      this.menu,
      el('h2', { class: 'sidebar-heading', id: 'channels-heading', text: 'Channels' }),
      this.listbox,
      this.emptyList,
      this.joinButton,
    );

    document.addEventListener('pointerdown', (event) => {
      if (this.menu.hidden) return;
      if (this.menu.contains(event.target) || this.menuButton.contains(event.target)) return;
      this.closeMenu();
    });
    this.menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closeMenu();
        this.menuButton.focus();
      }
    });
  }

  buildMenu() {
    const menu = el('div', { class: 'account-menu', id: 'account-menu', hidden: true });

    const themeGroup = el('fieldset', { class: 'menu-group' });
    themeGroup.append(el('legend', { text: 'Theme' }));
    this.themeInputs = {};
    for (const [value, label] of [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']]) {
      const input = el('input', { type: 'radio', name: 'fm-theme', value, 'data-1p-ignore': '' });
      input.addEventListener('change', () => request(this, 'set-setting', { key: 'theme', value }));
      this.themeInputs[value] = input;
      themeGroup.append(el('label', { class: 'menu-choice' }, [input, el('span', { text: label })]));
    }

    const sendGroup = el('fieldset', { class: 'menu-group' });
    sendGroup.append(el('legend', { text: 'Send a message with' }));
    this.sendInputs = {};
    for (const [value, label] of [['enter', 'Enter'], ['modifier', 'Ctrl or Command and Enter']]) {
      const input = el('input', { type: 'radio', name: 'fm-send-key', value, 'data-1p-ignore': '' });
      input.addEventListener('change', () => request(this, 'set-setting', { key: 'sendKey', value }));
      this.sendInputs[value] = input;
      sendGroup.append(el('label', { class: 'menu-choice' }, [input, el('span', { text: label })]));
    }

    this.logButton = button('Developer log', { class: 'menu-item' });
    this.logButton.addEventListener('click', () => {
      this.closeMenu();
      request(this, 'open-log');
    });
    this.signOutButton = button('Sign out', { class: 'menu-item' });
    this.signOutButton.addEventListener('click', () => {
      this.closeMenu();
      request(this, 'sign-out');
    });

    menu.append(themeGroup, sendGroup, this.logButton, this.signOutButton);
    return menu;
  }

  toggleMenu() {
    if (this.menu.hidden) {
      this.menu.hidden = false;
      this.menuButton.setAttribute('aria-expanded', 'true');
      this.menu.querySelector('input, button')?.focus();
    } else {
      this.closeMenu();
    }
  }

  closeMenu() {
    this.menu.hidden = true;
    this.menuButton.setAttribute('aria-expanded', 'false');
  }

  onListKeydown(event) {
    const options = Array.from(this.listbox.querySelectorAll('[role="option"]'));
    if (!options.length) return;
    const current = options.findIndex((option) => option === document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = Math.min(options.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      if (current >= 0) {
        event.preventDefault();
        options[current].click();
      }
      return;
    }
    if (next === null) return;
    event.preventDefault();
    for (const option of options) option.tabIndex = -1;
    options[next].tabIndex = 0;
    options[next].focus();
  }

  update() {
    const state = this.store.state;
    const jid = state.jid || state.restoredJid || null;
    this.accountAvatar.textContent = jid ? initials(localPart(jid)) : '?';
    this.accountAvatar.style.setProperty('--avatar-hue', String(avatarHue(jid || 'anonymous')));
    this.accountJid.textContent = jid ? bareJid(jid) : 'Not signed in';
    const label = state.status === 'connected' ? 'Connected'
      : state.status === 'connecting' ? 'Connecting' : 'Not connected';
    const detail = state.status === 'connected' ? 'Connected to the XMPP server'
      : state.status === 'connecting' ? 'Connecting to the XMPP server'
        : 'Not connected to the XMPP server';
    this.connectionDot.dataset.state = state.status;
    this.connectionText.textContent = label;
    this.connectionText.title = detail;
    this.signOutButton.disabled = state.status === 'disconnected';
    this.themeInputs[state.settings.theme].checked = true;
    this.sendInputs[state.settings.sendKey].checked = true;

    this.joinButton.disabled = state.status !== 'connected';

    const filter = (this.filterText || '').trim().toLowerCase();
    const channels = state.channels.filter((channel) => (
      !filter || channel.jid.toLowerCase().includes(filter)
        || (channel.name || '').toLowerCase().includes(filter)
    ));
    this.emptyList.hidden = channels.length > 0;
    this.emptyList.textContent = state.channels.length
      ? 'No channel matches that filter.'
      : 'No channels yet. Join or create one to start.';

    this.listbox.replaceChildren();
    this.optionByJid.clear();
    let hasFocusable = false;
    for (const channel of channels) {
      const selected = channel.jid === state.activeChannel;
      const option = el('li', {
        class: 'channel-option',
        role: 'option',
        'aria-selected': String(selected),
        tabindex: selected ? '0' : '-1',
        dataset: { jid: channel.jid },
      });
      if (selected) hasFocusable = true;
      option.append(el('span', { class: 'channel-option-name', text: channel.name || channel.jid.split('@')[0] }));
      const meta = el('span', { class: 'channel-option-meta' });
      if (!channel.joined) meta.append(el('span', { class: 'channel-flag', text: 'Not joined' }));
      if (channel.unread > 0) {
        meta.append(el('span', {
          class: 'badge',
          text: String(channel.unread),
          'aria-label': `${channel.unread} unread message${channel.unread === 1 ? '' : 's'}`,
        }));
      }
      option.append(meta);
      option.addEventListener('click', () => request(this, 'select-channel', { jid: channel.jid }));
      this.listbox.append(option);
      this.optionByJid.set(channel.jid, option);
    }
    if (!hasFocusable) {
      this.listbox.querySelector('[role="option"]')?.setAttribute('tabindex', '0');
    }
  }

  setFilter(text) {
    this.filterText = text;
    this.update();
  }

  focusList() {
    const option = this.listbox.querySelector('[role="option"][tabindex="0"]')
      || this.listbox.querySelector('[role="option"]');
    option?.focus();
  }
}

customElements.define('fm-sidebar', FmSidebar);
