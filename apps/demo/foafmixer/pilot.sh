#!/usr/bin/env bash
# Start, stop, or inspect the disposable loopback-only Foafmixer MIX pilot.
# This script only ever names/removes `factoidal-foafmixer`; it does not touch
# unrelated Podman containers. Factoidal container pilots require rootless
# Podman on every host platform.
set -euo pipefail

pilot_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
container=factoidal-foafmixer
image=${FOAFMIXER_IMAGE:-localhost/foafmixer/ejabberd-mix:26.07-pilot}
volume=${FOAFMIXER_STATE_VOLUME:-foafmixer-mix-state}
generated_dir="$pilot_dir/.foafmixer-generated"
rendered_config="$generated_dir/ejabberd.yml"
c2s_port=5222

usage() {
  echo "usage: $0 {start|stop|status|logs|expose|unexpose}" >&2
  echo "  expose/unexpose: forward tailnet TCP port 5222 to the loopback C2S listener" >&2
}

tailnet_name() {
  tailscale status --json 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
}

# The WebSocket origin ejabberd will accept. Override with FOAFMIXER_WS_ORIGIN;
# otherwise derive it from the tailnet name that ui.sh serves the UI on.
websocket_origin() {
  if [ -n "${FOAFMIXER_WS_ORIGIN:-}" ]; then
    printf '%s\n' "$FOAFMIXER_WS_ORIGIN"
    return
  fi
  local name
  name=$(tailnet_name || true)
  if [ -n "$name" ]; then
    printf 'https://%s:8443\n' "$name"
  else
    printf 'https://localhost:8443\n'
  fi
}

# Render ejabberd.yml with the WebSocket origin substituted. The rendered copy
# lives in a gitignored directory so the checked-in file never carries a
# machine-specific hostname.
render_config() {
  local origin
  origin=$(websocket_origin)
  mkdir -p "$generated_dir"
  sed "s|^  WS_ORIGIN: .*|  WS_ORIGIN: \"$origin\"|" "$pilot_dir/ejabberd.yml" >"$rendered_config"
  echo "WebSocket origin: $origin"
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
    render_config
    podman run -d --replace --name "$container" \
      --restart unless-stopped \
      --label io.factoidal.purpose=foafmixer-mix-patched-pilot \
      -p 127.0.0.1:5222:5222 \
      -p 127.0.0.1:5280:5280 \
      -p 127.0.0.1:5281:5281 \
      -v "$rendered_config:/opt/ejabberd/conf/ejabberd.yml:ro" \
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
  expose)
    # Raw TCP forward: the tailnet link is encrypted, the XMPP stream is not.
    # Native clients use this port with Direct TLS off; see docs/pilot-runbook.md.
    tailscale serve --tcp="$c2s_port" --bg "tcp://127.0.0.1:$c2s_port"
    echo "Native-client C2S: $(tailnet_name):$c2s_port (tailnet only, Direct TLS off)"
    ;;
  unexpose)
    tailscale serve --tcp="$c2s_port" off
    ;;
  *) usage; exit 2 ;;
esac
