/* global Strophe */
// The whole XMPP surface of the client.  Components never touch Strophe; they
// call these methods and listen for the events below.  Protocol behaviour is
// carried over unchanged from the pilot client:
//   - Strophe over WebSocket at wss://<host>:<port>/xmpp, stream management off
//   - XEP-0405 client-join through the user's own server, wrapping a Core 1 join
//   - groupchat sends carry a client-generated id; only the server echo renders
//   - XEP-0313 MAM on the channel JID, newest 50, RSM <before/>, matched by queryid
//   - sender display from the <mix> child in core:1 or core:0
//
// Events: status, connected, disconnected, channel-joined, channel-left,
//         message, history, participants, info, log.

import { stanzaToString } from './xml.js';

const CLIENT_NS = 'jabber:client';
// XEP-0369 Core:1 and XEP-0405 Client-PAM:2 namespaces.
export const MIX_CORE_NS = 'urn:xmpp:mix:core:1';
export const MIX_CORE_0_NS = 'urn:xmpp:mix:core:0';
const MIX_PAM_NS = 'urn:xmpp:mix:pam:2';
const MAM_NS = 'urn:xmpp:mam:2';
const FORWARD_NS = 'urn:xmpp:forward:0';
const DELAY_NS = 'urn:xmpp:delay';
const RSM_NS = 'http://jabber.org/protocol/rsm';
const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';
const PUBSUB_EVENT_NS = 'http://jabber.org/protocol/pubsub#event';
const DATA_FORM_NS = 'jabber:x:data';

export const NODE_MESSAGES = 'urn:xmpp:mix:nodes:messages';
export const NODE_PARTICIPANTS = 'urn:xmpp:mix:nodes:participants';
export const NODE_INFO = 'urn:xmpp:mix:nodes:info';

export const HISTORY_PAGE_SIZE = 50;

