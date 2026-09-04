#!/usr/bin/env node
// Talkie-LM / MIX bridge bot for the Foafmixer pilot -- Node.js port of
// talkie_bridge.py (kept for reference/comparison). Rewritten in JS so this
// process can eventually `import` @factoidal/core directly (RDF/SPARQL over
// the running store) instead of shelling out or bridging across languages.
//
// Connects to the loopback MIX server as the account named in
// FOAFMIXER_PURPLEGUEST_JIDANDPWD ("<jid> <password>"), joins a channel, and
// answers messages using a local llama.cpp server (llama-server,
// OpenAI-compatible /v1/chat/completions).
//
// Dependency-free (Node builtins only: net, fs, crypto, fetch) -- same
// raw-socket approach as ejabberd-xmpp-mix-patches/tools/mix-probe.py and
// the Python version of this bridge.
//
// Environment: see talkie_bridge.py's docstring -- identical variable names,
// behaviour, and defaults, including:
//   FOAFMIXER_PURPLEGUEST_JIDANDPWD, TALKIE_CHANNEL, TALKIE_NICK,
//   TALKIE_HOST, TALKIE_PORT, TALKIE_LLAMA_URL, TALKIE_REQUIRE_ADDRESS,
//   TALKIE_SYSTEM_PROMPT, TALKIE_OWNER_NICKS, TALKIE_OWNER_JIDS,
//   TALKIE_BOT_REGISTRY

import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST = process.env.TALKIE_HOST || '127.0.0.1';
const PORT = Number(process.env.TALKIE_PORT || '5222');
const CHANNEL_NAME = process.env.TALKIE_CHANNEL || 'factoidal';
const NICK = process.env.TALKIE_NICK || 'Talkie';
const LLAMA_URL = process.env.TALKIE_LLAMA_URL || 'http://127.0.0.1:8188';
const MANAGER_URL = process.env.TALKIE_MANAGER_URL || 'http://127.0.0.1:8199';
// model-manager.mjs stops idle llama-server backends to free RAM; this maps
// our own backend port to its name so we can pre-warm/ensure it's up.
const BACKEND_NAME = { '8188': 'talkie', '8189': 'qwen' }[new URL(LLAMA_URL).port] || null;

/** Fire-and-forget: bump activity and start the backend if it's stopped. */
function touchBackend() {
  if (!BACKEND_NAME) return;
  fetch(`${MANAGER_URL}/touch/${BACKEND_NAME}`, { method: 'POST' }).catch(() => {});
}

/** Block until the backend is actually up (starting it if needed). */
async function ensureBackend() {
  if (!BACKEND_NAME) return true;
  try {
    const resp = await fetch(`${MANAGER_URL}/ensure/${BACKEND_NAME}`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });
    return resp.ok;
  } catch {
    return true; // no manager running -- assume the caller manages llama-server itself
  }
}
const REQUIRE_ADDRESS = !['', '0', 'false'].includes(process.env.TALKIE_REQUIRE_ADDRESS || '');
const OWNER_NICKS = new Set(
  (process.env.TALKIE_OWNER_NICKS || 'danbri,danbri_lap,dantest')
    .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean),
);

const DEFAULT_SYSTEM_PROMPT = (
  'You are Talkie, a participant in a live XMPP MIX group chat channel. '
  + 'You are the Talkie-1930 language model, trained only on pre-1931 '
  + 'English text, so your voice is that of a 1930s correspondent -- '
  + 'period vocabulary and manners, no anachronisms. Directly answer or '
  + 'react to what the other person actually just said, using the '
  + "conversation so far for context -- do not fall back to a generic "
  + "pleasantry like 'thank you, I am well' unless the message truly is "
  + 'small talk. Keep replies to two or three sentences. Do not prefix '
  + 'your reply with your own name.'
);
const SYSTEM_PROMPT = process.env.TALKIE_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

const HISTORY_TURNS = 8; // user+assistant messages kept, i.e. ~4 exchanges

function xmlEscape(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function parseCredentials() {
  const raw = process.env.FOAFMIXER_PURPLEGUEST_JIDANDPWD || '';
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length !== 2 || !parts[0].includes('@')) {
    console.error("set FOAFMIXER_PURPLEGUEST_JIDANDPWD to '<user>@<domain> <password>'");
    process.exit(2);
  }
  const [jid, password] = parts;
  const [user, domain] = jid.split('@', 2);
  return { user, domain, password };
}

class XmppStream {
  constructor(host, port) {
    this.sock = netConnect({ host, port });
    this.buffer = Buffer.alloc(0);
    this._waiters = [];
    this.sock.on('data', (chunk) => this._onData(chunk));
    this.sock.on('error', (err) => this._onError(err));
    this.sock.on('close', () => this._onError(new Error('XMPP socket closed')));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._checkWaiters();
  }

