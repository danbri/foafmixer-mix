import { FmElement, el, button, request, dayKey, dayLabel } from '../dom.js';
import { GROUPING_WINDOW_MS } from '../store.js';
import './fm-message.js';

export class FmMessageList extends FmElement {
  build() {
    this.announced = null;
    this.renderedChannel = null;

    this.earlier = button('Load earlier messages', { class: 'earlier-button' });
    this.earlier.addEventListener('click', () => request(this, 'load-history'));
    this.earlierRow = el('div', { class: 'earlier-row' }, [this.earlier]);

    this.list = el('div', {
      class: 'timeline',
      role: 'log',
      'aria-label': 'Messages',
      'aria-live': 'off',
    });

    this.empty = el('p', { class: 'timeline-empty', text: 'No messages yet. Say hello.' });

    this.scroller = el('div', { class: 'timeline-scroller', tabindex: '0' }, [
      this.earlierRow, this.list, this.empty,
    ]);
    this.scroller.addEventListener('scroll', () => this.onScroll());

    this.jump = button('Jump to latest', { class: 'jump-button', hidden: true });
    this.jump.addEventListener('click', () => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.jump.hidden = true;
    });

    this.announcer = el('p', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

    this.append(this.scroller, this.jump, this.announcer);
  }

  atBottom() {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
  }

  onScroll() {
    this.jump.hidden = this.atBottom();
  }

  update() {
    const channel = this.store.active;
    const wasAtBottom = this.atBottom();
    const channelChanged = this.renderedChannel !== (channel?.jid || null);
    this.renderedChannel = channel?.jid || null;

    this.list.replaceChildren();
    if (!channel) {
      this.earlierRow.hidden = true;
      this.empty.hidden = false;
      this.empty.textContent = 'Choose a channel to read its messages.';
      this.jump.hidden = true;
      return;
    }

    this.earlierRow.hidden = channel.historyComplete && channel.messages.length > 0;
    this.earlier.disabled = channel.historyLoading || !channel.joined;
    this.earlier.textContent = channel.historyLoading
      ? 'Loading earlier messages'
      : 'Load earlier messages';

    this.empty.hidden = channel.messages.length > 0;
    this.empty.textContent = channel.joined
      ? 'No messages yet. Say hello.'
      : 'Join this channel to read and post.';

    let previous = null;
    let unreadMarked = false;
    for (const message of channel.messages) {
      const date = new Date(message.timestamp);
      if (!previous || dayKey(new Date(previous.timestamp)) !== dayKey(date)) {
        this.list.append(el('div', { class: 'day-separator' }, [
          el('span', { text: dayLabel(date) }),
        ]));
        previous = null;
      }
      if (!unreadMarked && channel.firstUnreadId && message.id === channel.firstUnreadId) {
        unreadMarked = true;
        this.list.append(el('div', { class: 'unread-separator' }, [
          el('span', { text: 'New messages' }),
        ]));
        previous = null;
      }
      const grouped = Boolean(previous)
        && previous.label === message.label
        && Boolean(previous.senderJid) === Boolean(message.senderJid)
        && previous.senderJid === message.senderJid
        && message.timestamp - previous.timestamp < GROUPING_WINDOW_MS;
      const row = document.createElement('fm-message');
      row.data = { ...message, grouped };
      this.list.append(row);
      previous = message;
    }

    const newest = channel.messages[channel.messages.length - 1];
    if (newest && !newest.pending && !newest.own && this.announced !== newest.id && !channelChanged) {
      this.announced = newest.id;
      this.announcer.textContent = `${newest.nick || newest.senderJid || newest.label}: ${newest.text}`;
    } else if (channelChanged) {
      this.announced = newest ? newest.id : null;
      this.announcer.textContent = '';
    }

    // Scroll anchoring: stay pinned to the newest message unless the reader
    // has scrolled up to look at something.
    if (channelChanged || wasAtBottom) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.jump.hidden = true;
    } else {
      this.jump.hidden = false;
    }
  }
}

customElements.define('fm-message-list', FmMessageList);
