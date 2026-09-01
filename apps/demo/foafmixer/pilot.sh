#!/usr/bin/env bash
# Start, stop, or inspect the disposable loopback-only Foafmixer MIX pilot.
# This script only ever names/removes `factoidal-foafmixer`; it does not touch
# unrelated Podman containers. Factoidal container pilots require rootless
# Podman on every host platform.
set -euo pipefail

pilot_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
container=factoidal-foafmixer
image=${FOAFMIXER_IMAGE:-localhost/foafmixer/ejabberd-mix:26.07-pilot}
volume=${FOAFMIXER_STATE_VOLUME:-foafmixer-mix-state}

usage() {
  echo "usage: $0 {start|stop|status|logs}" >&2
}

require_rootless_podman() {
  podman info >/dev/null
  rootless=$(podman info --format '{{.Host.Security.Rootless}}')
  if [ "$rootless" != true ]; then
    echo "Foafmixer requires rootless Podman; select a rootless default connection." >&2
    exit 1
  fi
}

case "${1:-}" in
  start)
    require_rootless_podman
    if ! podman image exists "$image"; then
      echo "Patched MIX image not found: $image" >&2
      echo "Build it with the reviewer tooling in ejabberd-xmpp-mix-patches first." >&2
      exit 1
    fi
    podman run -d --replace --name "$container" \
      --restart unless-stopped \
      --label io.factoidal.purpose=foafmixer-mix-patched-pilot \
      -p 127.0.0.1:5222:5222 \
      -p 127.0.0.1:5280:5280 \
      -p 127.0.0.1:5281:5281 \
      -v "$pilot_dir/ejabberd.yml:/opt/ejabberd/conf/ejabberd.yml:ro" \
      -v "$volume:/opt/ejabberd/database" \
      "$image"
    echo "Foafmixer is starting on xmpp://127.0.0.1:5222 (host: foafmixer.test)."
    echo "Browser WebSocket: http://127.0.0.1:5281/xmpp (put TLS in front of it)."
    echo "Accounts and passwords live only in the named volume: $volume"
    ;;
  stop)
    require_rootless_podman
    podman rm -f "$container" 2>/dev/null || true
    ;;
  status)
    require_rootless_podman
    podman ps -a --filter "name=^${container}$"
    ;;
  logs)
    require_rootless_podman
    podman logs "$container"
    ;;
  *) usage; exit 2 ;;
esac
