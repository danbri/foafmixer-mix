import { el, linkify, initials, avatarHue, shortTime } from '../dom.js';

// One message row.  `data` is set before the element is appended.
export class FmMessage extends HTMLElement {
  set data(value) {
    this.message = value;
    this.render();
  }

  render() {
    const message = this.message;
    if (!message) return;
    this.replaceChildren();
    this.classList.toggle('is-own', Boolean(message.own));
    this.classList.toggle('is-pending', Boolean(message.pending));
    this.classList.toggle('is-grouped', Boolean(message.grouped));

    const date = new Date(message.timestamp);
    const gutter = el('div', { class: 'message-gutter' });
    if (message.grouped) {
      gutter.append(el('span', { class: 'message-gutter-time', 'aria-hidden': 'true', text: shortTime(date) }));
    } else {
      const key = message.senderJid || message.from || message.label;
      const avatar = el('span', {
        class: 'avatar',
        'aria-hidden': 'true',
        text: initials(message.nick || message.senderJid || message.label),
      });
      avatar.style.setProperty('--avatar-hue', String(avatarHue(key)));
      gutter.append(avatar);
    }

    const body = el('div', { class: 'message-body' });
    if (!message.grouped) {
      const head = el('div', { class: 'message-head' });
      head.append(el('span', { class: 'message-sender', text: message.nick || message.senderJid || message.label }));
      if (message.nick && message.senderJid) {
        head.append(el('span', { class: 'message-jid', text: message.senderJid }));
      }
      const time = el('time', { class: 'message-time', datetime: date.toISOString(), text: shortTime(date) });
      time.title = date.toLocaleString();
      head.append(time);
      body.append(head);
    }

    const text = el('p', { class: 'message-text' });
    linkify(text, message.text);
    body.append(text);

    if (message.pending) {
      const pending = el('p', { class: 'message-pending' });
      pending.append(el('span', { 'aria-hidden': 'true', text: '○' }));
      pending.append(el('span', { text: ' Sending' }));
      body.append(pending);
    }

    this.append(gutter, body);
  }
}

customElements.define('fm-message', FmMessage);
