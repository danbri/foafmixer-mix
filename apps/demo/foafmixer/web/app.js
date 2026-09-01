/* global Strophe, stx */
const state = {
  connection: null,
  jid: null,
  channelJid: null,
  savedChannelJid: null,
  logoutTimer: null,
  timedOut: false,
  historyQueryId: null,
  historyLoadedChannel: null,
  historyCount: 0,
  protocolEntries: [],
};
const $ = (id) => document.getElementById(id);
const status = $('connection-status');
const channelStatus = $('channel-status');
const log = $('protocol-log');
const SESSION_KEY = 'foafmixer-browser-session-v1';
const SESSION_IDLE_MS = 20 * 60 * 1000;
const CLIENT_NS = 'jabber:client';
// XEP-0369 Core:1 and XEP-0405 Client-PAM:2 namespaces.
const MIX_CORE_NS = 'urn:xmpp:mix:core:1';
const MIX_CORE_0_NS = 'urn:xmpp:mix:core:0';
const MIX_PAM_NS = 'urn:xmpp:mix:pam:2';
const MAM_NS = 'urn:xmpp:mam:2';
const FORWARD_NS = 'urn:xmpp:forward:0';
const DELAY_NS = 'urn:xmpp:delay';
const RSM_NS = 'http://jabber.org/protocol/rsm';

$('websocket-host').value = location.hostname;

function tabButtons(tablist) {
  return Array.from(tablist.children).filter((child) => child.getAttribute('role') === 'tab');
}

function activateTab(tab, focus = false) {
  const tablist = tab.closest('[role="tablist"]');
  if (!tablist) return;
  for (const candidate of tabButtons(tablist)) {
    const selected = candidate === tab;
    candidate.classList.toggle('is-active', selected);
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const panel = $(candidate.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  }
  if (focus) tab.focus();
  if (tab.id === 'history-tab') loadHistory();
}

function activateTabById(id) {
  const tab = $(id);
  if (tab) activateTab(tab);
}

function initializeTabs() {
  for (const tablist of document.querySelectorAll('[role="tablist"]')) {
    const tabs = tabButtons(tablist);
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        let targetIndex = null;
        if (event.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = tabs.length - 1;
        if (targetIndex === null) return;
        event.preventDefault();
        activateTab(tabs[targetIndex], true);
      });
    });
  }
}

function escapeXmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function serializeXmlNode(node, depth, lines) {
  const indent = '  '.repeat(depth);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const attributes = Array.from(node.attributes)
      .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
      .join('');
    const children = Array.from(node.childNodes)
      .filter((child) => child.nodeType !== Node.TEXT_NODE || child.nodeValue.trim());
    if (!children.length) {
      lines.push(`${indent}<${node.nodeName}${attributes}/>`);
      return;
    }
    if (children.every((child) => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE)) {
      const text = children.map((child) => escapeXmlText(child.nodeValue)).join('');
      lines.push(`${indent}<${node.nodeName}${attributes}>${text}</${node.nodeName}>`);
      return;
    }
    lines.push(`${indent}<${node.nodeName}${attributes}>`);
    for (const child of children) serializeXmlNode(child, depth + 1, lines);
    lines.push(`${indent}</${node.nodeName}>`);
  } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    if (node.nodeValue.trim()) lines.push(`${indent}${escapeXmlText(node.nodeValue)}`);
  } else if (node.nodeType === Node.COMMENT_NODE) {
    lines.push(`${indent}<!--${node.nodeValue}-->`);
  }
}

function prettyXml(xml) {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) return xml;
  const lines = [];
  serializeXmlNode(parsed.documentElement, 0, lines);
  return lines.join('\n');
}

function addSyntaxSpan(parent, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.append(span);
}

