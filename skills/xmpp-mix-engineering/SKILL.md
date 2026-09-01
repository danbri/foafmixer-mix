---
name: xmpp-mix-engineering
description: Develop, patch, operate, and debug XMPP MIX servers and clients, especially ejabberd, Strophe browser clients, BeagleIM/Martin interoperability, and Tailscale-hosted pilots. Use for MIX stanza/version diagnosis, minimal server patches, interoperability tests, pilot lifecycle, or client/account setup; do not route ordinary MUC-only work here.
---

# XMPP MIX engineering

Work toward observable XMPP MIX interoperability, not merely successful stanza
submission. Preserve the user's chosen server, client, topology, and repository
boundaries unless changing one is explicitly in scope.

## Route the work

- Read [protocol-and-interop.md](references/protocol-and-interop.md) when
  diagnosing stanzas, namespaces, joins, live delivery, history, or client
  rendering.
- Read [ejabberd-patching.md](references/ejabberd-patching.md) when changing or
  testing ejabberd.
- Read [foafmixer-pilot.md](references/foafmixer-pilot.md) when operating the
  current Foafmixer pilot, its web UI, accounts, containers, or Tailnet routes.

## Invariants

1. Distinguish the XMPP identity domain from the transport host. A JID such as
   `person@foafmixer.test` can legitimately connect through a Tailnet DNS name;
   do not rewrite one into the other.
2. Treat XML namespaces as protocol data. Inspect the namespace on the decoded
   element and on the serialized wire stanza; a record or DOM node with an empty
   namespace can acquire a legacy codec default.
3. Separate these proof layers: client emitted a stanza; server accepted it;
   server delivered an echo; another account received it; the target client
   rendered it. State exactly which layer passed.
4. Do not announce a root cause from correlation alone. Require a wire-level
   mismatch plus the relevant server/client source path, then prove the proposed
   change on the wire and in the affected client.
5. Keep patches minimal and reviewable. Inline comments must say what the code
   is doing, the concrete problem it solves, and any interoperability risk with
   existing behavior. Keep separable fixes in separate commits/patch files.
6. Never put passwords, SASL payloads, private keys, or reusable secrets in Git,
   notes, test fixtures, screenshots, or chat. Use local secret storage and
   redact protocol captures where appropriate.
7. Preserve durable state when replacing a test server. Resolve the exact
   container, bind mounts, and named volumes before stopping or recreating it.
8. Keep server-neutral work in the server-neutral repository and licensed
   server patches in their per-server repositories.

## Evidence loop

Capture a unique probe string and the smallest relevant stanza sequence. Record
the client version, library revision, server image/source revision, endpoint,
join route (direct MIX or PAM), advertised features, emitted namespace, and the
last proof layer reached. Prefer deterministic authenticated probes for server
behavior and one manual client check only for the rendering layer that cannot be
automated.

After a fix, test both live delivery and MAM history: either one can work while
the other is broken. Recheck the sender echo and a distinct account, because a
single JID with multiple resources can hide fan-out or duplicate-delivery bugs.

