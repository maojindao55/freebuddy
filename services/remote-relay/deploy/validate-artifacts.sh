#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
env_file=${RELAY_ENV_FILE:-"$script_dir/remote-relay.env.example"}
rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT HUP INT TERM

docker compose --env-file "$env_file" -f "$compose_file" config >"$rendered"

if grep -Eq 'published:[[:space:]]*"?8080"?' "$rendered"; then
	echo "deployment validation failed: Relay port 8080 is publicly published" >&2
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "deployment validation note: Docker daemon is not running; skipping containerized 'caddy validate' (daemon blocked)"
else
	docker run --rm \
		-e RELAY_DOMAIN=relay.invalid \
		-e ACME_EMAIL=ops@example.invalid \
		-v "$script_dir/Caddyfile:/etc/caddy/Caddyfile:ro" \
		"${CADDY_IMAGE:-caddy:2.10.2-alpine}" \
		caddy validate --config /etc/caddy/Caddyfile
fi

echo "deployment artifacts validated"
