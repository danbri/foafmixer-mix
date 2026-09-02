// Entry point: registers the components, connects the XMPP wrapper to the
// store, and performs the protocol actions the components ask for.

import { store } from './store.js';
import { xmpp } from './xmpp.js';
import { toast, localPart } from './dom.js';
import './components/fm-app.js';

const app = document.querySelector('fm-app');

function channelDialog() {
  return app?.channelDialog || null;
}

// --- protocol events -> store ------------------------------------------------

xmpp.addEventListener('log', (event) => {
  document.dispatchEvent(new CustomEvent('fm-log', { detail: event.detail }));
});

xmpp.addEventListener('status', (event) => {
  const { text, tone, phase } = event.detail;
  store.setStatus(phase === 'connecting' ? 'connecting' : store.state.status, text, tone);
});

xmpp.addEventListener('connected', (event) => {
  const { jid, host, port } = event.detail;
  store.setConnected(jid, host, port);
  store.saveSession();
  toast(`Signed in as ${jid}`);
  // Remembered channels need a fresh client-join to re-establish membership.
  for (const channel of [...store.state.channels]) {
    joinChannel({
      channelJid: channel.jid,
      nick: channel.nick || localPart(jid),
      announce: false,
    });
  }
});

// Strophe reports a failure and then the socket close.  Keep the failure text
// on screen, and raise one toast per failure rather than one per event.
let lastFailureText = null;
let lastFailureAt = 0;

xmpp.addEventListener('disconnected', (event) => {
  const { reason, text } = event.detail;
  if (reason === 'authfail') store.clearSession();
  const recentFailure = Date.now() - lastFailureAt < 5000;
  if (reason === 'closed') {
    store.setDisconnected(recentFailure ? lastFailureText : text, recentFailure ? 'error' : 'info');
    return;
  }
  const duplicate = recentFailure && text === lastFailureText;
  lastFailureText = text;
  lastFailureAt = Date.now();
  store.setDisconnected(text, 'error');
  if (!duplicate) toast(text, 'error');
});

xmpp.addEventListener('message', (event) => {
  const { channelJid, message } = event.detail;
  if (!store.channel(channelJid)) return;
  const isActive = store.state.activeChannel === channelJid
    && store.state.view !== 'channels'
    && document.visibilityState === 'visible';
  store.addMessage(channelJid, message, { isActive });
  store.touchSession();
});

xmpp.addEventListener('history', (event) => {
  const { channelJid, messages, complete } = event.detail;
  store.mergeHistory(channelJid, messages, complete);
});

xmpp.addEventListener('participants', (event) => {
  store.setParticipants(event.detail.channelJid, event.detail.participants);
});

xmpp.addEventListener('info', (event) => {
  store.setInfo(event.detail.channelJid, event.detail.info);
});

xmpp.addEventListener('channel-left', (event) => {
  store.removeChannel(event.detail.channelJid);
});

// --- actions -----------------------------------------------------------------

function joinChannel({ channelJid, nick, announce = true }) {
  store.ensureChannel(channelJid, nick);
  return xmpp.joinChannel({ channelJid, nick })
    .then(({ nick: confirmed }) => {
      store.markJoined(channelJid, confirmed);
      if (announce) {
        store.setActiveChannel(channelJid, { view: 'conversation' });
        channelDialog()?.close();
        toast(`Joined ${channelJid.split('@')[0]}`);
      }
      store.saveSession();
      loadHistory(channelJid);
    })
    .catch((error) => {
      const text = `Could not join ${channelJid}. ${error.message}`;
      if (announce) channelDialog()?.setStatus(text, 'error');
      toast(text, 'error');
    });
}

function loadHistory(channelJid) {
  const channel = store.channel(channelJid);
  if (!channel || channel.historyLoading) return;
  store.setHistoryLoading(channelJid, true);
  xmpp.loadHistory(channelJid, channel.oldestArchiveId).catch((error) => {
    store.setHistoryLoading(channelJid, false);
    toast(`Could not load earlier messages. ${error.message}`, 'error');
  });
}

document.addEventListener('fm-request', (event) => {
  const detail = event.detail;
  const name = detail.name;

  if (name === 'sign-in') {
    store.state.rememberSession = detail.remember;
    if (!detail.remember) store.clearSession();
    store.state.host = detail.host;
    store.state.port = detail.port;
    store.setStatus('connecting', `Connecting to ${detail.host}:${detail.port}.`);
    const started = xmpp.connect(detail);
    if (!started) store.setStatus('disconnected');
    return;
  }

  if (name === 'sign-out') {
    xmpp.disconnect();
    store.clearSession();
    store.setDisconnected('Signed out.');
    toast('Signed out');
    return;
  }

  if (name === 'join') {
    joinChannel({ channelJid: `${detail.channel}@${detail.service}`, nick: detail.nick });
    return;
  }

  if (name === 'create-and-join') {
    xmpp.createChannel({ service: detail.service, name: detail.channel })
      .then((channelJid) => {
        toast(`Created ${detail.channel}`);
        return joinChannel({ channelJid, nick: detail.nick });
      })
      .catch((error) => {
        const text = `Could not create ${detail.channel}. ${error.message}`;
        channelDialog()?.setStatus(text, 'error');
        toast(text, 'error');
      });
    return;
  }

  if (name === 'leave') {
    const channel = store.active;
    if (!channel) return;
    xmpp.leaveChannel(channel.jid)
      .then(() => {
        store.setDetailsOpen(false);
        toast(`Left ${channel.jid.split('@')[0]}`);
      })
      .catch((error) => toast(`Could not leave the channel. ${error.message}`, 'error'));
    return;
  }

  if (name === 'send') {
    const channel = store.active;
    if (!channel || !detail.text) return;
    const id = xmpp.sendGroupMessage(channel.jid, detail.text);
    // Only the server echo renders as a delivered message; until it arrives
    // the row keyed by this id stays pending.
    if (id) store.addPending(channel.jid, { id, text: detail.text });
    else toast('Not connected, so the message was not sent.', 'error');
    store.touchSession();
    return;
  }

  if (name === 'load-history') {
    const channel = store.active;
    if (channel) loadHistory(channel.jid);
  }
});

// --- session lifetime --------------------------------------------------------

store.onIdleLogout = () => {
  xmpp.disconnect();
  store.clearSession();
  store.setDisconnected('Signed out after 20 minutes without activity.');
};

document.addEventListener('pointerdown', () => store.touchSession());
document.addEventListener('keydown', () => store.touchSession());

store.restoreSession();
store.commit();

// Strophe is loaded from cdn.jsdelivr.net.  Say so if it is missing.
window.addEventListener('load', () => {
  if (!window.Strophe) {
    store.state.stropheLoaded = false;
    store.setStatus('disconnected',
      'Strophe.js did not load. Check that this device can reach cdn.jsdelivr.net.', 'error');
    toast('Strophe.js did not load from cdn.jsdelivr.net.', 'error');
  }
});
