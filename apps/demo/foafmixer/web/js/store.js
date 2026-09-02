// Application state.  Components read `store.state`, call the methods below,
// and re-render when the store emits `change`.  Nothing here talks to Strophe.

export const SESSION_KEY = 'foafmixer-browser-session-v2';
const LEGACY_SESSION_KEY = 'foafmixer-browser-session-v1';
const SETTINGS_KEY = 'foafmixer-settings-v1';
const DRAFTS_KEY = 'foafmixer-drafts-v1';
export const SESSION_IDLE_MS = 20 * 60 * 1000;
export const DEFAULT_SERVICE = 'mix.foafmixer.test';
export const DEFAULT_CHANNEL = 'factoidal';
export const DEFAULT_PORT = '8444';
export const SUPPORTED_PORTS = ['8444'];
// Consecutive messages from the same sender inside this window are grouped.
export const GROUPING_WINDOW_MS = 5 * 60 * 1000;

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || 'null');
  } catch (_) {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // A browser with storage disabled still runs; it just forgets.
  }
}

function defaultSettings() {
  return { theme: 'system', sendKey: 'enter' };
}

export class Store extends EventTarget {
  constructor() {
    super();
    const settings = { ...defaultSettings(), ...(readJson(localStorage, SETTINGS_KEY) || {}) };
    if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
    if (!['enter', 'modifier'].includes(settings.sendKey)) settings.sendKey = 'enter';
    this.state = {
      status: 'disconnected',
      jid: null,
      host: location.hostname,
      port: DEFAULT_PORT,
      rememberSession: true,
      signInMessage: 'Sign in with your XMPP account to read and post.',
      signInTone: 'info',
      channels: [],
      activeChannel: null,
      detailsOpen: false,
      view: 'channels',
      settings,
      stropheLoaded: true,
    };
    this.drafts = readJson(sessionStorage, DRAFTS_KEY) || {};
    this.logoutTimer = null;
  }

  commit() {
    this.dispatchEvent(new Event('change'));
  }

  // --- settings -----------------------------------------------------------

  setSetting(key, value) {
    this.state.settings = { ...this.state.settings, [key]: value };
    writeJson(localStorage, SETTINGS_KEY, this.state.settings);
    this.commit();
  }

  // --- connection ---------------------------------------------------------

  setStatus(status, message = null, tone = 'info') {
    this.state.status = status;
    if (message !== null) {
      this.state.signInMessage = message;
      this.state.signInTone = tone;
    }
    this.commit();
  }

  setConnected(jid, host, port) {
    this.state.status = 'connected';
    this.state.jid = jid;
    this.state.host = host;
    this.state.port = port;
    this.state.signInMessage = `Signed in as ${jid}.`;
    this.state.signInTone = 'info';
    for (const channel of this.state.channels) channel.joined = false;
    this.commit();
  }

  setDisconnected(message, tone = 'info') {
    this.state.status = 'disconnected';
    this.state.jid = null;
    for (const channel of this.state.channels) {
      channel.joined = false;
      channel.participants = [];
    }
    this.state.signInMessage = message;
    this.state.signInTone = tone;
    this.commit();
  }

  // --- channels -----------------------------------------------------------

  channel(jid) {
    return this.state.channels.find((candidate) => candidate.jid === jid) || null;
  }

  get active() {
    return this.channel(this.state.activeChannel);
  }

  ensureChannel(jid, nick = null) {
    let channel = this.channel(jid);
    if (!channel) {
      channel = {
        jid,
        nick: nick || null,
        name: null,
        contact: [],
        participants: [],
        messages: [],
        unread: 0,
        firstUnreadId: null,
        joined: false,
        historyComplete: false,
        historyLoading: false,
        oldestArchiveId: null,
      };
      this.state.channels.push(channel);
      this.state.channels.sort((a, b) => a.jid.localeCompare(b.jid));
    }
    if (nick) channel.nick = nick;
    return channel;
  }

  markJoined(jid, nick) {
    const channel = this.ensureChannel(jid, nick);
    channel.joined = true;
    this.commit();
    return channel;
  }

  removeChannel(jid) {
    this.state.channels = this.state.channels.filter((channel) => channel.jid !== jid);
    if (this.state.activeChannel === jid) {
      this.state.activeChannel = this.state.channels[0]?.jid || null;
      if (!this.state.activeChannel) this.state.view = 'channels';
    }
    delete this.drafts[jid];
    writeJson(sessionStorage, DRAFTS_KEY, this.drafts);
    this.saveSession();
    this.commit();
  }

  setActiveChannel(jid, { view = null } = {}) {
    this.state.activeChannel = jid;
    const channel = this.channel(jid);
    if (channel) {
      channel.unread = 0;
      channel.firstUnreadId = null;
    }
    if (view) this.state.view = view;
    this.saveSession();
    this.commit();
  }

  setView(view) {
    this.state.view = view;
    this.commit();
  }

  setDetailsOpen(open) {
    this.state.detailsOpen = open;
    this.commit();
  }

  // --- messages -----------------------------------------------------------

  addPending(jid, { id, text }) {
    const channel = this.ensureChannel(jid);
    channel.messages.push({
      id,
      archiveId: null,
      from: this.state.jid,
      nick: channel.nick,
      senderJid: this.state.jid,
      label: channel.nick || this.state.jid,
      text,
      timestamp: Date.now(),
      pending: true,
      own: true,
    });
    this.sortMessages(channel);
    this.commit();
  }