function highlightXmlTag(parent, source) {
  const match = source.match(/^(<\/?)([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?>)$/);
  if (!match) {
    addSyntaxSpan(parent, 'xml-text', source);
    return;
  }
  addSyntaxSpan(parent, 'xml-punctuation', match[1]);
  addSyntaxSpan(parent, 'xml-tag', match[2]);
  const attributes = match[3];
  const attributePattern = /(\s+)([A-Za-z_][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
  let offset = 0;
  let attributeMatch;
  while ((attributeMatch = attributePattern.exec(attributes))) {
    parent.append(document.createTextNode(attributes.slice(offset, attributeMatch.index) + attributeMatch[1]));
    addSyntaxSpan(parent, 'xml-attribute', attributeMatch[2]);
    addSyntaxSpan(parent, 'xml-punctuation', attributeMatch[3]);
    addSyntaxSpan(parent, 'xml-value', attributeMatch[4]);
    offset = attributePattern.lastIndex;
  }
  parent.append(document.createTextNode(attributes.slice(offset)));
  addSyntaxSpan(parent, 'xml-punctuation', match[4]);
}

function highlightXml(parent, xml) {
  for (const line of prettyXml(xml).split('\n')) {
    const row = document.createElement('div');
    row.className = 'xml-line';
    for (const segment of line.match(/<[^>]+>|[^<]+/g) || []) {
      if (segment.startsWith('<')) {
        highlightXmlTag(row, segment);
      } else {
        addSyntaxSpan(row, 'xml-text', segment);
      }
    }
    parent.append(row);
  }
}

function writeLog(label, stanza) {
  const xml = typeof stanza === 'string'
    ? stanza
    : stanza instanceof Node
      ? new XMLSerializer().serializeToString(stanza)
      : String(stanza);
  const timestamp = new Date().toISOString();
  state.protocolEntries.push({ timestamp, label, xml });
  const entry = document.createElement('section');
  entry.className = `protocol-entry protocol-${label.toLowerCase()}`;
  const heading = document.createElement('div');
  heading.className = 'protocol-entry-heading';
  heading.textContent = `[${timestamp}] ${label}`;
  const stanzaView = document.createElement('div');
  stanzaView.className = 'protocol-stanza';
  highlightXml(stanzaView, xml);
  entry.append(heading, stanzaView);
  log.append(entry);
  log.scrollTop = log.scrollHeight;
}

function rawProtocolLog() {
  return state.protocolEntries
    .map(({ timestamp, label, xml }) => `[${timestamp}] ${label}\n${xml}`)
    .join('\n\n');
}

async function copyProtocolLog() {
  const text = rawProtocolLog();
  if (!text) {
    $('copy-status').textContent = 'The protocol log is empty.';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('readonly', '');
    temporary.className = 'clipboard-fallback';
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (!copied) throw new Error('copy failed');
  }
  $('copy-status').textContent = 'Protocol log copied.';
}

function setConnected(connected) {
  $('disconnect').disabled = !connected;
  $('create-channel').disabled = !connected;
  $('join-channel').disabled = !connected;
  $('refresh-history').disabled = !connected || !state.channelJid;
  $('server-state').textContent = connected
    ? '✅ Connected to server'
    : '❌ Connected to server';
}

function renderJoinedState() {
  $('joined-state').textContent = state.channelJid
    ? `✅ Joined channel: ${state.channelJid}`
    : '❌ Joined channels: none';
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
    websocketHost: $('websocket-host').value.trim(),
    websocketPort: $('websocket-port').value,
    channelJid: state.channelJid,
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

function appendMessage(listId, emptyStateId, from, text, timestamp = new Date()) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const renderedTime = Number.isNaN(date.valueOf()) ? String(timestamp) : date.toLocaleString();
  meta.textContent = `${from || 'unknown'} · ${renderedTime}`;
  item.append(meta, document.createTextNode(text));
  $(listId).append(item);
  $(emptyStateId).hidden = true;
}

function directChild(element, localName, namespace = null) {
  return Array.from(element?.children || []).find((child) => (
    child.localName === localName && (!namespace || child.namespaceURI === namespace)
  )) || null;
}

function mixElement(message) {
  return Array.from(message?.children || []).find((child) => (
    child.localName === 'mix'
      && (child.namespaceURI === MIX_CORE_NS || child.namespaceURI === MIX_CORE_0_NS)
  )) || null;
}

function messageSender(message) {
  const mix = mixElement(message);
  const nick = directChild(mix, 'nick')?.textContent?.trim();
  const jid = directChild(mix, 'jid')?.textContent?.trim();
  if (nick && jid) return `${nick} (${jid})`;
  return nick || jid || message.getAttribute('from') || 'unknown';
}

function handleMamResult(message, result) {
  if (!state.historyQueryId || result.getAttribute('queryid') !== state.historyQueryId) return;
  const forwarded = directChild(result, 'forwarded', FORWARD_NS);
  const archived = Array.from(forwarded?.children || [])
    .find((child) => child.localName === 'message');
  const body = directChild(archived, 'body');
  if (!body) return;
  const delay = directChild(forwarded, 'delay', DELAY_NS);
  const timestamp = delay?.getAttribute('stamp') || new Date();
  appendMessage('history-messages', 'history-empty', messageSender(archived), body.textContent, timestamp);
  state.historyCount += 1;
}

function handleMessage(message) {
  const mamResult = Array.from(message.children || []).find((child) => (
    child.localName === 'result' && child.namespaceURI === MAM_NS
  ));
  if (mamResult) {
    handleMamResult(message, mamResult);
    return true;
  }
  const body = directChild(message, 'body');
  if (body) appendMessage('messages', 'messages-empty', messageSender(message), body.textContent);
  return true;
}

function resetLiveMessages() {
  $('messages').replaceChildren();
  $('messages-empty').hidden = false;
  $('messages-empty').textContent = 'No live messages received in this session.';
}

function channelJid() {
  return `${$('channel').value.trim()}@${$('service').value.trim()}`;
}

function setActiveChannel(target) {
  const changedChannel = state.channelJid !== target;
  state.channelJid = target;
  $('chat-title').textContent = `Messages · ${target}`;
  $('message').placeholder = `Message ${target}`;
  $('message').disabled = false;
  $('send').disabled = false;
  $('refresh-history').disabled = false;
  if (changedChannel) resetHistory(`Open History to load recent messages from ${target}.`);
  channelStatus.textContent = `Joined ${target}.`;
  renderJoinedState();
}

function clearActiveChannel() {
  state.channelJid = null;
  state.historyQueryId = null;
  $('chat-title').textContent = 'Messages';
  $('message').placeholder = 'Connect and choose a channel';
  $('message').disabled = true;
  $('send').disabled = true;
  $('refresh-history').disabled = true;
  resetHistory('Join a channel to load its server history.');
  renderJoinedState();
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

function resetHistory(message) {
  state.historyQueryId = null;
  state.historyLoadedChannel = null;
  state.historyCount = 0;
  $('history-messages').replaceChildren();
  $('history-empty').hidden = false;
  $('history-empty').textContent = 'No history loaded.';
  $('history-status').textContent = message;
}

function loadHistory(force = false) {
  if (!state.connection || !state.jid || !state.channelJid) {
    $('history-status').textContent = 'Connect and join a channel to load its server history.';
    return;
  }
  if (!force && state.historyQueryId) return;
  if (!force && state.historyLoadedChannel === state.channelJid) return;

  const target = state.channelJid;
  const queryId = state.connection.getUniqueId('mam-query');
  const query = xmlElement(MAM_NS, 'query', { queryid: queryId });
  const resultSet = xmlElement(RSM_NS, 'set');
  resultSet.append(
    xmlElement(RSM_NS, 'max', {}, '50'),
    // An empty <before/> asks for the newest page while retaining chronological
    // result order, as defined by XEP-0059 result-set management.
    xmlElement(RSM_NS, 'before'),
  );
  query.append(resultSet);
  const iq = xmlElement(CLIENT_NS, 'iq', {
    type: 'set',
    to: target,
    id: state.connection.getUniqueId('mam'),
  });
  iq.append(query);

  state.historyQueryId = queryId;
  state.historyCount = 0;
  $('history-messages').replaceChildren();
  $('history-empty').hidden = false;
  $('history-empty').textContent = 'Loading history…';
  $('history-status').textContent = `Loading the latest 50 messages from ${target}…`;
  $('refresh-history').disabled = true;

  state.connection.sendIQ(iq, () => {
    if (state.historyQueryId !== queryId) return;
    state.historyQueryId = null;
    state.historyLoadedChannel = target;
    $('history-empty').textContent = state.historyCount
      ? ''
      : 'No archived messages were returned.';
    $('history-empty').hidden = state.historyCount > 0;
    $('history-status').textContent = `Loaded ${state.historyCount} archived message${state.historyCount === 1 ? '' : 's'} from ${target}.`;
    $('refresh-history').disabled = false;
  }, (error) => {
    if (state.historyQueryId !== queryId) return;
    state.historyQueryId = null;
    $('history-empty').textContent = 'History could not be loaded.';
    $('history-status').textContent = `History query failed: ${errorText(error)}`;
    $('refresh-history').disabled = false;
  });
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
  // A saved session may already be reconnecting when the user presses
  // Connect.  Keep callbacks tied to their own socket so a stale socket
  // cannot clear state belonging to the newer connection.
  state.connection?.disconnect();
  clearActiveChannel();
  resetLiveMessages();
  setConnected(false);
  // The pilot reconnects with a fresh XMPP session.  Stream-management resume
  // races with browser WebSocket teardown and is unnecessary over Tailscale.
  const connection = new Strophe.Connection(endpoint, { enableStreamManagement: false });
  state.connection = connection;
  connection.rawInput = (stanza) => writeLog('IN', stanza);
  connection.rawOutput = (stanza) => writeLog('OUT', stanza);
  connection.connect(jid, password, (connectionStatus) => {
    if (state.connection !== connection) return;
    if (connectionStatus === Strophe.Status.CONNECTED) {
      state.jid = jid;
      $('nick').value ||= jid.split('@')[0];
      status.textContent = `Connected as ${jid} via ${websocketHost}:${websocketPort}`;
      setConnected(true);
      saveSession();
      if (state.savedChannelJid) {
        channelStatus.textContent = `Previous channel ${state.savedChannelJid} is saved; click Join to establish live membership.`;
      } else {
        channelStatus.textContent = 'Connected. Create a channel or click Join to enter the selected channel.';
      }
      state.connection.addHandler(handleMessage, null, 'message');
      state.connection.send(xmlElement(CLIENT_NS, 'presence'));
      activateTabById('channel-tab');
    } else if (connectionStatus === Strophe.Status.AUTHFAIL) {
      clearSession();
      status.textContent = 'Authentication failed.';
      state.jid = null;
      setConnected(false);
    } else if (connectionStatus === Strophe.Status.CONNFAIL) {
      status.textContent = 'Connection failed.';
      state.jid = null;
      setConnected(false);
    } else if (connectionStatus === Strophe.Status.DISCONNECTED) {
      if (!state.timedOut) status.textContent = 'Disconnected.';
      state.jid = null;
      setConnected(false);
      clearActiveChannel();
      activateTabById('server-tab');
    }
  });
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});

$('disconnect').addEventListener('click', () => {
  clearSession();
  state.savedChannelJid = null;
  clearActiveChannel();
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

function joinChannel(onJoined = null) {
  if (!state.connection || !state.jid) {
    channelStatus.textContent = 'Connect before joining a channel.';
    return;
  }
  const target = channelJid();
  const nick = $('nick').value.trim();
  const join = xmlElement(MIX_CORE_NS, 'join');
  join.append(
    xmlElement(MIX_CORE_NS, 'nick', {}, nick),
    xmlElement(MIX_CORE_NS, 'subscribe', { node: 'urn:xmpp:mix:nodes:messages' }),
    xmlElement(MIX_CORE_NS, 'subscribe', { node: 'urn:xmpp:mix:nodes:participants' }),
    xmlElement(MIX_CORE_NS, 'subscribe', { node: 'urn:xmpp:mix:nodes:info' }),
  );
  // XEP-0405 requires joining through the participant's local server.  This
  // records the MIX roster mapping that lets ejabberd route live channel
  // messages back to this connected resource.
  const clientJoin = xmlElement(MIX_PAM_NS, 'client-join', { channel: target });
  clientJoin.append(join);
  state.connection.sendIQ(mixIq(state.jid, clientJoin), () => {
    state.savedChannelJid = target;
    setActiveChannel(target);
    saveSession();
    activateTabById('messages-tab');
    activateTabById('live-tab');
    $('message').focus();
    onJoined?.();
  }, (error) => { channelStatus.textContent = `Join failed: ${errorText(error)}`; });
}

$('join-channel').addEventListener('click', () => {
  joinChannel();
});

$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!text || !state.connection) return;
  const sendMessage = () => {
    const message = xmlElement(CLIENT_NS, 'message', {
      to: state.channelJid,
      type: 'groupchat',
      id: state.connection.getUniqueId('msg'),
    });
    message.append(xmlElement(CLIENT_NS, 'body', {}, text));
    state.connection.send(message);
    $('message').value = '';
  };
  if (state.channelJid) {
    sendMessage();
  } else {
    channelStatus.textContent = 'Restoring channel membership before sending…';
    joinChannel(sendMessage);
  }
});

// Keep Enter available for multi-line messages; use the familiar platform
// shortcut to send without reaching for the button.
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!$('send').disabled) $('message-form').requestSubmit();
  }
});

