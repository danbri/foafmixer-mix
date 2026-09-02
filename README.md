# foafmixer-mix

Server-neutral tooling for running and testing XMPP MIX (XEP-0369 MIX Core 1,
XEP-0405 MIX-PAM 2): a loopback or tailnet pilot around ejabberd, a
same-origin Strophe browser client, account helpers, a runbook, and an
engineering skill for MIX diagnosis. Apache-2.0.

Server patches are kept out of this repository. The ejabberd 26.07 patch
series that makes the pilot work with current clients lives in
[danbri/ejabberd-xmpp-mix-patches](https://github.com/danbri/ejabberd-xmpp-mix-patches)
(GPL-2.0), together with its CI and reviewer container workflow.

## Status

Experimental. With the three-patch reviewer stack, BeagleIM 6.0.1, Siskin IM
on iOS and the browser client exchange live channel messages immediately in
both directions. Presence, channel configuration and administration, and
per-participant Core revision selection are not implemented on the server
side. See the patch repository's README for the per-patch gate state.

## Layout

```
apps/demo/foafmixer/   pilot.sh, ui.sh, human-account.sh, ejabberd.yml, web/
docs/pilot-runbook.md  endpoints, client settings, dated test log
skills/xmpp-mix-engineering/  MIX protocol, patching and pilot references
```

## Run the pilot

1. Build the patched image with `make image` in the patch repository.
2. `apps/demo/foafmixer/podman-preflight.sh` (requires rootless Podman).
3. `apps/demo/foafmixer/pilot.sh start`
4. `apps/demo/foafmixer/ui.sh start` (browser demo over Tailscale HTTPS)
5. `apps/demo/foafmixer/pilot.sh expose` (native clients over the tailnet)
6. `apps/demo/foafmixer/human-account.sh human alice bob`

Details, client form values and the test log are in
[the pilot runbook](docs/pilot-runbook.md).
