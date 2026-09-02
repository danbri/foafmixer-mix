import { FmElement, el, button, iconButton, request, initials, avatarHue } from '../dom.js';
import './fm-message-list.js';
import './fm-composer.js';

const AVATAR_STRIP_MAX = 5;

export class FmConversation extends FmElement {
  build() {
    this.back = iconButton('Back to channels', '←', { class: 'header-back' });
    this.back.addEventListener('click', () => request(this, 'back'));

    this.titleNode = el('h2', { class: 'channel-name', id: 'conversation-title' });
    this.count = el('span', { class: 'participant-count' });
    this.strip = el('span', { class: 'avatar-strip', 'aria-hidden': 'true' });

    this.detailsToggle = button('Details', { class: 'header-details', 'aria-expanded': 'false', 'aria-controls': 'channel-details' });
    this.detailsToggle.addEventListener('click', () => request(this, 'toggle-details'));

    this.header = el('header', { class: 'conversation-header' }, [
      this.back,
      el('div', { class: 'conversation-heading' }, [this.titleNode, this.count, this.strip]),
      this.detailsToggle,
    ]);

    this.list = document.createElement('fm-message-list');
    this.composer = document.createElement('fm-composer');
    this.append(this.header, this.list, this.composer);
  }

  update() {
    const channel = this.store.active;
    if (!channel) {
      this.titleNode.textContent = 'No channel open';
      this.count.textContent = '';
      this.strip.replaceChildren();
      this.detailsToggle.disabled = true;
      return;
    }
    this.detailsToggle.disabled = false;
    this.detailsToggle.setAttribute('aria-expanded', String(this.store.state.detailsOpen));
    this.titleNode.textContent = channel.name || channel.jid.split('@')[0];
    this.titleNode.title = channel.jid;
    const total = channel.participants.length;
    this.count.textContent = total === 0
      ? (channel.joined ? 'No participants listed' : 'Not joined')
      : `${total} participant${total === 1 ? '' : 's'}`;

    this.strip.replaceChildren();
    for (const participant of channel.participants.slice(0, AVATAR_STRIP_MAX)) {
      const key = participant.jid || participant.id || participant.label;
      const avatar = el('span', { class: 'avatar avatar-small', text: initials(participant.label) });
      avatar.style.setProperty('--avatar-hue', String(avatarHue(key)));
      this.strip.append(avatar);
    }
    if (total > AVATAR_STRIP_MAX) {
      this.strip.append(el('span', { class: 'avatar avatar-small avatar-more', text: `+${total - AVATAR_STRIP_MAX}` }));
    }
  }
}

customElements.define('fm-conversation', FmConversation);
