#!/usr/bin/env bash
# Serve the Foafmixer browser pilot privately through this machine's tailnet.
set -euo pipefail

pilot_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ui_dir="$pilot_dir/web"
container=factoidal-foafmixer-ui
http_port=8787
ui_port=8443
websocket_port=8444

usage() {
  echo "usage: $0 {start|stop|status}" >&2
}

require_rootless_podman() {
  podman info >/dev/null
  rootless=$(podman info --format '{{.Host.Security.Rootless}}')
  if [ "$rootless" != true ]; then
    echo "Foafmixer UI requires rootless Podman; select a rootless default connection." >&2
    exit 1
  fi
}

case "${1:-}" in
  start)
    require_rootless_podman
    podman run -d --replace --name "$container" \
      --label io.factoidal.purpose=foafmixer-browser-pilot \
      -p "127.0.0.1:${http_port}:80" \
      -v "$ui_dir:/usr/share/nginx/html:ro" \
      docker.io/library/nginx:alpine
    tailscale serve --https="$ui_port" --bg "http://127.0.0.1:$http_port"
    tailscale serve --tls-terminated-tcp="$websocket_port" --bg "tcp://127.0.0.1:5281"
    dns_name=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    echo "Foafmixer UI: https://${dns_name}:${ui_port}/"
    echo "XMPP WebSocket: wss://${dns_name}:${websocket_port}/xmpp"
    ;;
  stop)
    tailscale serve --https="$ui_port" off
    tailscale serve --tls-terminated-tcp="$websocket_port" off
    podman rm -f "$container" 2>/dev/null || true
    ;;
  status)
    podman ps -a --filter "name=^${container}$"
    tailscale serve status
    ;;
  *) usage; exit 2 ;;
esac
