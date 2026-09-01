# MIX protocol and interoperability notes

Use these notes for XEP-0369 MIX Core and XEP-0405 MIX-PAM diagnosis. Verify the
current XEP text and current software versions before generalizing beyond the
observed versions recorded here.

## Protocol boundaries that look deceptively similar

- A direct channel join sends `<join xmlns='urn:xmpp:mix:core:1'>` to the
  channel JID.
- A PAM join sends `<client-join xmlns='urn:xmpp:mix:pam:2'>` to the user's bare
  JID and nests a Core 1 `<join>`.
- Participant PubSub events prove subscription/participant state, not message
  delivery.
- A successful join IQ proves membership, not that live messages will match a
  client's inbound filter.
- Channel MAM proves archival/retrieval, not live fan-out. A client that shows a
  message only after reconnecting is probably loading history rather than
  receiving/rendering the live stanza.
- A browser's `OUT` log proves only local serialization. Require an `IN`
  server-delivered groupchat stanza before calling the message delivered.
- MIX groupchat submissions require an `id` in the ejabberd behavior observed
  by this pilot. Preserve it, and use the returned `submission-id` to relate the
  sender echo to the submission.

## Core 0 versus Core 1: the confirmed BeagleIM 6.0.1 failure

Observed on 2026-09-01 with BeagleIM 6.0.1 (build 196), which pins Martin 3.2.4
at revision `1d70e9e7eb51a7faa500832be6400a39f86083f7`:

- `MixModule.CORE_XMLNS` is exactly `urn:xmpp:mix:core:1`.
- Its module criteria accept a groupchat message only if it contains a direct
  `<mix>` child in that exact namespace.
- `Message.mix` likewise searches only for Core 1.
- Beagle's `MixEventHandler` stores/displays messages received through Martin's
  MIX `messagesPublisher`.

The pilot's patched ejabberd accepted a Core 1/PAM 2 join but emitted live
channel metadata as `<mix xmlns='urn:xmpp:mix:core:0'>`. The same stanza appeared
immediately in the tolerant web UI, while Beagle neither published nor rendered
it. This is a source-and-wire match: Core 0 messages cannot meet Martin's Core 1
criteria.

In ejabberd 26.07, constructing `#mix{jid = ..., nick = ...}` without an
explicit `xmlns` lets the bundled xmpp codec serialize the legacy Core 0
namespace. The server fix must set `xmlns = ?NS_MIX_CORE_1` on both ordinary
recipient metadata and the sender copy that also carries `submission_id`.

Compatibility risk: always emitting Core 1 can stop Core-0-only clients from
recognizing messages. ejabberd currently does not retain the Core revision
negotiated by each participant, so per-recipient namespace selection is a
larger design change. Keep that issue visible rather than hiding it in a small
bug fix.

## Useful stanza checks

For a modern successful path, verify:

1. Account discovery advertises PAM 2 where applicable.
2. Channel/service discovery advertises Core 1.
3. The join response preserves PAM 2 outside and Core 1 inside.
4. The server-delivered message is `type='groupchat'`, comes from the channel
   plus stable participant ID, has a body, and contains Core 1 MIX metadata.
5. The sender copy carries the original submission ID.
6. A distinct joined account receives the message immediately.
7. MAM returns the same content independently of live delivery.

Treat roster pushes as real IQ requests: the client should acknowledge them.
A generic `service-unavailable` response can leave client-side channel state
fragile even when the join result itself succeeds.

## Client-specific cautions

- BeagleIM 6.0.1 has also crashed while repeatedly leaving/rejoining a channel;
  the macOS report showed a self-deadlock (`dispatch_sync` on the already-owned
  queue). Keep this client defect separate from server namespace defects.
- BeagleIM can retain local conversation history across a server-container
  replacement when the account and channel identities remain the same. Confirm
  a current server session and a fresh live probe before attributing cached rows
  to the active server.
- Siskin IM can use native C2S through the Tailnet and has participated in a
  successful browser-to-two-native-client live fan-out. Record its exact app
  version before promoting that observation to versioned acceptance evidence.
- OMEMO is not part of the Core 1 routing proof. Keep it disabled for baseline
  tests, then test encryption separately across clients and device lists.
- Multiple simultaneous resources for one bare JID can produce repeated PubSub
  events or apparent duplicates. Use distinct accounts and stable probe strings
  when measuring fan-out.
- Mainstream XMPP clients often implement MUC but not MIX. Verify explicit MIX
  support rather than assuming a group-chat UI is sufficient.