  _onError(err) {
    for (const waiter of this._waiters.splice(0)) waiter.reject(err);
  }

  _checkWaiters() {
    for (let i = this._waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this._waiters[i];
      if (waiter.needles.every((n) => this.buffer.includes(n))) {
        this._waiters.splice(i, 1);
        const data = this.buffer;
        this.buffer = Buffer.alloc(0);
        waiter.resolve(data);
      }
    }
  }

  send(xml) {
    this.sock.write(Buffer.from(xml, 'utf-8'));
  }

  receiveUntil(...needlesAndOpts) {
    let timeout = 10000;
    let needleStrs = needlesAndOpts;
    if (typeof needlesAndOpts.at(-1) === 'object') {
      timeout = needlesAndOpts.at(-1).timeout ?? 10000;
      needleStrs = needlesAndOpts.slice(0, -1);
    }
    const needles = needleStrs.map((n) => Buffer.from(n, 'utf-8'));
    return new Promise((resolve, reject) => {
      const waiter = { needles, resolve, reject };
      const timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for ${needleStrs.join(', ')}`));
      }, timeout);
      waiter.resolve = (data) => { clearTimeout(timer); resolve(data); };
      waiter.reject = (err) => { clearTimeout(timer); reject(err); };
      this._waiters.push(waiter);
      this._checkWaiters();
    });
  }

  async iq(iqId, xml, { timeout = 10000 } = {}) {
    this.send(xml);
    return this.receiveUntil(iqId, { timeout });
  }

  async open(domain) {
    this.send(
      `<stream:stream to='${domain}' version='1.0' xmlns='jabber:client' `
      + "xmlns:stream='http://etherx.jabber.org/streams'>",
    );
    // 10s default elsewhere is too tight when the server itself is
    // CPU-starved by unrelated concurrent work.
    await this.receiveUntil('</stream:features>', { timeout: 30000 });
  }

  close() {
    try { this.send('</stream:stream>'); } finally { this.sock.destroy(); }
  }
}

const MESSAGE_RE = /<message\b[^>]*>[\s\S]*?<\/message>/g;
const FROM_RE = /from=['"]([^'"]+)['"]/;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/;
const TYPE_RE = /type=['"]([^'"]+)['"]/;
const ID_RE = /<message\b[^>]*\bid=['"]([^'"]+)['"]/;
// MIX carries the human-chosen nick and, unless MIX-ANON hides it, the real
// bare jid inside <mix>...</mix> -- the `from` resource is an opaque
// per-participant session id, NOT the nick.
const MIX_BLOCK_RE = /<mix\b[^>]*>[\s\S]*?<\/mix>/;
const MIX_NICK_RE = /<nick>([\s\S]*?)<\/nick>/;
const MIX_JID_RE = /<jid>([\s\S]*?)<\/jid>/;

async function askTalkie(history, prompt, systemPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-HISTORY_TURNS),
    { role: 'user', content: prompt },
  ];
  const resp = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 100, temperature: 0.8 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

function loadKnownBotJids(bareJid) {
  const registryPath = process.env.TALKIE_BOT_REGISTRY
    || path.join(
      homedir(),
      'working/sandbox/mix/foafmixer-mix/apps/demo/foafmixer',
      '.foafmixer-account-responsibility.tsv',
    );
  const known = new Set();
  try {
    const lines = readFileSync(registryPath, 'utf-8').split('\n').slice(1);
    for (const line of lines) {
      const fields = line.replace(/\n$/, '').split('\t');
      if (fields.length >= 2 && fields[1] === 'bot') known.add(fields[0].trim().toLowerCase());
    }
  } catch (err) {
    console.error(
      `[talkie-bridge] could not read bot registry ${registryPath}: ${err.message} `
      + '-- cannot suppress replies to other bots, proceed with caution',
    );
  }
  known.delete(bareJid.toLowerCase());
  return known;
}

async function main() {
  const { user, domain, password } = parseCredentials();
  const bareJid = `${user}@${domain}`;
  const service = `mix.${domain}`;
  const channel = `${CHANNEL_NAME}@${service}`;

  const ownerJids = new Set(
    (process.env.TALKIE_OWNER_JIDS || `danbri@${domain},danbri_lap@${domain},dantest@${domain}`)
      .split(',').map((j) => j.trim().toLowerCase()).filter(Boolean),
  );
  // Two or more "reply to everything" bots in one channel is a guaranteed
  // infinite ping-pong (proven the hard way in the Python version: one
  // incident escalated to 47+ replies from a single bot before being
  // killed). A bot must never spontaneously reply to another known bot --
  // only to a human, or to a bot that explicitly addresses it by name --
  // regardless of this bot's own TALKIE_REQUIRE_ADDRESS setting.
  const knownBotJids = loadKnownBotJids(bareJid);

  const stream = new XmppStream(HOST, PORT);
  console.log(`[talkie-bridge] connecting as ${bareJid} to ${HOST}:${PORT}`);
  await stream.open(domain);
  const plain = Buffer.from(`\x00${user}\x00${password}`, 'utf-8').toString('base64');
  stream.send(`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${plain}</auth>`);
  const authResult = await stream.receiveUntil('success', { timeout: 30000 });
  if (!authResult.includes('<success')) {
    throw new Error('SASL PLAIN did not succeed -- check the password');
  }
  await stream.open(domain);
  const bound = await stream.iq(
    'bind',
    "<iq type='set' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>"
    + "<resource>talkie-bridge</resource></bind></iq>",
    { timeout: 30000 },
  );
  if (!bound.includes("type='result'") && !bound.includes('type="result"')) {
    throw new Error(`resource bind failed: ${bound}`);
  }
  stream.send('<presence/>');

  console.log(`[talkie-bridge] joining ${channel} as nick '${NICK}'`);
  const join = await stream.iq(
    'join',
    `<iq to='${bareJid}' type='set' id='join'>`
    + `<client-join channel='${channel}' xmlns='urn:xmpp:mix:pam:2'>`
    + `<join xmlns='urn:xmpp:mix:core:1'><nick>${xmlEscape(NICK)}</nick>`
    + "<subscribe node='urn:xmpp:mix:nodes:messages'/>"
    + "<subscribe node='urn:xmpp:mix:nodes:participants'/>"
    + '</join></client-join></iq>',
    { timeout: 30000 },
  );
  if (!join.includes("type='result'") && !join.includes('type="result"')) {
    throw new Error(`client-join failed: ${join}`);
  }
  console.log(`[talkie-bridge] joined. Listening for messages on ${channel} ...`);
  if (REQUIRE_ADDRESS) {
    console.log(`[talkie-bridge] reply-only-when-addressed mode: will only answer messages mentioning '${NICK}'`);
  }

  const escapedNick = NICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const addressRe = new RegExp(`\\b${escapedNick}\\b`, 'i');
  const stripPrefixRe = new RegExp(`^\\s*@?${escapedNick}\\s*[:,]?\\s*`, 'i');
  const syspromptCmdRe = new RegExp(`^\\s*${escapedNick}\\s*[,:]?\\s*sysprompt\\s*[:=]\\s*([\\s\\S]+)$`, 'i');
  let systemPrompt = SYSTEM_PROMPT;

  const sentIds = new Set();
  let replyTimes = [];
  const RATE_LIMIT_COUNT = 5;
  const RATE_LIMIT_WINDOW = 30000;
  let history = [];

  const bootstrapMarkerRe = /^__talkie_bootstrap_[0-9a-f]+__$/;
  const bootstrapMarker = `__talkie_bootstrap_${randomUUID().replace(/-/g, '')}__`;
  stream.send(
    `<message to='${channel}' type='groupchat' id='bootstrap'>`
    + `<body>${bootstrapMarker}</body></message>`,
  );
  let ownResource = null;

  let buf = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    let keepaliveTimer = null;
    const resetKeepalive = () => {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = setTimeout(() => stream.send(' '), 300000);
    };
    resetKeepalive();

    stream.sock.on('error', reject);
    stream.sock.on('close', () => reject(new Error('XMPP socket closed by server')));

    stream.sock.on('data', (chunk) => {
      resetKeepalive();
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf-8');

      MESSAGE_RE.lastIndex = 0;
      let match;
      let lastEnd = 0;
      while ((match = MESSAGE_RE.exec(text)) !== null) {
        lastEnd = MESSAGE_RE.lastIndex;
        const stanza = match[0];
        const typeMatch = TYPE_RE.exec(stanza);
        if (!typeMatch || typeMatch[1] !== 'groupchat') continue;

        const idMatch = ID_RE.exec(stanza);
        if (idMatch) {
          const stanzaId = idMatch[1];
          if (sentIds.has(stanzaId)) {
            sentIds.delete(stanzaId);
            continue; // our own echo, not a message to react to
          }
        }

        const fromMatch = FROM_RE.exec(stanza);
        const bodyMatch = BODY_RE.exec(stanza);
        if (!fromMatch || !bodyMatch) continue;

        const sender = fromMatch[1];
        // MIX channel membership is account-level and persistent (learned
        // the hard way): if this account is ever a member of more than one
        // channel, a groupchat message from a DIFFERENT channel can still
        // arrive here. Only handle messages from the channel this process
        // actually joined -- otherwise a reply meant for elsewhere gets
        // sent into `channel` instead.
        if (sender !== channel && !sender.startsWith(`${channel}/`)) continue;
        const senderResource = (sender !== channel && sender.includes('/'))
          ? sender.split('/', 2)[1] : sender;
        const body = xmlUnescape(bodyMatch[1]);

        if (ownResource === null && body === bootstrapMarker) {
          ownResource = senderResource;
          console.log(`[talkie-bridge] learned own MIX resource id: ${ownResource}`);
          continue;
        }
        if (ownResource !== null && senderResource === ownResource) continue; // our own echo
        if (bootstrapMarkerRe.test(body)) continue; // another bridge bot's own bootstrap probe

        if (!body.trim()) continue;

        const mixBlockMatch = MIX_BLOCK_RE.exec(stanza);
        let senderJid = null;
        let senderNick = senderResource;
        if (mixBlockMatch) {
          const nickM = MIX_NICK_RE.exec(mixBlockMatch[0]);
          const jidM = MIX_JID_RE.exec(mixBlockMatch[0]);
          if (nickM) senderNick = xmlUnescape(nickM[1]);
          if (jidM) senderJid = xmlUnescape(jidM[1]).toLowerCase();
        }
        const isOwner = senderJid
          ? ownerJids.has(senderJid)
          : OWNER_NICKS.has(senderNick.toLowerCase());

        console.log(`[talkie-bridge] <${senderNick}> ${body}`);
        // Pre-warm heuristic: any real message in the channel might turn
        // into something we're asked about soon, even if this exact one
        // isn't addressed to us -- start bringing the backend up now
        // rather than waiting until we're sure we need it.
        touchBackend();

        const cmdMatch = syspromptCmdRe.exec(body);
        if (cmdMatch) {
          let ack;
          if (isOwner) {
            systemPrompt = cmdMatch[1].trim();
            console.log(`[talkie-bridge] persona updated by ${senderJid || senderNick}: ${systemPrompt}`);
            ack = 'Persona updated.';
          } else {
            console.log(`[talkie-bridge] rejected sysprompt command from non-owner ${senderJid || senderNick}`);
            ack = 'Sorry, only my owner can change my persona.';
          }
          const ackId = `talkie-${NICK}-${Date.now()}`;
          sentIds.add(ackId);
          stream.send(
            `<message to='${channel}' type='groupchat' id='${ackId}'>`
            + `<body>${xmlEscape(ack)}</body></message>`,
          );
          continue;
        }

        const userTurn = { role: 'user', content: `${senderNick}: ${body}` };
        const senderIsBot = senderJid ? knownBotJids.has(senderJid) : false;
        const mustBeAddressed = REQUIRE_ADDRESS || senderIsBot;
        if (mustBeAddressed && !addressRe.test(body)) {
          history.push(userTurn);
          history = history.slice(-HISTORY_TURNS);
          continue;
        }

        const now = Date.now();
        replyTimes = replyTimes.filter((t) => now - t < RATE_LIMIT_WINDOW);
        if (replyTimes.length >= RATE_LIMIT_COUNT) {
          console.error(
            `[talkie-bridge] rate limit hit (${RATE_LIMIT_COUNT}/${RATE_LIMIT_WINDOW / 1000}s) `
            + '-- skipping reply, possible loop',
          );
          continue;
        }

        const prompt = body.replace(stripPrefixRe, '').trim() || body;
        (async () => {
          let reply;
          try {
            const ready = await ensureBackend();
            if (!ready) throw new Error(`${BACKEND_NAME} backend did not become ready in time`);
            reply = await askTalkie(history, prompt, systemPrompt);
          } catch (exc) {
            console.error(`[talkie-bridge] llama-server error: ${exc.message}`);
            return;
          }
          console.log(`[talkie-bridge] -> ${reply}`);
          history.push(userTurn);
          history.push({ role: 'assistant', content: reply });
          history = history.slice(-HISTORY_TURNS);
          const msgId = `talkie-${NICK}-${Date.now()}`;
          sentIds.add(msgId);
          replyTimes.push(now);
          stream.send(
            `<message to='${channel}' type='groupchat' id='${msgId}'>`
            + `<body>${xmlEscape(reply)}</body></message>`,
          );
        })();
      }

      // Trim the buffer up to the end of the last fully-matched message, so
      // it doesn't grow unbounded and so a message isn't reprocessed. Byte
      // offset, not the JS string index, since multi-byte UTF-8 chars would
      // otherwise misalign the two.
      if (lastEnd > 0) {
        const consumedBytes = Buffer.byteLength(text.slice(0, lastEnd), 'utf-8');
        buf = buf.subarray(consumedBytes);
      }
    });
  });
}

main().catch((err) => {
  console.error(`[talkie-bridge] fatal: ${err.stack || err}`);
  process.exit(1);
});
