# Ejabberd MIX patching

The Foafmixer server-neutral project and the GPL ejabberd patch series have
different responsibilities. Keep ejabberd-derived code and patches in
`danbri/ejabberd-xmpp-mix-patches`; keep the demo and portable test ideas in
`danbri/foafmixer-mix`.

## Patch discipline

- Start each patch from a clean, pinned ejabberd revision and record that base.
- One behavioral defect per patch. Do not fold a newly discovered emission bug
  into an already-working routing patch.
- The commit message and nearby code comment must identify the old behavior,
  the failure it produces, the new behavior, and known compatibility risk.
- Avoid version bumps, refactors, formatting churn, or unrelated spec cleanup.
- Generate a mail-formatted patch and verify it applies to a fresh checkout of
  the stated parent.
- Do not add a candidate to `patches/series` or submit upstream until its stated
  gates pass. Upstream submission is a separate user-authorized action.

## Current decomposition

The working series has deliberately separated:

1. Core 1/PAM join and information-node behavior.
2. PAM recognition of locally constructed, Core 0, and Core 1 MIX subtags so
   live messages are forwarded.
3. Explicit Core 1 namespace emission on outgoing channel messages so modern
   clients do not discard a legacy Core 0 wrapper.

Preserve this decomposition. Patch 3 has an explicit legacy-client risk and
therefore should not be buried inside patch 2.

## Tests and release gates

Use the smallest test at each layer:

- Focused EUnit for predicates or constructors. Export internals only under
  `-ifdef(TEST)` when direct behavior cannot otherwise be asserted.
- Full compile using the same pinned Erlang/OTP major version as the image.
- Clean patch-application check against the parent commit.
- Container build from `.github/container/Dockerfile`.
- Isolated server with its own named database volume and ports. Use the
  account-free Docker/Podman reviewer workflow in the GPL patch repository;
  never put pilot identities, JIDs, credentials, or database state in that
  repository or image build context.
- Authenticated raw client proof for PAM join, immediate sender echo, distinct
  recipient delivery, and MAM retrieval.
- Wire assertion on the exact outgoing namespace.
- Final manual Beagle check for UI rendering, because a raw protocol probe
  cannot prove Beagle's Combine/DB/UI path.

Warnings about unavailable BEAM abstract code during coverage are not test
failures by themselves; record the final EUnit result and separately require a
clean production build.

When replacing an isolated container, inspect its mount list and port bindings
first. Reuse only its intended named database volume and exact read-only
configuration bind. Promote a tested image to the canonical pilot separately,
then remove temporary routes so clients have one unambiguous endpoint.
