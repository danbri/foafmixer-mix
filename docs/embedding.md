# Embedding the MIX client in another web app

`apps/demo/foafmixer/web/js/xmpp.js` is not tied to the pilot's chat UI. It is
a small, dependency-free `XmppClient` class (`extends EventTarget`) that only
needs [Strophe.js](https://strophe.im/strophejs/) loaded globally and its
sibling `xml.js` (used only for the optional `log` event's pretty-printed
stanza text). `app.js`, `store.js` and the components under `web/js/components/`
are one consumer of it -- the full chat UI. Any other web page can import
`xmpp.js` directly and drive a MIX session from its own application code,
with no UI of the pilot's shown at all ("lite mode").

## Loading it

```html
<script src="https://cdn.jsdelivr.net/npm/strophe.js/dist/strophe.umd.min.js"></script>
<script type="module">
  import { xmpp } from '/js/xmpp.js'; // the module also exports the XmppClient class directly
  // ... use `xmpp` as shown below
</script>
```

Copy `xmpp.js` and `xml.js` alongside your own page, or serve them from this
repo's `web/js/` directory. Two constraints inherited from the pilot server,
not from the client code:

* The page must be served from the origin the server's `WS_ORIGIN` was
  rendered for (see `pilot.sh start` in `apps/demo/foafmixer/`) -- the
  server checks the WebSocket handshake's origin.
* The JID you connect with must already be registered (`human-account.sh`).
  There is no in-band registration UI here.

## Minimal headless example

```js
import { xmpp } from '/js/xmpp.js';

xmpp.addEventListener('connected', async () => {
  const { channelJid } = await xmpp.joinChannel({
    channelJid: 'factoidal@mix.foafmixer.test',
    nick: 'my-app',
  });
  console.log('joined', channelJid);
});

xmpp.addEventListener('message', (event) => {
  const { channelJid, message } = event.detail;
  console.log(`[${channelJid}] ${message.label}: ${message.text}`);
  // ... hand off to your own application code here
});

xmpp.connect({
  jid: 'myaccount@foafmixer.test',
  password: '...',
  host: 'dans-macbook-air.tailaf2e8d.ts.net',
  port: '8444',
});

// later
xmpp.sendGroupMessage('factoidal@mix.foafmixer.test', 'hello from a headless client');
```

No DOM is touched beyond what Strophe itself requires internally. Rendering,
storage and reconnection policy are entirely up to the host application.

## API

`xmpp` is a ready-made shared instance (`export const xmpp = new XmppClient()`);
`XmppClient` is also exported if you want a separate instance.

| Method | Returns | Notes |
| --- | --- | --- |
| `connect({ jid, password, host, port })` | `boolean` | `false` if the arguments were incomplete or Strophe isn't loaded; otherwise starts connecting and reports outcome via events. |
| `disconnect()` | `void` | |
| `connected` (getter) | `boolean` | |
| `createChannel({ service, name })` | `Promise<channelJid>` | XEP-0369 `create` |
| `joinChannel({ channelJid, nick })` | `Promise<{ channelJid, nick }>` | XEP-0405 client-join wrapping a Core:1 join; subscribes to the messages, participants and info nodes |
| `leaveChannel(channelJid)` | `Promise<channelJid>` | |
| `sendGroupMessage(channelJid, text)` | client-generated stanza `id`, or `null` if not connected | The server's echo (matched by this id) is the message to actually render/log, not the local call |
| `loadHistory(channelJid, before？)` | `Promise<{ channelJid, messages, complete }>` | XEP-0313 MAM, newest 50 by default; pass a stanza id to page further back |
| `refreshParticipants(channelJid)` / `refreshInfo(channelJid)` | `void` | Results arrive via the `participants` / `info` events |

## Events

All delivered as `CustomEvent`s (`event.detail` holds the payload) via
`addEventListener`.

| Event | `detail` shape |
| --- | --- |
| `status` | `{ text, tone, phase? }` -- human-readable connection status, before `connected`/`disconnected` |
| `connected` | `{ jid, host, port }` |
| `disconnected` | `{ reason: 'authfail'\|'connfail'\|'closed', text }` |
| `channel-joined` | `{ channelJid, nick }` |
| `channel-left` | `{ channelJid }` |
| `message` | `{ channelJid, message }` -- `message` is `{ id, archiveId, submissionId, from, nick, senderJid, label, text, timestamp, pending }` |
| `history` | `{ channelJid, messages, complete, queryId }` |
| `participants` | `{ channelJid, participants }` -- each `{ id, nick, jid, label }` |
| `info` | `{ channelJid, info: { name, contact } }` |
| `log` | `{ label: 'IN'\|'OUT', timestamp, xml }` -- raw stanza traffic, for debugging; skip `xml.js` entirely if you don't listen for this |

A message's real sender identity (`nick` / `senderJid`) comes from the
`<mix>` child element, not the stanza's `from` attribute -- MIX gives each
participant an opaque, per-session resource id there, not their nick.

## Why this over reimplementing the protocol

The Python bridge bots in `../../talkie-bot/` (a separate, unpublished
experiment) hand-roll the same XEP-0369/XEP-0405 client-join and message
handling over a raw socket, because Python has no browser and no Strophe.
A web page doesn't have that constraint -- reuse `xmpp.js` rather than
reimplementing MIX join/send/receive against raw XML.
