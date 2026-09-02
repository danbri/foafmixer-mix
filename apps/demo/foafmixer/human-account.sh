#!/usr/bin/env bash
# Create named human accounts, or bot accounts with an accountable human.
# Passwords are generated per invocation and printed once for hand-off.
set -euo pipefail

pilot_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
container=factoidal-foafmixer
domain=foafmixer.test
registry=${FOAFMIXER_ACCOUNT_REGISTRY:-"$pilot_dir/.foafmixer-account-responsibility.tsv"}

usage() {
  echo "usage: $0 human <localpart> [<localpart> ...]" >&2
  echo "       $0 bot <responsible-human> <bot-localpart> [<bot-localpart> ...]" >&2
  echo "       $0 audit" >&2
  echo "examples: $0 human alice bob" >&2
  echo "          $0 bot alice alicenotesbot alicebuildbot" >&2
}

if [ "${1:-}" = audit ]; then
  # Report drift between the server's account list and the local registry.
  # Read-only: it changes neither accounts nor the registry.
  if ! podman container exists "$container"; then
    echo "Foafmixer pilot container is not running: $container" >&2
    exit 1
  fi
  server=$(podman exec "$container" ejabberdctl registered_users "$domain" | sed "s/\$/@$domain/" | sort)
  registered=$(tail -n +2 "$registry" 2>/dev/null | cut -f1 | sort || true)
  echo "On server, not in registry:"
  comm -23 <(printf '%s\n' "$server") <(printf '%s\n' "$registered") | sed 's/^/  /'
  echo "In registry, not on server:"
  comm -13 <(printf '%s\n' "$server") <(printf '%s\n' "$registered") | sed 's/^/  /'
  exit 0
fi

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

if ! podman container exists "$container"; then
  echo "Foafmixer pilot container is not running: $container" >&2
  exit 1
fi

kind=$1
shift

case "$kind" in
  human)
    responsible_human=
    ;;
  bot)
    if [ "$#" -lt 2 ]; then
      usage
      exit 2
    fi
    responsible_human=$1
    shift
    ;;
  *)
    usage
    exit 2
    ;;
esac

validate_localpart() {
  local localpart=$1
  if [[ ! "$localpart" =~ ^[a-z0-9][a-z0-9._-]{0,31}$ ]]; then
    echo "Invalid human account name: $localpart" >&2
    echo "Use 1-32 lowercase letters, digits, '.', '_' or '-', beginning with a letter or digit." >&2
    exit 2
  fi
}

if [ "$kind" = bot ]; then
  validate_localpart "$responsible_human"
  if ! podman exec "$container" ejabberdctl check_account "$responsible_human" "$domain" >/dev/null; then
    echo "Responsible human account does not exist: $responsible_human@$domain" >&2
    exit 1
  fi
  if ! awk -F '\t' -v human="$responsible_human@$domain" '$1 == human && $2 == "human" { found = 1 } END { exit !found }' "$registry" 2>/dev/null; then
    echo "Responsible human is not registered in $registry: $responsible_human@$domain" >&2
    echo "Create or adopt them first with: $0 human $responsible_human" >&2
    exit 1
  fi
fi

for localpart in "$@"; do
  validate_localpart "$localpart"
done

if [ ! -e "$registry" ]; then
  printf 'account\tkind\tresponsible_human\tcreated_utc\n' >"$registry"
fi

for localpart in "$@"; do
  password=$(openssl rand -hex 18)
  podman exec "$container" ejabberdctl register "$localpart" "$domain" "$password"
  account="$localpart@$domain"
  if [ "$kind" = human ]; then
    printf '%s\thuman\t%s\t%s\n' "$account" "$account" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$registry"
  else
    printf '%s\tbot\t%s@%s\t%s\n' "$account" "$responsible_human" "$domain" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$registry"
  fi
  printf '%s@%s temporary password: %s\n' "$localpart" "$domain" "$password"
done

echo "Give each password directly to its named human. The local responsibility registry contains no passwords."
