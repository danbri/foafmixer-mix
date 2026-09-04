#!/usr/bin/env node
// SPINACH-inspired tool-using SKOS agent for the Foafmixer MIX pilot.
//
// skosbot.mjs answers a small fixed command grammar ("vocabs water",
// "map building") against the SKOS store directly -- no LLM. This bot
// answers open natural-language questions by giving an LLM (Qwen3, via
// llama-server) a small set of the SAME store-query functions as native
// OpenAI-style tools, and looping: the model picks a tool + arguments,
// gets a real result back, and either asks for another tool or answers.
//
// This is deliberately NOT "the LLM writes SPARQL" -- see
// danbri/factoidal#654 and this repo's notes on the store's predicate-cap
// and SCOPE constraints for why that's fragile with a small model. Instead
// the tool set IS the same four parameterized, pre-validated queries
// skosbot.mjs already exposes (search/vocabs/map/summary); the model's job
// is picking which one(s) answer the question and extracting the right
// argument -- entity/term resolution and incremental exploration, not
// query synthesis. Modeled on the Stanford SPINACH agent
// (arxiv.org/abs/2407.11417): a bounded ReAct-style loop -- reason, call a
// tool, observe a REAL result, repeat -- rather than one-shot generation.
// Unlike SPINACH (GPT-4o, 30-step budget, a separate LLM call just to
// reformat free text into strict JSON), this uses llama-server's native
// grammar-constrained tool-calling directly -- verified empirically against
// this exact model/build to reliably pick the right tool, extract the
// right argument, and correctly call no tool at all for plain chit-chat --
// so no second "make this valid JSON" call is needed, and the step budget
// is much smaller (4) since a local 4B model is the whole point here, not
// a research ceiling to push against.
//
// Environment:
//   FOAFMIXER_PURPLEGUEST_JIDANDPWD  required, "user@domain password"
//   TALKIE_CHANNEL                   default "skos"
//   TALKIE_NICK                      default "spinach"
//   TALKIE_HOST / TALKIE_PORT        default 127.0.0.1 / 5222 (C2S)
//   TALKIE_LLAMA_URL                 default http://127.0.0.1:8189 (Qwen)
//   TALKIE_REQUIRE_ADDRESS           default true for this bot (unlike the
//                                    always-on chat bots, it only answers
//                                    when addressed -- an agent loop
//                                    costs real time/tokens per question)
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
const NICK = process.env.TALKIE_NICK || 'spinach';
const LLAMA_URL = process.env.TALKIE_LLAMA_URL || 'http://127.0.0.1:8189';
const MANAGER_URL = process.env.TALKIE_MANAGER_URL || 'http://127.0.0.1:8199';
const REQUIRE_ADDRESS = !['0', 'false'].includes(process.env.TALKIE_REQUIRE_ADDRESS ?? '1');
const STORE = process.env.SKOS_STORE || '/Users/danbri/working/factoidal-skosgraphs';

const MAX_STEPS = 4; // bounded ReAct loop: reason -> tool -> observe, x4 max
// Normal load: a Qwen call is ~1-2s. Observed the whole machine under a
// load average over 100 from unrelated concurrent work (another session's
// parallel Lean builds), at which point a single call missed even 30s.
// These are generous specifically for that kind of spike, not the norm.
const STEP_TIMEOUT_MS = 60000; // per LLM call
const OVERALL_TIMEOUT_MS = 180000; // whole question, all steps combined

