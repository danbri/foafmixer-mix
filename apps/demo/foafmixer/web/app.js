/* global Strophe, stx */
const state = { connection: null, jid: null, channelJid: null, logoutTimer: null, timedOut: false };
const $ = (id) => document.getElementById(id);
const status = $('connection-status');
const channelStatus = $('channel-status');
const log = $('protocol-log');
const SESSION_KEY = 'foafmixer-browser-session-v1';
const SESSION_IDLE_MS = 20 * 60 * 1000;
const CLIENT_NS = 'jabber:client';
// MIX-CORE 0.14.6 uses the current :1 namespace and direct channel joins.
const MIX_CORE_NS = 'urn:xmpp:mix:core:1';

$('websocket-host').value = location.hostname;

function writeLog(label, stanza) {
  const xml = typeof stanza === 'string'
    ? stanza
    : stanza instanceof Node
      ? new XMLSerializer().serializeToString(stanza)
      : String(stanza);
  log.textContent += `[${new Date().toISOString()}] ${label}\n${xml}\n\n`;
  log.scrollTop = log.scrollHeight;
}

function setConnected(connected) {
  $('disconnect').disabled = !connected;
  $('create-channel').disabled = !connected;
  $('join-channel').disabled = !connected;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  clearTimeout(state.logoutTimer);
  state.logoutTimer = null;
  $('password').value = '';
}

function saveSession() {
  if (!$('remember-session').checked || !state.jid) return;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    jid: state.jid,
    password: $('password').value,
    websocketHost: $('websocket-host').value.trim(),
    websocketPort: $('websocket-port').value,
    expiresAt: Date.now() + SESSION_IDLE_MS,
  }));
  scheduleLogout();
}

function scheduleLogout() {
  clearTimeout(state.logoutTimer);
  const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  if (!saved?.expiresAt) return;
  const remaining = saved.expiresAt - Date.now();
  if (remaining <= 0) {
    logoutForInactivity();
    return;
  }
  state.logoutTimer = setTimeout(logoutForInactivity, remaining);
}

function logoutForInactivity() {
  state.timedOut = true;
  state.connection?.disconnect();
  clearSession();
  status.textContent = 'Signed out after 20 minutes of inactivity.';
  setConnected(false);
}

function touchSession() {
  if (!state.connection || !state.jid || !$('remember-session').checked) return;
  saveSession();
}

function appendMessage(from, text) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${from || 'unknown'} · ${new Date().toLocaleTimeString()}`;
  item.append(meta, document.createTextNode(text));
  $('messages').append(item);
}

function channelJid() {
  return `${$('channel').value.trim()}@${$('service').value.trim()}`;
}

function xmlElement(namespace, name, attributes = {}, text = null) {
  const element = document.createElementNS(namespace, name);
  // Strophe serializes DOM payloads by attribute, so retain the namespace
  // explicitly rather than relying only on the DOM namespace URI.
  element.setAttribute('xmlns', namespace);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, value);
  }
  if (text !== null) element.append(document.createTextNode(text));
  return element;
}

function errorText(stanza) {
  return stanza?.querySelector('error text')?.textContent || 'See protocol log.';
}

function mixIq(target, child) {
  const iq = xmlElement(CLIENT_NS, 'iq', {
    type: 'set',
    to: target,
    id: state.connection.getUniqueId('mix'),
  });
  iq.append(child);
  return iq;
}

function connect() {
  const jid = $('jid').value.trim();
  const password = $('password').value;
  const domain = jid.split('@')[1];
  const websocketHost = $('websocket-host').value.trim();
  const websocketPort = $('websocket-port').value;
  if (!domain) { status.textContent = 'Enter a full JID.'; return; }
  if (!websocketHost || !websocketPort) { status.textContent = 'Enter the WebSocket server and port.'; return; }
  if (!window.Strophe || !window.stx) {
    status.textContent = 'Strophe.js did not load. Check this device can reach cdn.jsdelivr.net.';
    return;
  }
  const endpoint = `wss://${websocketHost}:${websocketPort}/xmpp`;
  state.timedOut = false;
  status.textContent = `Connecting to ${endpoint}…`;
  state.connection = new Strophe.Connection(endpoint, { enableStreamManagement: true });
  state.connection.rawInput = (stanza) => writeLog('IN', stanza);
  state.connection.rawOutput = (stanza) => writeLog('OUT', stanza);
  state.connection.connect(jid, password, (connectionStatus) => {
    if (connectionStatus === Strophe.Status.CONNECTED) {
      state.jid = jid;
      $('nick').value ||= jid.split('@')[0];
      status.textContent = `Connected as ${jid}`;
      setConnected(true);
      saveSession();
      state.connection.addHandler((message) => {
        const body = message.querySelector('body');
        if (body) appendMessage(message.getAttribute('from'), body.textContent);
        return true;
      }, null, 'message');
      state.connection.send(xmlElement(CLIENT_NS, 'presence'));
    } else if (connectionStatus === Strophe.Status.AUTHFAIL) {
      clearSession();
      status.textContent = 'Authentication failed.';
      setConnected(false);
    } else if (connectionStatus === Strophe.Status.CONNFAIL) {
      status.textContent = 'Connection failed.';
      setConnected(false);
    } else if (connectionStatus === Strophe.Status.DISCONNECTED) {
      if (!state.timedOut) status.textContent = 'Disconnected.';
      setConnected(false);
    }
  });
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});