  // De-duplication is by stanza id, so the server echo replaces the pending
  // row rather than adding a second copy of the same message.
  addMessage(jid, message, { isActive = false } = {}) {
    const channel = this.ensureChannel(jid);
    const own = Boolean(this.state.jid && message.senderJid
      && message.senderJid.split('/')[0] === this.state.jid.split('/')[0]);
    const incoming = { ...message, own, pending: false };
    // Match the server echo to the pending row by the MIX submission-id; match
    // everything else (redeliveries, history overlap) by the server's id.
    const existing = channel.messages.findIndex((candidate) => (
      candidate.id === incoming.id
      || (incoming.submissionId && candidate.pending && candidate.id === incoming.submissionId)
    ));
    if (existing >= 0) {
      const previous = channel.messages[existing];
      channel.messages[existing] = { ...incoming, own: previous.own || own };
    } else {
      channel.messages.push(incoming);
      if (!isActive && !own) {
        channel.unread += 1;
        if (!channel.firstUnreadId) channel.firstUnreadId = incoming.id;
      }
    }
    this.sortMessages(channel);
    this.commit();
    return existing < 0;
  }

  mergeHistory(jid, messages, complete) {
    const channel = this.ensureChannel(jid);
    const seen = new Set(channel.messages.map((message) => message.id));
    let oldest = channel.oldestArchiveId;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const message of messages) {
      const own = Boolean(this.state.jid && message.senderJid
        && message.senderJid.split('/')[0] === this.state.jid.split('/')[0]);
      if (message.timestamp < oldestTimestamp && message.archiveId) {
        oldestTimestamp = message.timestamp;
        oldest = message.archiveId;
      }
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      channel.messages.push({ ...message, own, pending: false, historic: true });
    }
    channel.oldestArchiveId = oldest;
    channel.historyComplete = complete;
    channel.historyLoading = false;
    this.sortMessages(channel);
    this.commit();
  }

  setHistoryLoading(jid, loading) {
    const channel = this.channel(jid);
    if (!channel) return;
    channel.historyLoading = loading;
    this.commit();
  }

  sortMessages(channel) {
    channel.messages.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
  }

  setParticipants(jid, participants) {
    const channel = this.channel(jid);
    if (!channel) return;
    channel.participants = participants;
    this.commit();
  }

  setInfo(jid, info) {
    const channel = this.channel(jid);
    if (!channel) return;
    channel.name = info.name || null;
    channel.contact = info.contact || [];
    this.commit();
  }

  // --- drafts -------------------------------------------------------------

  draft(jid) {
    return this.drafts[jid] || '';
  }

  setDraft(jid, text) {
    if (!jid) return;
    if (text) this.drafts[jid] = text;
    else delete this.drafts[jid];
    writeJson(sessionStorage, DRAFTS_KEY, this.drafts);
  }

  // --- session ------------------------------------------------------------

  saveSession() {
    if (!this.state.rememberSession || !this.state.jid) return;
    writeJson(sessionStorage, SESSION_KEY, {
      jid: this.state.jid,
      websocketHost: this.state.host,
      websocketPort: this.state.port,
      channelJid: this.state.activeChannel,
      channels: this.state.channels.map((channel) => ({ jid: channel.jid, nick: channel.nick })),
      expiresAt: Date.now() + SESSION_IDLE_MS,
    });
    this.scheduleLogout();
  }

  clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
    } catch (_) {
      // ignore
    }
    clearTimeout(this.logoutTimer);
    this.logoutTimer = null;
  }

  scheduleLogout() {
    clearTimeout(this.logoutTimer);
    const saved = readJson(sessionStorage, SESSION_KEY);
    if (!saved?.expiresAt) return;
    const remaining = saved.expiresAt - Date.now();
    if (remaining <= 0) {
      this.onIdleLogout?.();
      return;
    }
    this.logoutTimer = setTimeout(() => this.onIdleLogout?.(), remaining);
  }

  touchSession() {
    if (this.state.status !== 'connected' || !this.state.rememberSession) return;
    this.saveSession();
  }

  // Restores JID, WebSocket host and port and the remembered channels.  The
  // password is never stored; signing in stays an explicit user action.
  restoreSession() {
    let saved = readJson(sessionStorage, SESSION_KEY);
    if (!saved) {
      const legacy = readJson(sessionStorage, LEGACY_SESSION_KEY);
      if (legacy?.expiresAt > Date.now()) {
        saved = {
          jid: legacy.jid,
          websocketHost: legacy.websocketHost,
          websocketPort: legacy.websocketPort,
          channelJid: legacy.channelJid || null,
          channels: legacy.channelJid ? [{ jid: legacy.channelJid, nick: null }] : [],
          expiresAt: legacy.expiresAt,
        };
      }
    }
    if (!saved) return false;
    if (!(saved.expiresAt > Date.now())) {
      this.clearSession();
      return false;
    }
    // Older pilot sessions stored a password.  Drop it on sight.
    if ('password' in saved) delete saved.password;
    // The separate patched-test endpoint was retired after the patched server
    // became the pilot.  Move pre-cutover sessions to the canonical port.
    if (saved.websocketPort === '15281') saved.websocketPort = DEFAULT_PORT;
    if (!SUPPORTED_PORTS.includes(saved.websocketPort)) saved.websocketPort = DEFAULT_PORT;
    this.state.jid = null;
    this.state.restoredJid = saved.jid || null;
    this.state.host = saved.websocketHost || location.hostname;
    this.state.port = saved.websocketPort;
    this.state.rememberSession = true;
    for (const entry of saved.channels || []) this.ensureChannel(entry.jid, entry.nick);
    this.state.activeChannel = saved.channelJid || this.state.channels[0]?.jid || null;
    this.state.signInMessage = 'Connection details restored. Enter your password to sign in.';
    writeJson(sessionStorage, SESSION_KEY, saved);
    this.scheduleLogout();
    this.commit();
    return true;
  }
}

export const store = new Store();