$('refresh-history').addEventListener('click', () => loadHistory(true));
$('copy-protocol-log').addEventListener('click', () => {
  copyProtocolLog().catch(() => {
    $('copy-status').textContent = 'Could not copy the protocol log.';
  });
});

initializeTabs();
setConnected(false);
renderJoinedState();
resetLiveMessages();

document.addEventListener('pointerdown', touchSession);
document.addEventListener('keydown', touchSession);

try {
  const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  if (saved?.expiresAt > Date.now()) {
    // Migrate earlier pilot sessions that stored a password in sessionStorage.
    // Connection details are enough to restore the form; authentication remains
    // an explicit user action.
    if ('password' in saved) {
      delete saved.password;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
    }
    $('jid').value = saved.jid;
    $('websocket-host').value = saved.websocketHost;
    // The separate patched-test endpoint was retired after the patched server
    // became the pilot.  Move pre-cutover browser sessions to the canonical
    // WebSocket port instead of leaving the one-option select with no value.
    saved.websocketPort = saved.websocketPort === '15281'
      ? '8444'
      : saved.websocketPort;
    const savedPortIsAvailable = Array.from($('websocket-port').options)
      .some((option) => option.value === saved.websocketPort);
    if (!savedPortIsAvailable) {
      saved.websocketPort = '8444';
    }
    $('websocket-port').value = saved.websocketPort;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
    state.savedChannelJid = saved.channelJid || null;
    if (state.savedChannelJid) {
      const separator = state.savedChannelJid.indexOf('@');
      if (separator > 0) {
        $('channel').value = state.savedChannelJid.slice(0, separator);
        $('service').value = state.savedChannelJid.slice(separator + 1);
      }
    }
    $('remember-session').checked = true;
    status.textContent = 'Connection details restored. Enter password, then Connect.';
  } else if (saved) {
    clearSession();
  }
} catch (_) {
  clearSession();
}
