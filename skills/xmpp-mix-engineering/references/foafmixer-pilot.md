# Foafmixer pilot operations

Read the repository's [pilot runbook](../../../docs/pilot-runbook.md) for the
current endpoints and client form values. Treat that runbook as the authority
for non-secret operational details and update it when observations change.

## Topology and identity

- `foafmixer.test` is the XMPP identity domain.
- The machine's Tailscale DNS name is the tailnet transport host. Scripts print
  it; it is not recorded in Git.
- The browser UI is served through Tailscale HTTPS on port 8443 and reaches the
  same patched server through WSS on port 8444.
- Native clients such as BeagleIM and Siskin use Tailnet TCP port 5222, created
  by `pilot.sh expose`. Port
  8444 is WebSocket-only and must not be entered in a native client's C2S form.
- Desktop C2S can remain plaintext only because the connection is confined to
  the encrypted tailnet. Do not describe it as Internet-safe TLS.
- Tailscale on this Mac is managed by the macOS GUI; do not assume a daemon
  installed or controlled by a package-manager service.

## Containers and durable state

- `factoidal-foafmixer` is the patched live pilot on the canonical ports.
- `factoidal-foafmixer-ui` serves the browser demo.
- `foafmixer-mix-state` is the canonical named database volume. Historical
  named volumes may be retained for explicit recovery, but never copy them into
  either Git repository or a container build context.

Before replacement, inspect container health, image, port bindings, config
bind, and named database volume. The GPL patch repository contains a pinned,
account-free Docker/Podman reviewer build; the live pilot supplies its own
configuration and state outside that repository.

### Clearing one MIX channel's MAM history

Treat this as destructive and require an explicit channel target. With the
pilot's Mnesia backend, channel messages are keyed by
`{ChannelName, MixServiceHost}`, for example
`{<<"factoidal">>, <<"mix.foafmixer.test">>}`. The public
`remove_mam_for_user` command looks up `mod_mam` on the supplied host and cannot
address this component archive.

On the attached ejabberd node, first count only the exact key:

```erlang
length(mnesia:dirty_read(
  archive_msg,
  {<<"factoidal">>, <<"mix.foafmixer.test">>})).
```

Then, only after confirming the target, remove messages without deleting MAM
preferences:

```erlang
mod_mam_mnesia:remove_from_archive(
  <<"factoidal">>, <<"mix.foafmixer.test">>, none).
```

Recount and require zero. Do not substitute `remove_room/3`: its Mnesia path
also deletes the room's archive preferences. This recipe is backend-specific;
inspect the configured `mod_mam` database module before using it elsewhere.

## Accounts and secrets

The pilot may create accounts for humans and bots, but every bot must have a
named `responsibleHuman`. Keep this relationship in account metadata or the
account-creation manifest even when both are technically ordinary XMPP users.
Do not silently classify a bot as a human account.

Passwords belong in local secret storage (currently macOS Keychain where
documented), never committed files or protocol logs. If a temporary password
file is explicitly supplied, read only the requested credential and delete the
exact file immediately afterward.

## Browser UI behavior

The UI separates four concerns into tabs:

- Server: authentication and transport state.
- Channel: create/join and membership state.
- Messages: live messages plus a separate MAM History subtab.
- Debug: formatted protocol log and copy control.

Connection and membership indicators must reflect live state, not restored form
values. A restored channel address is not proof of a restored join. Enable
sending only after a successful current-session join, and render messages from
the server echo rather than adding an optimistic duplicate.

Support both Command+Enter and Control+Enter for sending. Preserve visible,
large emoji state indicators with text labels for accessibility.

The 1Password extension owns rich-icon requests to `c.1password.com`; page code
cannot suppress those requests while keeping extension autofill. Mark unrelated
WebSocket/channel/message controls with `data-1p-ignore`, but leave JID/password
available to the password manager. Users can disable website icons in
1Password's Appearance settings or filter that URL in DevTools if desired.

## Current interoperability baseline

A fresh browser submission has appeared immediately in both BeagleIM on macOS
and Siskin IM on iOS through the canonical patched server. This proves live
fan-out across the WebSocket and native C2S paths without a reconnect/history
fallback. An old conversation remaining in Beagle after server replacement is
local client cache when the channel identity is unchanged; do not treat it as
evidence that the removed container is still reachable.

OMEMO was disabled for the baseline. Treat end-to-end encryption as a separate
client/device-state interoperability layer and test it only after unencrypted
MIX routing remains deterministic.
