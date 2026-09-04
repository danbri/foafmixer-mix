#!/usr/bin/env node
// SKOS query bot for the Foafmixer MIX pilot. Same MIX bridge machinery as
// talkie_bridge.mjs (connect, client-join, self-echo detection via a
// bootstrap marker, bot-to-bot suppression, rate limiting, the channel
// filter) but answers from the factoidal-skosgraphs store via
// ./skos-query.mjs instead of an LLM -- deterministic, no llama-server
// involved.
//
// Environment:
//   FOAFMIXER_PURPLEGUEST_JIDANDPWD  required, "user@domain password"
//   TALKIE_CHANNEL                   default "skos"
//   TALKIE_NICK                      default "skosbot"
//   TALKIE_HOST / TALKIE_PORT        default 127.0.0.1 / 5222 (C2S)
//   TALKIE_REQUIRE_ADDRESS           if set (e.g. "1"), only reply when
//                                    addressed by nick; unset/0 means
//                                    always reply (the point of giving it
//                                    its own #skos channel)
//   SKOS_STORE                       default /Users/danbri/working/factoidal-skosgraphs
//   TALKIE_BOT_REGISTRY              see talkie_bridge.mjs

import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { open as openStore, summary, labelSearch, graphCounts, crossGraphMatches } from './skos-query.mjs';

const HOST = process.env.TALKIE_HOST || '127.0.0.1';
const PORT = Number(process.env.TALKIE_PORT || '5222');
const CHANNEL_NAME = process.env.TALKIE_CHANNEL || 'skos';
const NICK = process.env.TALKIE_NICK || 'skosbot';
const REQUIRE_ADDRESS = !['', '0', 'false'].includes(process.env.TALKIE_REQUIRE_ADDRESS || '');
const STORE = process.env.SKOS_STORE || '/Users/danbri/working/factoidal-skosgraphs';
const MAX_ROWS = 8;

