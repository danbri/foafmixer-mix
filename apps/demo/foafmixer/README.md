# foafmixer

`foafmixer` is the working home for Factoidal's future XMPP MIX bridge and
agent/human social collaboration tools. It deliberately sits in `tools/` for
now: it is operational glue around standard XMPP and is not yet part of the
Lean SPARQL kernel.

The later formal counterpart belongs under `formal/lean4/`, where it can model
the SPARQL-over-MIX channel semantics, messages, artifact references and
provenance claims without making the hot RDF block path depend on an XMPP
client.

The initial operational target is a loopback-only ejabberd pilot using MIX
channels `factoidal` and `factoidal-shardborough`. Git commits and dated
worknotes remain the audit fallback. Do not substitute MUC merely because a
client has incomplete MIX support.

## Local pilot

`ejabberd.yml` enables the experimental ejabberd MIX modules, MIX participant
support, MAM and the PubSub support MIX needs. `pilot.sh` deliberately exports
only XMPP client and HTTP API ports on `127.0.0.1`; it owns only the replaceable
container named `factoidal-foafmixer` and the persistent
`foafmixer-mix-state` volume. Factoidal container tooling requires the caller's
default Podman connection to be rootless. It never hard-codes a connection,
socket, machine name, or host-platform assumption.

Build the pinned patched image with the reviewer tooling in the separate GPL
`ejabberd-xmpp-mix-patches` repository. Once `podman-preflight.sh` reports that
Podman is ready, start the pilot:

```sh
apps/demo/foafmixer/pilot.sh start
```

The pilot virtual host is `foafmixer.test`, with MIX service
`mix.foafmixer.test`. The server comes up without creating public channels;
create `factoidal` and `factoidal-shardborough` through a MIX-capable client
or the documented XMPP stream calls, then record the channel identities in
the project worknotes. `apps/demo/foafmixer/pilot.sh stop` removes only the pilot
container and intentionally retains its named state volume for a later local
restart.

Create named human test accounts with fresh temporary passwords:

```sh
apps/demo/foafmixer/human-account.sh human alice bob
```

Bots require an accountable human account that the helper has registered:

```sh
apps/demo/foafmixer/human-account.sh bot alice alicenotesbot alicebuildbot
```

The helper records each account's kind and responsible human locally, never
stores passwords, and requires explicit names. Give each printed temporary
password directly to its named human.

This is a development pilot, not an Internet-exposed or production service.
Tailscale supplies private tailnet access. Do not add public DNS, federation,
Funnel, or production credentials without a separate deployment review.

## Browser pilot

`ui.sh` serves a small same-origin Strophe browser client privately over
Tailscale HTTPS. It connects to ejabberd using XMPP-over-WebSocket and has no
server-side credential store: each human or accountable bot signs in with its
own JID and password.

```sh
apps/demo/foafmixer/ui.sh start
```

The script serves static files from its own loopback-only Podman container,
prints the tailnet-only UI URL, and creates a separate WebSocket listener.
`tools/foafmixer/ui.sh stop` removes only that UI container and those two
listeners; it does not affect any other Tailscale Serve configuration.

## Historical context

The name acknowledges FOAFtown/JQBus experiments in social, RDF-aware message
exchange. The archived [JQBus introduction](https://web.archive.org/web/20071212235303/http://svn.foaf-project.org/foaftown/jqbus/intro.html)
is historical context, not an implementation dependency or protocol
specification.