const SYSTEM_PROMPT = process.env.TALKIE_SYSTEM_PROMPT || (
  'You are spinach, a research assistant for a SKOS vocabulary store '
  + `(${STORE.split('/').pop()}, 141 vocabularies, 45,806 preferred labels) `
  + 'in a live XMPP MIX group chat channel. Use the tools to find real facts '
  + 'before answering any question about concepts, vocabularies, or '
  + 'cross-vocabulary links -- never guess or invent an IRI, vocabulary name, '
  + 'or count. For plain greetings or chit-chat, just reply normally with no '
  + 'tool call. When you do have tool results, answer in two or three '
  + 'sentences, citing the vocabulary name (and IRI, if one came back). If '
  + "the tools don't turn up anything relevant, say so plainly instead of "
  + 'making something up.'
);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_labels',
      description: 'Search the SKOS store for concepts whose prefLabel contains a term. Returns up to 8 matches with their vocabulary and IRI.',
      parameters: { type: 'object', properties: { term: { type: 'string', description: 'word or phrase to search for' } }, required: ['term'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vocabularies_mentioning',
      description: 'Which vocabularies (named graphs) mention a term, and how many times. Use this to find which vocabulary is most relevant to a topic.',
      parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cross_vocabulary_match',
      description: 'Find a concept in one vocabulary and what it is declared exactMatch to in a different vocabulary (e.g. linking a local term to its Wikidata equivalent).',
      parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_summary',
      description: 'Overview of the store: how many vocabularies and labels it holds in total.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function vocabularyOf(graphIri) {
  const trimmed = graphIri.replace(/[/#]$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('#'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

// Each tool wraps the exact same skos-query.mjs functions skosbot.mjs uses
// -- same store handle, same ~150-500ms cost, no new query surface. The
// model never sees a store handle or SPARQL; only these JSON shapes.
const TOOL_IMPLS = {
  search_labels: ({ term }) => labelSearch(term, 8).map((r) => (
    { vocabulary: vocabularyOf(r.g), concept: r.c, label: r.label }
  )),
  vocabularies_mentioning: ({ term }) => graphCounts(term, 8).map((r) => (
    { vocabulary: vocabularyOf(r.g), count: Number(r.n) }
  )),
  cross_vocabulary_match: ({ term }) => crossGraphMatches(term, 8).map((r) => (
    { from: vocabularyOf(r.from), label: r.label, to: vocabularyOf(r.to), target: r.target, targetLabel: r.targetLabel }
  )),
  store_summary: () => summary(),
};

function runTool(name, argsJson) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `unknown tool: ${name}` };
  let args = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { return { error: `bad arguments JSON: ${argsJson}` }; }
  try {
    const result = impl(args);
    return Array.isArray(result) && result.length === 0 ? { result: [], note: 'no matches' } : { result };
  } catch (exc) {
    return { error: exc.message };
  }
}

async function ensureBackend() {
  try {
    const resp = await fetch(`${MANAGER_URL}/ensure/qwen`, { method: 'POST', signal: AbortSignal.timeout(60000) });
    return resp.ok;
  } catch {
    return true; // no manager running -- assume the caller manages llama-server itself
  }
}

async function callModel(messages, useTools) {
  const resp = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ...(useTools ? { tools: TOOLS } : {}),
      max_tokens: 200,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message;
}

/**
 * The bounded ReAct loop: ask the model, run whatever tool it picks, feed
 * the real result back, repeat. Stops as soon as the model answers with
 * plain content instead of a tool call, or after MAX_STEPS, or after
 * OVERALL_TIMEOUT_MS -- whichever comes first. `trace` collects a short
 * step-by-step log for `console.log`, not shown to the channel.
 */
async function answerWithTools(history, question) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: question }];
  const trace = [];
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Date.now() > deadline) break;
    const message = await callModel(messages, true);
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { answer: message.content.trim(), trace };
    }
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      const observation = runTool(call.function.name, call.function.arguments);
      trace.push(`${call.function.name}(${call.function.arguments}) -> ${JSON.stringify(observation).slice(0, 200)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(observation) });
    }
  }

  // Ran out of steps or time without the model volunteering a final
  // answer -- force one, tools removed so it can't keep chaining.
  messages.push({ role: 'user', content: 'Answer now, in two or three sentences, using only what you found above.' });
  const final = await callModel(messages, false);
  return { answer: final.content.trim(), trace };
}

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
    // The 10s default elsewhere is too tight when the server itself is
    // CPU-starved (observed: ejabberd missing it under a system load
    // average over 100 from unrelated concurrent work) -- this is the
    // connection handshake, worth being patient about specifically.
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
const MIX_BLOCK_RE = /<mix\b[^>]*>[\s\S]*?<\/mix>/;
const MIX_NICK_RE = /<nick>([\s\S]*?)<\/nick>/;
const MIX_JID_RE = /<jid>([\s\S]*?)<\/jid>/;

const HISTORY_TURNS = 6; // shorter than the chat bots' -- tool traces already add context per turn

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
      `[skos-agent] could not read bot registry ${registryPath}: ${err.message} `
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

  const storeReady = openStore(STORE);

  const stream = new XmppStream(HOST, PORT);
  console.log(`[skos-agent] connecting as ${bareJid} to ${HOST}:${PORT}`);
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
    + `<resource>skos-agent-${CHANNEL_NAME}</resource></bind></iq>`,
    { timeout: 30000 },
  );
  if (!bound.includes("type='result'") && !bound.includes('type="result"')) {
    throw new Error(`resource bind failed: ${bound}`);
  }
  stream.send('<presence/>');

  console.log(`[skos-agent] joining ${channel} as nick '${NICK}'`);
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
  console.log(`[skos-agent] joined. Listening for messages on ${channel} ...`);
  if (REQUIRE_ADDRESS) {
    console.log(`[skos-agent] reply-only-when-addressed mode: will only answer messages mentioning '${NICK}'`);
  }
  await ensureBackend();
  await storeReady;
  console.log(`[skos-agent] backend ready, store handle open: ${STORE}`);

  const escapedNick = NICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const addressRe = new RegExp(`\\b${escapedNick}\\b`, 'i');
  const stripPrefixRe = new RegExp(`^\\s*@?${escapedNick}\\s*[:,]?\\s*`, 'i');

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
            continue;
          }
        }

        const fromMatch = FROM_RE.exec(stanza);
        const bodyMatch = BODY_RE.exec(stanza);
        if (!fromMatch || !bodyMatch) continue;

        const sender = fromMatch[1];
        if (sender !== channel && !sender.startsWith(`${channel}/`)) continue;
        const senderResource = (sender !== channel && sender.includes('/'))
          ? sender.split('/', 2)[1] : sender;
        const body = xmlUnescape(bodyMatch[1]);

        if (ownResource === null && body === bootstrapMarker) {
          ownResource = senderResource;
          console.log(`[skos-agent] learned own MIX resource id: ${ownResource}`);
          continue;
        }
        if (ownResource !== null && senderResource === ownResource) continue;
        if (bootstrapMarkerRe.test(body)) continue;
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

        console.log(`[skos-agent] <${senderNick}> ${body}`);

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
          console.error('[skos-agent] rate limit hit -- skipping reply, possible loop');
          continue;
        }

        const question = body.replace(stripPrefixRe, '').trim() || body;
        (async () => {
          let reply;
          try {
            const { answer, trace } = await answerWithTools(history, question);
            if (trace.length) console.log(`[skos-agent] trace: ${trace.join(' | ')}`);
            reply = answer || "I couldn't find anything useful for that.";
          } catch (exc) {
            console.error(`[skos-agent] error: ${exc.message}`);
            reply = `Sorry, something went wrong answering that: ${exc.message.split('\n')[0]}`;
          }
          console.log(`[skos-agent] -> ${reply}`);
          history.push(userTurn);
          history.push({ role: 'assistant', content: reply });
          history = history.slice(-HISTORY_TURNS);
          const msgId = `skos-agent-${Date.now()}`;
          sentIds.add(msgId);
          replyTimes.push(now);
          stream.send(
            `<message to='${channel}' type='groupchat' id='${msgId}'>`
            + `<body>${xmlEscape(reply)}</body></message>`,
          );
        })();
      }

      if (lastEnd > 0) {
        const consumedBytes = Buffer.byteLength(text.slice(0, lastEnd), 'utf-8');
        buf = buf.subarray(consumedBytes);
      }
    });
  });
}

main().catch((err) => {
  console.error(`[skos-agent] fatal: ${err.stack || err}`);
  process.exit(1);
});
