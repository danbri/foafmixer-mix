import { FmElement, el, button, iconButton, request, initials, avatarHue } from '../dom.js';

export class FmDetails extends FmElement {
  build() {
    this.id = 'channel-details';
    this.close = iconButton('Close details', '\u00d7', { class: 'details-close' });
    this.close.addEventListener('click', () => request(this, 'toggle-details', { open: false }));

    this.heading = el('h2', { class: 'details-heading', text: 'Channel details' });
    this.nameRow = el('p', { class: 'details-name' });
    this.jidRow = el('p', { class: 'details-jid' });
    this.contactList = el('ul', { class: 'details-contacts' });
    this.contactHeading = el('h3', { text: 'Contact' });

    this.participantHeading = el('h3', { class: 'details-participants-heading', text: 'Participants' });
    this.participantList = el('ul', { class: 'participant-list' });
    this.participantEmpty = el('p', { class: 'details-empty', text: 'No participants listed yet.' });

    this.leave = button('Leave channel', { class: 'danger leave-button' });
    this.leave.addEventListener('click', () => request(this, 'leave'));

    this.append(
      el('div', { class: 'details-header' }, [this.heading, this.close]),
      this.nameRow,
      this.jidRow,
      this.contactHeading,
      this.contactList,
      this.participantHeading,
      this.participantList,
      this.participantEmpty,
      this.leave,
    );
  }

  update() {
    const channel = this.store.active;
    if (!channel) {
      this.nameRow.textContent = 'No channel open.';
      this.jidRow.textContent = '';
      this.contactHeading.hidden = true;
      this.contactList.replaceChildren();
      this.participantHeading.hidden = true;
      this.participantList.replaceChildren();
      this.participantEmpty.hidden = true;
      this.leave.hidden = true;
      return;
    }
    this.leave.hidden = false;
    this.leave.disabled = this.store.state.status !== 'connected';
    this.nameRow.textContent = channel.name || channel.jid.split('@')[0];
    this.jidRow.textContent = channel.jid;

    this.contactHeading.hidden = channel.contact.length === 0;
    this.contactList.replaceChildren();
    for (const contact of channel.contact) {
      this.contactList.append(el('li', { text: contact }));
    }

    this.participantHeading.hidden = false;
    this.participantList.replaceChildren();
    for (const participant of channel.participants) {
      const key = participant.jid || participant.id || participant.label;
      const avatar = el('span', { class: 'avatar avatar-small', 'aria-hidden': 'true', text: initials(participant.label) });
      avatar.style.setProperty('--avatar-hue', String(avatarHue(key)));
      const lines = el('span', { class: 'participant-lines' }, [
        el('span', { class: 'participant-nick', text: participant.nick || participant.label }),
      ]);
      if (participant.jid && participant.jid !== participant.label) {
        lines.append(el('span', { class: 'participant-jid', text: participant.jid }));
      }
      this.participantList.append(el('li', { class: 'participant' }, [avatar, lines]));
    }
    this.participantEmpty.hidden = channel.participants.length > 0;
  }
}

customElements.define('fm-details', FmDetails);
