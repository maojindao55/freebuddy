#!/bin/sh
set -eu

: "${RELAY_ENV_FILE:?set RELAY_ENV_FILE to the root-only deployment environment file}"
: "${RELAY_DATA_DIR:?set RELAY_DATA_DIR to the Relay data directory}"
: "${DEV_AUTH_ADMIN_TOKEN:?set DEV_AUTH_ADMIN_TOKEN for the deployed smoke session}"
: "${DEV_AUTH_HOST_TOKEN:?set DEV_AUTH_HOST_TOKEN for the deployed smoke session}"
: "${SMOKE_PAYLOAD_SENTINEL:?set SMOKE_PAYLOAD_SENTINEL to the smoke payload marker}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
database_file="$RELAY_DATA_DIR/relay.db"
relay_logs_file=$(mktemp)
caddy_logs_file=$(mktemp)
trap 'rm -f "$relay_logs_file" "$caddy_logs_file"' EXIT HUP INT TERM

if [ ! -f "$database_file" ]; then
	echo "data-boundary verification failed: Relay SQLite file is missing" >&2
	exit 1
fi

if ! docker compose --env-file "$RELAY_ENV_FILE" -f "$compose_file" logs --no-color relay >"$relay_logs_file"; then
	echo "data-boundary verification failed: Relay log collection failed" >&2
	exit 1
fi

if ! docker compose --env-file "$RELAY_ENV_FILE" -f "$compose_file" logs --no-color caddy >"$caddy_logs_file"; then
	echo "data-boundary verification failed: Caddy log collection failed" >&2
	exit 1
fi

check_absent() {
	label=$1
	file=$2
	value=$3
	if [ -z "$value" ]; then
		return 0
	fi
	# Pipe value via stdin to prevent exposing sensitive tokens in process arguments
	if printf '%s\n' "$value" | grep -aFq -f - "$file"; then
		echo "data-boundary verification failed: $label contains a sensitive marker" >&2
		exit 1
	fi
}

for sensitive_value in "$DEV_AUTH_ADMIN_TOKEN" "$DEV_AUTH_HOST_TOKEN" "$SMOKE_PAYLOAD_SENTINEL"; do
	check_absent "Relay logs" "$relay_logs_file" "$sensitive_value"
	check_absent "Caddy logs" "$caddy_logs_file" "$sensitive_value"
	for db_target in "$database_file" "${database_file}-wal" "${database_file}-shm"; do
		if [ -f "$db_target" ]; then
			check_absent "Relay SQLite ($(basename "$db_target"))" "$db_target" "$sensitive_value"
		fi
	done
done

echo "data-boundary verification passed"
