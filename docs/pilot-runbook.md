# Foafmixer pilot runbook

This is a private, Tailscale-reachable interoperability pilot for XMPP MIX
Core:1. It deliberately keeps operational credentials out of Git and out of
chat transcripts.

## Repositories and responsibilities

* This repository is server-neutral. The runnable browser demo is in
  `apps/demo/foafmixer`.
* `danbri/ejabberd-xmpp-mix-patches` is the separate GPL repository for the
  ejabberd 26.07 patch series and upstream issue links.
* The patched ejabberd test server is intentionally separate from the original
  live pilot: it has a distinct container, database volume, and passwords.

## Endpoints

All names below are reachable only by devices authenticated to the tailnet.

| Purpose | Address | Notes |
| --- | --- | --- |
| Browser demo | `https://dans-macbook-air.tailaf2e8d.ts.net:8443/` | HTTPS served through Tailscale |
| Original-pilot WebSocket | `wss://dans-macbook-air.tailaf2e8d.ts.net:8444/` | The browser demo's default |
| Patched-test WebSocket | `wss://dans-macbook-air.tailaf2e8d.ts.net:15281/` | Select **Patched MIX test — port 15281** in the UI |
| Original-pilot C2S | `dans-macbook-air.tailaf2e8d.ts.net:5222` | raw TCP inside Tailscale; no direct TLS |
| Patched-test C2S | `dans-macbook-air.tailaf2e8d.ts.net:15222` | raw TCP inside Tailscale; no direct TLS |

The XMPP domain remains `foafmixer.test`; the Tailscale hostname is the
network transport address, not the JID domain.

## BeagleIM: patched-test account

In BeagleIM's full account form:

* JID: `mix_patch_tester@foafmixer.test` (or patched-test `danbri`)
* Server: `dans-macbook-air.tailaf2e8d.ts.net`
* Port: `15222`
* **Use Direct TLS**: unchecked
* **Disable TLS 1.3**: unchecked

The traffic is plain XMPP only inside the encrypted tailnet link. The password
is stored locally in macOS Keychain, not in this document. Retrieve it on the
host only when needed:

```sh
security find-generic-password \
  -s 'Foafmixer XMPP pilot (patched test)' \
  -a 'mix_patch_tester@foafmixer.test' -w
```

Use a second account when testing a join from BeagleIM. Creating and joining a
channel in the browser as the same account exercises direct MIX Core joins;
joining it from `mix_patch_tester` exercises MIX Client-PAM and roster updates.

## Current test state

* The patched test runs ejabberd 26.07 in container
  `foafmixer-mix-patched-test`.
* The original pilot remains isolated in `factoidal-foafmixer`.
* Core:1 create and direct join have been verified from the web UI.
* The web demo now supplies the mandatory `id` on MIX group messages and waits
  for the server echo, avoiding a duplicate local message.
* BeagleIM discovery finds `factoidal@mix.foafmixer.test`. A prior Client-PAM
  join timed out because the test configuration did not enable `mod_roster`.
  `mod_roster` is enabled.
* MIX message handling passes through MAM, so the pilot sets
  `mod_mam.default: always`. After enabling it, BeagleIM successfully loaded
  existing `factoidal` history after rejoining. Live two-client delivery remains
  the next explicit interoperability check.

## Known limitations

This is not yet a complete MIX implementation. The ejabberd patch addresses a
specific Core:1 information-node gap and preserves the Client-PAM response
namespace. Further work includes presence, subscription updates, channel
configuration/administration, and conformance/interoperability tests.
