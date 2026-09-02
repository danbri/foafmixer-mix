# Foafmixer pilot runbook

This is a private, Tailscale-reachable interoperability pilot for XMPP MIX
Core:1. It deliberately keeps operational credentials out of Git and out of
chat transcripts.

## Repositories and responsibilities

* This repository is server-neutral. The runnable browser demo is in
  `apps/demo/foafmixer`.
* `danbri/ejabberd-xmpp-mix-patches` is the separate GPL repository for the
  ejabberd 26.07 patch series and upstream issue links.
* The proven patched ejabberd server is now the live pilot. The retired
  unpatched container is not part of the running topology.

## Endpoints

All names below are reachable only by devices authenticated to the tailnet.
`<tailnet-hostname>` is this machine's Tailscale DNS name; `ui.sh start` and
`pilot.sh expose` print it, and `tailscale status --json` reports it under
`Self.DNSName`. It is deliberately not written into this repository.

| Purpose | Address | Created by |
| --- | --- | --- |
| Browser demo | `https://<tailnet-hostname>:8443/` | `ui.sh start` (HTTPS served through Tailscale) |
| Browser WebSocket | `wss://<tailnet-hostname>:8444/xmpp` | `ui.sh start` (TLS terminated by Tailscale, forwarded to ejabberd on loopback) |
| Desktop-client C2S | `<tailnet-hostname>:5222` | `pilot.sh expose` (raw TCP inside the encrypted tailnet; no direct TLS) |

The XMPP domain remains `foafmixer.test`; the Tailscale hostname is the
network transport address, not the JID domain.

`pilot.sh start` renders `ejabberd.yml` with `WS_ORIGIN` set to the tailnet
HTTPS origin, so the server accepts WebSocket connections only from the
browser demo. Rerun it after a tailnet rename, or set `FOAFMIXER_WS_ORIGIN`
to override.

Start order: `pilot.sh start`, then `ui.sh start`, then `pilot.sh expose`.

## BeagleIM

In BeagleIM's full account form:

* JID: an account in the `foafmixer.test` XMPP domain
* Server: `<tailnet-hostname>`
* Port: `5222`
* **Use Direct TLS**: unchecked
* **Disable TLS 1.3**: unchecked

The traffic is plain XMPP only inside the encrypted tailnet link. The password
is stored locally in macOS Keychain, not in this document. Use distinct
accounts in BeagleIM and the browser when testing two-party delivery.

## Test log

### 2026-09-02

* The pilot was restarted on the canonical image
  `localhost/foafmixer/ejabberd-mix:26.07-pilot` with the rendered
  configuration. The tailnet hostname no longer appears in Git; the 5222
  forward is now created by `pilot.sh expose` instead of by hand.

### 2026-09-01 and earlier


* The live `factoidal-foafmixer` container was created from the earlier local
  tag `localhost/ejabberd-mix-patched:26.07-core1`. The pinned reviewer builder
  now produces `localhost/foafmixer/ejabberd-mix:26.07-pilot`, which
  `pilot.sh` will use on the next restart. SHA-256 checks of `mod_mix.beam` and
  `mod_mix_pam.beam` match exactly between the running and newly built images,
  so no client-disrupting restart was needed for this cutover.
* It uses the canonical named volume `foafmixer-mix-state` and loopback ports
  `5222`, `5280`, and `5281`.
* The obsolete unpatched container and temporary Tailnet routes `15222` and
  `15281` were removed on 2026-09-01. Its former named volume is retained
  locally for deliberate recovery only; no volume data belongs in Git.
* Core:1 create and direct join have been verified from the web UI.
* The web demo now supplies the mandatory `id` on MIX group messages and waits
  for the server echo, avoiding a duplicate local message.
* BeagleIM discovery finds `factoidal@mix.foafmixer.test`. A prior Client-PAM
  join timed out because the test configuration did not enable `mod_roster`.
  `mod_roster` is enabled.
* MIX message handling passes through MAM, so the pilot sets
  `mod_mam.default: always`.
* The downstream 0001-0003 stack now emits Core 1 on live channel messages.
  BeagleIM 6.0.1 and the browser have rendered new messages immediately in both
  directions as distinct accounts, without reconnecting into history.
* After promotion to ports 5222 and 8444, a fresh browser message appeared
  immediately in both BeagleIM on macOS and Siskin IM on iOS. OMEMO was left
  disabled so this proof isolates MIX routing from end-to-end encryption.
* The `factoidal` channel archive was intentionally cleared after this proof on
  2026-09-01; accounts, participants, channel state, and MAM preferences were
  preserved.

## Known limitations

This is not yet a complete MIX implementation. The ejabberd patch addresses a
Core:1 information-node gap, participant-server live-routing namespace
recognition, and Core 1 channel-message emission. Further work includes exact
multi-resource fan-out, a no-mapping negative case, legacy Core 0 compatibility,
presence, subscription updates, channel configuration/administration, and
broader conformance/interoperability tests.