function xmlEscape(text) {
  return text
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlUnescape(text) {
  return text
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
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

function vocabularyOf(graphIri) {
  const trimmed = graphIri.replace(/[/#]$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('#'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

const HELP = [
  'skosbot -- SKOS concepts from the factoidal-skosgraphs store.',
  '  <word>            concepts whose prefLabel contains <word>',
  '  vocabs <word>     which vocabularies mention it, and how often',
  '  map <word>        cross-vocabulary exactMatch links',
  '  about             what this store holds',
  '  help              this text',
].join('\n');

function skosReply(rawText) {
  const text = rawText.trim();
  if (/^help$/i.test(text)) return HELP;
  if (/^about$/i.test(text)) {
    const { graphs, labels } = summary();
    return `${graphs} vocabularies, ${labels} preferred labels, at ${STORE}`;
  }

  const vocabsMatch = /^vocabs\s+(.+)$/i.exec(text);
  if (vocabsMatch) {
    const rows = graphCounts(vocabsMatch[1], MAX_ROWS);
    if (rows.length === 0) return `no vocabulary mentions "${vocabsMatch[1]}"`;
    return rows.map((r) => `${vocabularyOf(r.g)}: ${r.n}`).join('\n');
  }

  const mapMatch = /^map\s+(.+)$/i.exec(text);
  if (mapMatch) {
    const rows = crossGraphMatches(mapMatch[1], MAX_ROWS);
    if (rows.length === 0) return `no cross-vocabulary match for "${mapMatch[1]}"`;
    return rows
      .map((r) => `"${r.label}" (${vocabularyOf(r.from)}) → "${r.targetLabel}" [${vocabularyOf(r.to)}]\n  ${r.target}`)
      .join('\n');
  }

  const rows = labelSearch(text, MAX_ROWS);
  if (rows.length === 0) return `nothing found for "${text}"`;
  return rows.map((r) => `${vocabularyOf(r.g)}: "${r.label}"\n  ${r.c}`).join('\n');
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
      `[skosbot] could not read bot registry ${registryPath}: ${err.message} `
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
  const knownBotJids = loadKnownBotJids(bareJid);

  // Opening the handle costs ~2.5-3.5s, one time; every query after that
  // is ~150-500ms (was 25-48s per query, unconditionally, before
  // @factoidal/core 0.5.1 -- see danbri/factoidal#654). Kicked off
  // alongside the XMPP connection rather than before it, then awaited
  // just before it's actually needed.
  const storeReady = openStore(STORE);

  const stream = new XmppStream(HOST, PORT);
  console.log(`[skosbot] connecting as ${bareJid} to ${HOST}:${PORT}`);
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
    + `<resource>skosbot-bridge-${CHANNEL_NAME}</resource></bind></iq>`,
    { timeout: 30000 },
  );
  if (!bound.includes("type='result'") && !bound.includes('type="result"')) {
    throw new Error(`resource bind failed: ${bound}`);
  }
  stream.send('<presence/>');

  console.log(`[skosbot] joining ${channel} as nick '${NICK}'`);
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
  console.log(`[skosbot] joined. Listening for messages on ${channel} ...`);
  if (REQUIRE_ADDRESS) {
    console.log(`[skosbot] reply-only-when-addressed mode: will only answer messages mentioning '${NICK}'`);
  }
  await storeReady;
  console.log(`[skosbot] store handle open: ${STORE}`);

  const escapedNick = NICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const addressRe = new RegExp(`\\b${escapedNick}\\b`, 'i');
  const stripPrefixRe = new RegExp(`^\\s*@?${escapedNick}\\s*[:,]?\\s*`, 'i');

  const sentIds = new Set();
  let replyTimes = [];
  const RATE_LIMIT_COUNT = 5;
  const RATE_LIMIT_WINDOW = 30000;

  // Queries are fast enough now (~150-500ms) not to need serializing, but
  // a light cache still helps popular repeated terms skip that cost
  // entirely. Bounded and FIFO-evicted -- not trying to be a real LRU.
  const CACHE_MAX = 200;
  const queryCache = new Map();
  function cachedReply(key, compute) {
    if (queryCache.has(key)) return queryCache.get(key);
    const reply = compute();
    queryCache.set(key, reply);
    if (queryCache.size > CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    return reply;
  }

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

        const fromMatch = FROM_RE.exec(stanza);
        const bodyMatch = BODY_RE.exec(stanza);
        if (!fromMatch || !bodyMatch) continue;

        const sender = fromMatch[1];
        // Only handle messages from the channel this process actually
        // joined -- MIX channel membership is account-level and persistent.
        if (sender !== channel && !sender.startsWith(`${channel}/`)) continue;
        const senderResource = (sender !== channel && sender.includes('/'))
          ? sender.split('/', 2)[1] : sender;
        const body = xmlUnescape(bodyMatch[1]);

        if (ownResource === null && body === bootstrapMarker) {
          ownResource = senderResource;
          console.log(`[skosbot] learned own MIX resource id: ${ownResource}`);
          continue;
        }
        if (ownResource !== null && senderResource === ownResource) continue;
        if (bootstrapMarkerRe.test(body)) continue;
        if (!body.trim()) continue;

        const mixBlockMatch = /<mix\b[^>]*>[\s\S]*?<\/mix>/.exec(stanza);
        let senderJid = null;
        let senderNick = senderResource;
        if (mixBlockMatch) {
          const nickM = /<nick>([\s\S]*?)<\/nick>/.exec(mixBlockMatch[0]);
          const jidM = /<jid>([\s\S]*?)<\/jid>/.exec(mixBlockMatch[0]);
          if (nickM) senderNick = xmlUnescape(nickM[1]);
          if (jidM) senderJid = xmlUnescape(jidM[1]).toLowerCase();
        }

        console.log(`[skosbot] <${senderNick}> ${body}`);

        const senderIsBot = senderJid ? knownBotJids.has(senderJid) : false;
        const mustBeAddressed = REQUIRE_ADDRESS || senderIsBot;
        if (mustBeAddressed && !addressRe.test(body)) continue;

        const now = Date.now();
        replyTimes = replyTimes.filter((t) => now - t < RATE_LIMIT_WINDOW);
        if (replyTimes.length >= RATE_LIMIT_COUNT) {
          console.error(`[skosbot] rate limit hit -- skipping reply, possible loop`);
          continue;
        }

        const query = (stripPrefixRe.test(body) ? body.replace(stripPrefixRe, '') : body).trim();
        const cacheKey = (query || body).toLowerCase();
        let reply;
        try {
          reply = cachedReply(cacheKey, () => skosReply(query || body));
        } catch (exc) {
          console.error(`[skosbot] query error: ${exc.message}`);
          reply = `query failed: ${exc.message.split('\n')[0]}`;
        }
        console.log(`[skosbot] -> ${reply}`);
        const msgId = `skosbot-${Date.now()}`;
        sentIds.add(msgId);
        replyTimes.push(now);
        stream.send(
          `<message to='${channel}' type='groupchat' id='${msgId}'>`
          + `<body>${xmlEscape(reply)}</body></message>`,
        );
      }

      if (lastEnd > 0) {
        const consumedBytes = Buffer.byteLength(text.slice(0, lastEnd), 'utf-8');
        buf = buf.subarray(consumedBytes);
      }
    });
  });
}

main().catch((err) => {
  console.error(`[skosbot] fatal: ${err.stack || err}`);
  process.exit(1);
});