$('disconnect').addEventListener('click', () => {
  clearSession();
  state.connection?.disconnect();
});

$('create-channel').addEventListener('click', () => {
  const name = $('channel').value.trim();
  const service = $('service').value.trim();
  if (!name || !service) return;
  const create = xmlElement(MIX_CORE_NS, 'create', { channel: name });
  state.connection.sendIQ(mixIq(service, create), () => {
    channelStatus.textContent = `Created ${channelJid()}; join it next.`;
  }, (error) => { channelStatus.textContent = `Channel creation failed: ${errorText(error)}`; });
});

$('join-channel').addEventListener('click', () => {
  const target = channelJid();
  const nick = $('nick').value.trim();
  const join = xmlElement(MIX_CORE_NS, 'join');
  join.append(
    xmlElement(MIX_CORE_NS, 'nick', {}, nick),
    xmlElement(MIX_CORE_NS, 'subscribe', { node: 'urn:xmpp:mix:nodes:messages' }),
    xmlElement(MIX_CORE_NS, 'subscribe', { node: 'urn:xmpp:mix:nodes:participants' }),
  );
  state.connection.sendIQ(mixIq(target, join), () => {
    state.channelJid = target;
    $('chat-title').textContent = `Messages · ${target}`;
    $('message').disabled = false;
    $('send').disabled = false;
    channelStatus.textContent = `Joined ${target}.`;
  }, (error) => { channelStatus.textContent = `Join failed: ${errorText(error)}`; });
});

$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!text || !state.channelJid) return;
  const message = xmlElement(CLIENT_NS, 'message', {
    to: state.channelJid,
    type: 'groupchat',
    id: state.connection.getUniqueId('msg'),
  });
  message.append(xmlElement(CLIENT_NS, 'body', {}, text));
  state.connection.send(message);
  $('message').value = '';
});

document.addEventListener('pointerdown', touchSession);
document.addEventListener('keydown', touchSession);

try {
  const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  if (saved?.expiresAt > Date.now()) {
    $('jid').value = saved.jid;
    $('password').value = saved.password;
    $('websocket-host').value = saved.websocketHost;
    $('websocket-port').value = saved.websocketPort;
    $('remember-session').checked = true;
    status.textContent = 'Restoring this tab’s session…';
    setTimeout(connect, 0);
  } else if (saved) {
    clearSession();
  }
} catch (_) {
  clearSession();
}