export function xmlElement(namespace, name, attributes = {}, text = null) {
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

export function directChild(element, localName, namespace = null) {
  return Array.from(element?.children || []).find((child) => (
    child.localName === localName && (!namespace || child.namespaceURI === namespace)
  )) || null;
}

function directChildren(element, localName, namespace = null) {
  return Array.from(element?.children || []).filter((child) => (
    child.localName === localName && (!namespace || child.namespaceURI === namespace)
  ));
}

function mixElement(message) {
  return Array.from(message?.children || []).find((child) => (
    child.localName === 'mix'
      && (child.namespaceURI === MIX_CORE_NS || child.namespaceURI === MIX_CORE_0_NS)
  )) || null;
}

export function errorText(stanza) {
  return stanza?.querySelector('error text')?.textContent || 'See the developer log.';
}

// Sender display comes from the <mix> child, accepting core:1 and core:0.
export function messageSender(message) {
  const mix = mixElement(message);
  const nick = directChild(mix, 'nick')?.textContent?.trim() || null;
  const jid = directChild(mix, 'jid')?.textContent?.trim() || null;
  const from = message?.getAttribute('from') || null;
  return { nick, jid, from, label: nick || jid || from || 'unknown' };
}

export class XmppClient extends EventTarget {
  constructor() {
    super();
    this.connection = null;
    this.jid = null;
    this.pendingHistory = new Map();
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(label, stanza) {
    this.emit('log', { label, timestamp: new Date().toISOString(), xml: stanzaToString(stanza) });
  }

  get connected() {
    return Boolean(this.connection && this.jid);
  }

  connect({ jid, password, host, port }) {
    const domain = jid.split('@')[1];
    if (!domain) {
      this.emit('status', { text: 'Enter a full JID, such as alice@foafmixer.test.', tone: 'error' });
      return false;
    }
    if (!host || !port) {
      this.emit('status', { text: 'Enter the WebSocket host and port.', tone: 'error' });
      return false;
    }
    if (!window.Strophe) {
      this.emit('status', {
        text: 'Strophe.js did not load. Check that this device can reach cdn.jsdelivr.net.',
        tone: 'error',
      });
      return false;
    }
    const endpoint = `wss://${host}:${port}/xmpp`;
    this.emit('status', { text: `Connecting to ${endpoint}.`, tone: 'info', phase: 'connecting' });
    // A saved session may already be reconnecting.  Keep callbacks tied to
    // their own socket so a stale socket cannot clear newer state.
    this.connection?.disconnect();
    // The pilot reconnects with a fresh XMPP session.  Stream-management
    // resume races with browser WebSocket teardown and is not needed here.
    const connection = new Strophe.Connection(endpoint, { enableStreamManagement: false });
    this.connection = connection;
    this.jid = null;
    connection.rawInput = (stanza) => this.log('IN', stanza);
    connection.rawOutput = (stanza) => this.log('OUT', stanza);
    connection.connect(jid, password, (connectionStatus) => {
      if (this.connection !== connection) return;
      if (connectionStatus === Strophe.Status.CONNECTED) {
        this.jid = jid;
        connection.addHandler((message) => this.handleMessage(message), null, 'message');
        // A PAM join makes the server push a roster item for the channel.
        // RFC 6121 requires the client to acknowledge the push; Strophe would
        // otherwise answer an unhandled IQ set with service-unavailable.
        connection.addHandler((iq) => {
          const ack = xmlElement(CLIENT_NS, 'iq', { type: 'result', id: iq.getAttribute('id') });
          if (iq.getAttribute('from')) ack.setAttribute('to', iq.getAttribute('from'));
          connection.send(ack);
          return true;
        }, 'jabber:iq:roster', 'iq', 'set');
        connection.send(xmlElement(CLIENT_NS, 'presence'));
        this.emit('connected', { jid, host, port });
      } else if (connectionStatus === Strophe.Status.AUTHFAIL) {
        this.jid = null;
        this.emit('disconnected', {
          reason: 'authfail',
          text: `${jid} was rejected. Check the password and that the account exists on ${domain}.`,
        });
      } else if (connectionStatus === Strophe.Status.CONNFAIL) {
        this.jid = null;
        this.emit('disconnected', {
          reason: 'connfail',
          text: `Could not reach ${endpoint}. Check the WebSocket host and port, and that the server is running.`,
        });
      } else if (connectionStatus === Strophe.Status.DISCONNECTED) {
        this.jid = null;
        this.emit('disconnected', { reason: 'closed', text: 'Signed out.' });
      }
    });
    return true;
  }

  disconnect() {
    const connection = this.connection;
    this.connection = null;
    this.jid = null;
    this.pendingHistory.clear();
    connection?.disconnect();
  }

  uniqueId(prefix) {
    return this.connection ? this.connection.getUniqueId(prefix) : `${prefix}-${Date.now()}`;
  }

  mixIq(target, child) {
    const iq = xmlElement(CLIENT_NS, 'iq', {
      type: 'set',
      to: target,
      id: this.uniqueId('mix'),
    });
    iq.append(child);
    return iq;
  }

  // XEP-0369 create, sent to the MIX service.
  createChannel({ service, name }) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Sign in before creating a channel.')); return; }
      const create = xmlElement(MIX_CORE_NS, 'create', { channel: name });
      this.connection.sendIQ(
        this.mixIq(service, create),
        () => resolve(`${name}@${service}`),
        (error) => reject(new Error(errorText(error))),
      );
    });
  }

  // XEP-0405 requires joining through the participant's local server.  This
  // records the MIX roster mapping that lets ejabberd route live channel
  // messages back to this connected resource.
  joinChannel({ channelJid, nick }) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Sign in before joining a channel.')); return; }
      const join = xmlElement(MIX_CORE_NS, 'join');
      join.append(
        xmlElement(MIX_CORE_NS, 'nick', {}, nick),
        xmlElement(MIX_CORE_NS, 'subscribe', { node: NODE_MESSAGES }),
        xmlElement(MIX_CORE_NS, 'subscribe', { node: NODE_PARTICIPANTS }),
        xmlElement(MIX_CORE_NS, 'subscribe', { node: NODE_INFO }),
      );
      const clientJoin = xmlElement(MIX_PAM_NS, 'client-join', { channel: channelJid });
      clientJoin.append(join);
      this.connection.sendIQ(this.mixIq(this.jid, clientJoin), (result) => {
        const pamJoin = directChild(result, 'client-join', MIX_PAM_NS);
        const inner = directChild(pamJoin, 'join', MIX_CORE_NS) || directChild(pamJoin, 'join', MIX_CORE_0_NS);
        const confirmedNick = directChild(inner, 'nick')?.textContent?.trim() || nick;
        this.emit('channel-joined', { channelJid, nick: confirmedNick });
        this.refreshInfo(channelJid);
        this.refreshParticipants(channelJid);
        resolve({ channelJid, nick: confirmedNick });
      }, (error) => reject(new Error(errorText(error))));
    });
  }

  leaveChannel(channelJid) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { resolve(channelJid); return; }
      const leave = xmlElement(MIX_CORE_NS, 'leave');
      const clientLeave = xmlElement(MIX_PAM_NS, 'client-leave', { channel: channelJid });
      clientLeave.append(leave);
      this.connection.sendIQ(this.mixIq(this.jid, clientLeave), () => {
        this.emit('channel-left', { channelJid });
        resolve(channelJid);
      }, (error) => reject(new Error(errorText(error))));
    });
  }

  // Group messages carry a client-generated id.  The caller renders a pending
  // row keyed by that id and swaps it for the server echo when it arrives.
  sendGroupMessage(channelJid, text) {
    if (!this.connected) return null;
    const id = this.uniqueId('msg');
    const message = xmlElement(CLIENT_NS, 'message', {
      to: channelJid,
      type: 'groupchat',
      id,
    });
    message.append(xmlElement(CLIENT_NS, 'body', {}, text));
    this.connection.send(message);
    return id;
  }

  // XEP-0313 MAM on the channel JID.  An empty <before/> asks for the newest
  // page while keeping chronological result order (XEP-0059).  A stanza id in
  // <before> pages further back.
  loadHistory(channelJid, before = null) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Sign in to load messages.')); return; }
      const queryId = this.uniqueId('mam-query');
      const query = xmlElement(MAM_NS, 'query', { queryid: queryId });
      const resultSet = xmlElement(RSM_NS, 'set');
      resultSet.append(
        xmlElement(RSM_NS, 'max', {}, String(HISTORY_PAGE_SIZE)),
        before
          ? xmlElement(RSM_NS, 'before', {}, before)
          : xmlElement(RSM_NS, 'before'),
      );
      query.append(resultSet);
      const iq = xmlElement(CLIENT_NS, 'iq', {
        type: 'set',
        to: channelJid,
        id: this.uniqueId('mam'),
      });
      iq.append(query);
      this.pendingHistory.set(queryId, { channelJid, messages: [] });
      this.connection.sendIQ(iq, (result) => {
        const pending = this.pendingHistory.get(queryId);
        this.pendingHistory.delete(queryId);
        if (!pending) return;
        const fin = directChild(result, 'fin', MAM_NS);
        const complete = fin?.getAttribute('complete') === 'true'
          || pending.messages.length < HISTORY_PAGE_SIZE;
        this.emit('history', { channelJid, messages: pending.messages, complete, queryId });
        resolve({ channelJid, messages: pending.messages, complete });
      }, (error) => {
        this.pendingHistory.delete(queryId);
        reject(new Error(errorText(error)));
      });
    });
  }

  refreshParticipants(channelJid) {
    if (!this.connected) return;
    this.fetchItems(channelJid, NODE_PARTICIPANTS, (items) => {
      const participants = items.map((item) => {
        const participant = directChild(item, 'participant', MIX_CORE_NS)
          || directChild(item, 'participant', MIX_CORE_0_NS);
        const nick = directChild(participant, 'nick')?.textContent?.trim() || null;
        const jid = directChild(participant, 'jid')?.textContent?.trim() || null;
        return { id: item.getAttribute('id'), nick, jid, label: nick || jid || item.getAttribute('id') };
      });
      this.emit('participants', { channelJid, participants });
    });
  }

  refreshInfo(channelJid) {
    if (!this.connected) return;
    this.fetchItems(channelJid, NODE_INFO, (items) => {
      const latest = items[items.length - 1];
      const form = directChild(latest, 'x', DATA_FORM_NS);
      const info = { name: null, contact: [] };
      for (const field of directChildren(form, 'field', DATA_FORM_NS)) {
        const variable = field.getAttribute('var');
        const values = directChildren(field, 'value', DATA_FORM_NS)
          .map((value) => value.textContent.trim())
          .filter(Boolean);
        if (variable === 'Name') info.name = values[0] || null;
        if (variable === 'Contact') info.contact = values;
      }
      this.emit('info', { channelJid, info });
    });
  }

  fetchItems(channelJid, node, onItems) {
    const pubsub = xmlElement(PUBSUB_NS, 'pubsub');
    pubsub.append(xmlElement(PUBSUB_NS, 'items', { node }));
    const iq = xmlElement(CLIENT_NS, 'iq', {
      type: 'get',
      to: channelJid,
      id: this.uniqueId('items'),
    });
    iq.append(pubsub);
    this.connection.sendIQ(iq, (result) => {
      const container = directChild(result, 'pubsub', PUBSUB_NS);
      const items = directChild(container, 'items', PUBSUB_NS);
      onItems(directChildren(items, 'item', PUBSUB_NS));
    }, () => {
      // A node that is not readable yet is not an error worth showing.
    });
  }

  parseBodyMessage(stanza, { stamp = null, archiveId = null } = {}) {
    const body = directChild(stanza, 'body');
    if (!body) return null;
    const sender = messageSender(stanza);
    const delay = directChild(stanza, 'delay', DELAY_NS);
    const stampText = stamp || delay?.getAttribute('stamp') || null;
    const parsedStamp = stampText ? Date.parse(stampText) : Number.NaN;
    // XEP-0369: the channel reflects the sender's own message with the
    // client's original id in <mix><submission-id>, and gives the stanza a
    // new server id.  The store uses submission-id to replace the pending row.
    const submissionId = directChild(mixElement(stanza), 'submission-id')?.textContent?.trim() || null;
    const stanzaIdElement = Array.from(stanza.children).find((child) => (
      child.localName === 'stanza-id' && child.namespaceURI === 'urn:xmpp:sid:0'
    ));
    return {
      id: stanza.getAttribute('id') || archiveId || `local-${Math.random().toString(36).slice(2)}`,
      archiveId: archiveId || stanzaIdElement?.getAttribute('id') || null,
      submissionId,
      from: sender.from,
      nick: sender.nick,
      senderJid: sender.jid,
      label: sender.label,
      text: body.textContent,
      timestamp: Number.isNaN(parsedStamp) ? Date.now() : parsedStamp,
      pending: false,
    };
  }

  handleMessage(message) {
    const mamResult = directChild(message, 'result', MAM_NS);
    if (mamResult) {
      const pending = this.pendingHistory.get(mamResult.getAttribute('queryid'));
      if (!pending) return true;
      const forwarded = directChild(mamResult, 'forwarded', FORWARD_NS);
      const archived = directChild(forwarded, 'message');
      const delay = directChild(forwarded, 'delay', DELAY_NS);
      const parsed = archived && this.parseBodyMessage(archived, {
        stamp: delay?.getAttribute('stamp') || null,
        archiveId: mamResult.getAttribute('id'),
      });
      if (parsed) pending.messages.push(parsed);
      return true;
    }
    const event = directChild(message, 'event', PUBSUB_EVENT_NS);
    if (event) {
      const items = directChild(event, 'items', PUBSUB_EVENT_NS);
      const node = items?.getAttribute('node');
      const channelJid = String(message.getAttribute('from') || '').split('/')[0];
      if (node === NODE_PARTICIPANTS) this.refreshParticipants(channelJid);
      if (node === NODE_INFO) this.refreshInfo(channelJid);
      return true;
    }
    const parsed = this.parseBodyMessage(message);
    if (parsed) {
      const channelJid = String(message.getAttribute('from') || '').split('/')[0];
      this.emit('message', { channelJid, message: parsed });
    }
    return true;
  }
}

export const xmpp = new XmppClient();
