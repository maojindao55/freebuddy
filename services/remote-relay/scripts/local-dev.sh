#!/bin/sh
set -eu

# Resolve directory paths regardless of caller cwd
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELAY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOCAL_DATA_DIR="${RELAY_LOCAL_DATA_DIR:-$RELAY_DIR/.local}"
PID_FILE="$LOCAL_DATA_DIR/relay.pid"
LOG_FILE="$LOCAL_DATA_DIR/relay.log"
ENV_FILE="$LOCAL_DATA_DIR/dev.env"
DB_FILE="$LOCAL_DATA_DIR/relay.db"
BIN_FILE="$LOCAL_DATA_DIR/relay"
HELPER_BIN="$RELAY_DIR/.local/safeenv-helper"

INTERNAL_SPAWNED_PID=""
INTERNAL_SPAWNED_LSTART=""
INTERNAL_SPAWNED_BIN=""

ensure_helper() {
    if [ ! -d "$RELAY_DIR/.local" ]; then
        mkdir -p "$RELAY_DIR/.local"
        chmod 700 "$RELAY_DIR/.local"
    fi
    if [ -x "$HELPER_BIN" ]; then
        if [ "$HELPER_BIN" -ot "$RELAY_DIR/internal/safeenv/env.go" ] || \
           [ "$HELPER_BIN" -ot "$RELAY_DIR/cmd/safeenv-helper/main.go" ]; then
            (cd "$RELAY_DIR" && go build -o "$HELPER_BIN" ./cmd/safeenv-helper)
        fi
    else
        (cd "$RELAY_DIR" && go build -o "$HELPER_BIN" ./cmd/safeenv-helper)
    fi
    chmod 700 "$HELPER_BIN"
}

validate_env_file() {
    file="$1"
    ensure_helper || return 1
    "$HELPER_BIN" validate "$file"
}

validate_listen_addr() {
    addr="$1"
    case "$addr" in
        127.0.0.1|127.0.0.1:[0-9]*)
            port="${addr#127.0.0.1}"
            if [ -n "$port" ]; then
                port_num="${port#:}"
                case "$port_num" in
                    *[!0-9]*)
                        echo "error: LISTEN_ADDR override rejected: invalid port in $addr" >&2
                        return 1
                        ;;
                esac
            fi
            return 0
            ;;
        *)
            echo "error: LISTEN_ADDR override rejected: local native relay is strictly restricted to 127.0.0.1 loopback; non-loopback or 0.0.0.0 override rejected (got: $addr)" >&2
            return 1
            ;;
    esac
}

# Non-executable whitelist parser: all reading occurs strictly through safeenv
# on the opened file descriptor without TOCTOU path reopen or command execution.
load_and_validate_env() {
    # Check ambient LISTEN_ADDR if provided in caller environment
    if [ -n "${LISTEN_ADDR:-}" ]; then
        validate_listen_addr "$LISTEN_ADDR" || return 1
    fi

    ensure_helper || return 1

    # Reset sensitive ambient vars that could poison local dev
    unset DEV_AUTH_MODE DEV_AUTH_HOST_ID DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN \
          DEV_ADMIN_TOKEN DEV_HOST_TOKEN DEV_HOST_ID \
          SQLITE_PATH LOG_LEVEL LOG_FORMAT \
          PUBLIC_BASE_URL RELAY_PUBLIC_BASE_URL 2>/dev/null || true

    env_output=$("$HELPER_BIN" dump "$ENV_FILE") || return 1

    while IFS= read -r raw_line || [ -n "$raw_line" ]; do
        case "$raw_line" in
            *=*)
                key="${raw_line%%=*}"
                val="${raw_line#*=}"
                case "$key" in
                    DEV_AUTH_MODE|DEV_AUTH_HOST_ID|DEV_AUTH_ADMIN_TOKEN|DEV_AUTH_HOST_TOKEN|\
                    DEV_ADMIN_TOKEN|DEV_HOST_TOKEN|DEV_HOST_ID|\
                    LISTEN_ADDR|SQLITE_PATH|LOG_LEVEL|LOG_FORMAT|MAX_FRAME_BYTES|MAX_SEND_QUEUE_SIZE|\
                    HEARTBEAT_INTERVAL|HEARTBEAT_TIMEOUT|HTTP_READ_HEADER_TIMEOUT|HTTP_READ_TIMEOUT|\
                    HTTP_WRITE_TIMEOUT|HTTP_IDLE_TIMEOUT|SHUTDOWN_GRACE_PERIOD|PUBLIC_BASE_URL|\
                    RELAY_PUBLIC_BASE_URL|TRUST_PROXY|WECHAT_APP_ID|WECHAT_APP_SECRET|ADMIN_OPENID|\
                    TOKEN_HASH_PEPPER|SMOKE_PAYLOAD_SENTINEL|SMOKE_EVENTS|ALLOW_LOOPBACK_WS)
                        export "$key=$val"
                        ;;
                    *)
                        ;;
                esac
                ;;
        esac
    done <<EOF
$env_output
EOF

    # Enforce loopback binding (default 127.0.0.1:8080)
    export LISTEN_ADDR="${LISTEN_ADDR:-127.0.0.1:8080}"
    validate_listen_addr "$LISTEN_ADDR" || return 1

    export SQLITE_PATH="${SQLITE_PATH:-$DB_FILE}"
    return 0
}

ensure_data_dir() {
    if [ ! -d "$LOCAL_DATA_DIR" ]; then
        mkdir -p "$LOCAL_DATA_DIR"
    fi
    chmod 700 "$LOCAL_DATA_DIR"
}

generate_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 32 | tr "+/" "-_" | tr -d "\n\r="
    elif [ -c /dev/urandom ]; then
        head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r="
    else
        echo "token-$$"
    fi
}

ensure_tokens() {
    ensure_data_dir
    ensure_helper || return 1
    "$HELPER_BIN" generate "$ENV_FILE" "$DB_FILE" || return 1
}

build_relay() {
    ensure_data_dir
    ensure_helper || return 1
    (cd "$RELAY_DIR" && go build -o "$BIN_FILE" ./cmd/relay)
    chmod 700 "$BIN_FILE"
}

# Returns:
#   0: Process running and matches (PID, LSTART, BIN)
#   1: Missing arguments / invalid PID
#   3: Process not running (stale)
#   4: Identity mismatch (PID reuse, forged identity, wrong start time or command)
verify_process_record() {
    target_pid="$1"
    expected_lstart="${2:-}"
    expected_bin="${3:-$BIN_FILE}"

    if [ -z "$target_pid" ]; then
        return 1
    fi
    case "$target_pid" in
        *[!0-9]*) return 1 ;;
    esac

    # 1. Process must be active
    if ! kill -0 "$target_pid" 2>/dev/null; then
        return 3
    fi

    # 2. LSTART must be provided and must match running process start time
    if [ -z "$expected_lstart" ]; then
        return 4
    fi
    curr_lstart=$(ps -p "$target_pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
    if [ -z "$curr_lstart" ] || [ "$curr_lstart" != "$expected_lstart" ]; then
        return 4
    fi

    # 3. Executable must match Relay binary identity (never an arbitrary binary)
    if [ -z "$expected_bin" ]; then
        expected_bin="$BIN_FILE"
    fi
    expected_base=$(basename "$expected_bin")
    case "$expected_base" in
        relay|relay.*)
            ;;
        *)
            return 4
            ;;
    esac

    curr_comm=$(ps -p "$target_pid" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
    curr_cmd_word=$(printf '%s' "$curr_comm" | awk '{print $1}')
    curr_cmd_base=$(basename "$curr_cmd_word")
    case "$curr_cmd_base" in
        relay|relay.*)
            return 0
            ;;
        *)
            case "$curr_comm" in
                *"$expected_bin"*)
                    return 0
                    ;;
                *)
                    return 4
                    ;;
            esac
            ;;
    esac
}

# Returns:
#   0: Process running and matches Relay identity
#   1: PID file missing
#   2: PID file empty/invalid
#   3: Process not running (stale)
#   4: Identity mismatch (possible PID reuse or forged PID file)
verify_pid_identity() {
    pid_file="$1"
    if [ ! -f "$pid_file" ]; then
        return 1
    fi

    stored_pid=$(sed -n '1p' "$pid_file" | tr -d '[:space:]')
    if [ -z "$stored_pid" ]; then
        return 2
    fi
    case "$stored_pid" in
        *[!0-9]*) return 2 ;;
    esac

    saved_lstart=$(grep '^LSTART=' "$pid_file" 2>/dev/null | sed 's/^LSTART=//' || true)
    saved_bin=$(grep '^BIN=' "$pid_file" 2>/dev/null | sed 's/^BIN=//' || true)

    # Missing start time in launch record is strictly rejected as identity mismatch
    if [ -z "$saved_lstart" ]; then
        if ! kill -0 "$stored_pid" 2>/dev/null; then
            return 3
        fi
        return 4
    fi

    # If BIN was recorded in PID file, verify it is a valid relay binary
    if [ -n "$saved_bin" ]; then
        saved_bin_base=$(basename "$saved_bin")
        case "$saved_bin_base" in
            relay|relay.*)
                ;;
            *)
                return 4
                ;;
        esac
    fi

    verify_process_record "$stored_pid" "$saved_lstart" "${saved_bin:-$BIN_FILE}"
}

start_relay_internal() {
    ensure_tokens
    load_and_validate_env || return 1

    if [ -f "$PID_FILE" ]; then
        v_rc=0
        verify_pid_identity "$PID_FILE" || v_rc=$?
        case "$v_rc" in
            0)
                pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
                echo "Relay server is already running (PID: $pid)"
                return 0
                ;;
            4)
                pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
                echo "error: PID file points to active PID $pid which does not match Relay server identity; refusing to overwrite or start" >&2
                return 1
                ;;
            *)
                rm -f "$PID_FILE"
                ;;
        esac
    fi

    if [ -z "${LOCAL_DEV_SKIP_BUILD:-}" ] || [ ! -x "$BIN_FILE" ]; then
        echo "Building relay binary..."
        build_relay
    fi

    target_addr="$LISTEN_ADDR"
    echo "Starting Relay server on $LISTEN_ADDR (logs: $LOG_FILE)..."
    touch "$LOG_FILE"
    chmod 600 "$LOG_FILE"

    if [ -n "${LOCAL_DEV_DELAY_EXEC_SECS:-}" ]; then
        case "$LOCAL_DEV_DELAY_EXEC_SECS" in
            *[!0-9.]*|*.*.*|.*|*.)
                echo "error: invalid LOCAL_DEV_DELAY_EXEC_SECS: must be numeric (e.g. 0.2)" >&2
                return 1
                ;;
            ""|.)
                echo "error: invalid LOCAL_DEV_DELAY_EXEC_SECS: must be numeric" >&2
                return 1
                ;;
        esac
        ( sleep "$LOCAL_DEV_DELAY_EXEC_SECS" && exec "$BIN_FILE" ) >> "$LOG_FILE" 2>&1 &
        relay_pid=$!
    else
        "$BIN_FILE" >> "$LOG_FILE" 2>&1 &
        relay_pid=$!
    fi

    # Bounded wait for child process to complete exec and establish stable identity
    exec_wait_limit="${LOCAL_DEV_EXEC_WAIT_LIMIT:-50}"
    case "$exec_wait_limit" in
        *[!0-9]*)
            echo "error: invalid LOCAL_DEV_EXEC_WAIT_LIMIT: must be integer" >&2
            return 1
            ;;
    esac
    exec_wait_sleep=0.1
    exec_verified=0
    ps_lstart=""
    ps_comm=""
    init_lstart=""

    for i in $(seq 1 "$exec_wait_limit"); do
        # 1. Check if child process has exited prematurely
        if ! kill -0 "$relay_pid" 2>/dev/null; then
            echo "error: Relay server process exited prematurely during startup!" >&2
            if [ -f "$LOG_FILE" ]; then
                tail -n 25 "$LOG_FILE" >&2
            fi
            INTERNAL_SPAWNED_PID=""
            INTERNAL_SPAWNED_LSTART=""
            INTERNAL_SPAWNED_BIN=""
            return 1
        fi

        curr_ppid=$(ps -p "$relay_pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)
        curr_lstart=$(ps -p "$relay_pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
        curr_comm=$(ps -p "$relay_pid" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)

        # Record initial start time when first observed
        if [ -z "$init_lstart" ] && [ -n "$curr_lstart" ]; then
            init_lstart="$curr_lstart"
        fi

        # 2. Check for real identity mismatch / PID reuse
        if [ -n "$curr_ppid" ] && [ "$curr_ppid" != "$$" ]; then
            echo "error: PID reuse / mismatch detected during startup for PID $relay_pid (PPID=$curr_ppid, expected $$); refusing to record or signal" >&2
            INTERNAL_SPAWNED_PID=""
            INTERNAL_SPAWNED_LSTART=""
            INTERNAL_SPAWNED_BIN=""
            return 1
        fi
        if [ -n "$init_lstart" ] && [ -n "$curr_lstart" ] && [ "$curr_lstart" != "$init_lstart" ]; then
            echo "error: PID reuse detected during startup for PID $relay_pid (LSTART changed); refusing to record or signal" >&2
            INTERNAL_SPAWNED_PID=""
            INTERNAL_SPAWNED_LSTART=""
            INTERNAL_SPAWNED_BIN=""
            return 1
        fi

        # 3. Check if exec has completed and identity matches Relay binary
        if [ -n "$curr_lstart" ]; then
            v_rc=0
            verify_process_record "$relay_pid" "$curr_lstart" "$BIN_FILE" || v_rc=$?
            if [ "$v_rc" -eq 0 ]; then
                exec_verified=1
                ps_lstart="$curr_lstart"
                ps_comm="$curr_comm"
                break
            fi
        fi

        # 4. Child is still executing pre-exec wrapper / shell: 暂未exec
        sleep "$exec_wait_sleep"
    done

    if [ "$exec_verified" -ne 1 ]; then
        echo "error: timeout waiting for Relay server process to complete exec and establish identity!" >&2
        # Clean up this round's child safely, without relaxing pre-signal verification
        if kill -0 "$relay_pid" 2>/dev/null; then
            cleanup_ppid=$(ps -p "$relay_pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)
            cleanup_lstart=$(ps -p "$relay_pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
            safe_to_clean=0
            if [ "$cleanup_ppid" = "$$" ]; then
                if [ -z "$init_lstart" ] || [ "$cleanup_lstart" = "$init_lstart" ]; then
                    safe_to_clean=1
                fi
            fi

            if [ "$safe_to_clean" -eq 1 ]; then
                kill -TERM "$relay_pid" 2>/dev/null || true
                for k in $(seq 1 20); do
                    if ! kill -0 "$relay_pid" 2>/dev/null; then
                        break
                    fi
                    sleep 0.1
                done
                if kill -0 "$relay_pid" 2>/dev/null; then
                    curr_check_ppid=$(ps -p "$relay_pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)
                    curr_check_lstart=$(ps -p "$relay_pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
                    if [ "$curr_check_ppid" = "$$" ] && ( [ -z "$init_lstart" ] || [ "$curr_check_lstart" = "$init_lstart" ] ); then
                        kill -KILL "$relay_pid" 2>/dev/null || true
                    fi
                fi
                wait "$relay_pid" 2>/dev/null || true
            else
                echo "error: process identity check failed for PID $relay_pid during startup timeout cleanup; refusing to signal" >&2
            fi
        fi
        INTERNAL_SPAWNED_PID=""
        INTERNAL_SPAWNED_LSTART=""
        INTERNAL_SPAWNED_BIN=""
        return 1
    fi

    cat > "$PID_FILE" <<PIDEOF
$relay_pid
LSTART=$ps_lstart
BIN=$BIN_FILE
COMMAND=$ps_comm
PIDEOF
    chmod 600 "$PID_FILE"
    INTERNAL_SPAWNED_PID="$relay_pid"
    INTERNAL_SPAWNED_LSTART="$ps_lstart"
    INTERNAL_SPAWNED_BIN="$BIN_FILE"

    echo "Waiting for healthz & readyz at http://$target_addr..."
    ready=0
    ready_wait_limit="${LOCAL_DEV_READY_WAIT_LIMIT:-50}"
    case "$ready_wait_limit" in
        *[!0-9]*) ready_wait_limit=50 ;;
    esac
    for i in $(seq 1 "$ready_wait_limit"); do
        if verify_process_record "$relay_pid" "$ps_lstart" "$BIN_FILE"; then
            if curl -s -f "http://$target_addr/readyz" >/dev/null 2>&1; then
                ready=1
                break
            fi
        else
            echo "error: Relay server process exited prematurely during startup!" >&2
            if [ -f "$LOG_FILE" ]; then
                tail -n 25 "$LOG_FILE" >&2
            fi
            rm -f "$PID_FILE"
            INTERNAL_SPAWNED_PID=""
            INTERNAL_SPAWNED_LSTART=""
            INTERNAL_SPAWNED_BIN=""
            return 1
        fi
        sleep 0.1
    done

    if [ "$ready" -eq 1 ]; then
        [ -f "$DB_FILE" ] && chmod 600 "$DB_FILE"
        echo "Relay server successfully started (PID: $relay_pid, listening on $target_addr)"
        return 0
    else
        echo "error: timeout waiting for readyz at http://$target_addr; cleaning up failed startup process" >&2
        stop_specific_pid "$relay_pid" "$ps_lstart" "$BIN_FILE" || true
        rm -f "$PID_FILE"
        INTERNAL_SPAWNED_PID=""
        INTERNAL_SPAWNED_LSTART=""
        INTERNAL_SPAWNED_BIN=""
        return 1
    fi
}

cmd_start() {
    start_relay_internal
}

cmd_run() {
    ensure_tokens
    load_and_validate_env || return 1
    echo "Building relay binary..."
    build_relay

    echo "Running Relay server in foreground on $LISTEN_ADDR (Ctrl+C to stop)..."
    exec "$BIN_FILE"
}

cmd_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "No PID file found at $PID_FILE; Relay server may not be running"
        return 0
    fi

    v_rc=0
    verify_pid_identity "$PID_FILE" || v_rc=$?

    case "$v_rc" in
        1|2)
            echo "PID file was empty or missing; cleaned up"
            rm -f "$PID_FILE"
            return 0
            ;;
        3)
            pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
            echo "Process $pid is not running; removing stale PID file"
            rm -f "$PID_FILE"
            return 0
            ;;
        4)
            pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
            echo "error: PID file points to PID $pid, but process identity does not match Relay server (possible PID reuse or forged PID file); refusing to signal process" >&2
            return 1
            ;;
        0)
            pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
            ;;
    esac

    saved_lstart=$(grep '^LSTART=' "$PID_FILE" 2>/dev/null | sed 's/^LSTART=//' || true)
    saved_bin=$(grep '^BIN=' "$PID_FILE" 2>/dev/null | sed 's/^BIN=//' || true)
    expected_bin="${saved_bin:-$BIN_FILE}"

    echo "Stopping Relay server (PID: $pid) with SIGTERM..."
    if ! verify_process_record "$pid" "$saved_lstart" "$expected_bin" >/dev/null 2>&1; then
        echo "error: process identity verification failed immediately before SIGTERM; aborting signal" >&2
        return 1
    fi
    kill -TERM "$pid" 2>/dev/null || true

    stopped=0
    for i in $(seq 1 50); do
        if ! kill -0 "$pid" 2>/dev/null; then
            stopped=1
            break
        fi
        sleep 0.2
    done

    [ -f "$DB_FILE" ] && chmod 600 "$DB_FILE"
    if [ "$stopped" -eq 1 ]; then
        rm -f "$PID_FILE"
        echo "Relay server (PID: $pid) stopped gracefully"
        return 0
    else
        echo "Process did not terminate within grace period; verifying identity before SIGKILL..."
        if ! verify_process_record "$pid" "$saved_lstart" "$expected_bin" >/dev/null 2>&1; then
            echo "error: process identity verification failed immediately before SIGKILL; aborting kill" >&2
            rm -f "$PID_FILE"
            return 1
        fi
        kill -KILL "$pid" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo "Relay server killed"
        return 0
    fi
}

cmd_status() {
    load_and_validate_env || return 1

    if [ -f "$PID_FILE" ]; then
        v_rc=0
        verify_pid_identity "$PID_FILE" || v_rc=$?
        case "$v_rc" in
            0)
                pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
                echo "Relay server is running (PID: $pid)"
                target_addr="$LISTEN_ADDR"
                echo "Checking readyz probe (http://$target_addr/readyz):"
                if curl -s "http://$target_addr/readyz"; then
                    echo ""
                else
                    echo "readyz probe failed"
                fi
                return 0
                ;;
            4)
                pid=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
                echo "error: PID file points to active PID $pid which does not match Relay server identity (possible PID reuse or forged PID file)" >&2
                return 1
                ;;
            *)
                pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null || true)
                echo "Stale PID file found ($pid); process is not running"
                return 1
                ;;
        esac
    else
        echo "Relay server is stopped"
        return 3
    fi
}

cmd_smoke() {
    ensure_tokens
    load_and_validate_env || return 1

    target_addr="$LISTEN_ADDR"
    base_url="http://$target_addr"

    events="${SMOKE_EVENTS:-1000}"
    sentinel="${SMOKE_PAYLOAD_SENTINEL:-local-smoke-sentinel-$(generate_token | cut -c 1-16)}"
    export SMOKE_PAYLOAD_SENTINEL="$sentinel"

    echo "Running smoke test against $base_url (events=$events)..."
    (
        cd "$RELAY_DIR"
        go run ./cmd/wss-smoke \
            -base-url "$base_url" \
            --allow-loopback-ws \
            -env-file "$ENV_FILE" \
            -events "$events"
    )
}

cmd_verify_data_boundary() {
    ensure_tokens
    load_and_validate_env || return 1

    echo "Verifying zero data retention in SQLite database and logs..."

    check_absent() {
        label=$1
        file=$2
        val=$3
        if [ -z "$val" ]; then
            return 0
        fi
        if [ ! -f "$file" ]; then
            return 0
        fi
        if printf "%s\n" "$val" | grep -aFq -f - "$file"; then
            echo "DATA BOUNDARY VIOLATION: $label ($file) contains sensitive marker!" >&2
            return 1
        fi
    }

    for secret in "$DEV_AUTH_ADMIN_TOKEN" "$DEV_AUTH_HOST_TOKEN"; do
        if [ -f "$LOG_FILE" ]; then
            check_absent "Relay logs" "$LOG_FILE" "$secret"
        fi
        for db in "$DB_FILE" "${DB_FILE}-wal" "${DB_FILE}-shm"; do
            if [ -f "$db" ]; then
                check_absent "Relay SQLite" "$db" "$secret"
            fi
        done
    done

    if [ -n "${SMOKE_PAYLOAD_SENTINEL:-}" ]; then
        if [ -f "$LOG_FILE" ]; then
            check_absent "Relay logs" "$LOG_FILE" "$SMOKE_PAYLOAD_SENTINEL"
        fi
        for db in "$DB_FILE" "${DB_FILE}-wal" "${DB_FILE}-shm"; do
            if [ -f "$db" ]; then
                check_absent "Relay SQLite" "$db" "$SMOKE_PAYLOAD_SENTINEL"
            fi
        done
    fi

    echo "Data boundary verification passed: zero tokens and zero payload sentinels retained."
}

# stop_specific_pid <target_pid> [expected_lstart] [expected_bin]
# Safely stops target process only after verifying complete identity:
# (PID, start time, and executable). Never relies only on kill -0.
stop_specific_pid() {
    target_pid="$1"
    expected_lstart="${2:-}"
    expected_bin="${3:-}"

    if [ -z "$target_pid" ]; then
        return 0
    fi
    case "$target_pid" in
        *[!0-9]*)
            echo "warning: refusing to signal invalid PID $target_pid" >&2
            return 1
            ;;
    esac

    # If LSTART/BIN not passed, attempt to read from matching PID file record
    if [ -z "$expected_lstart" ] && [ -f "$PID_FILE" ]; then
        file_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ "$file_pid" = "$target_pid" ]; then
            expected_lstart=$(grep '^LSTART=' "$PID_FILE" 2>/dev/null | sed 's/^LSTART=//' || true)
            expected_bin=$(grep '^BIN=' "$PID_FILE" 2>/dev/null | sed 's/^BIN=//' || true)
        fi
    fi

    if [ -z "$expected_lstart" ]; then
        echo "error: refusing to stop PID $target_pid: missing verified launch record start time" >&2
        return 1
    fi
    if [ -z "$expected_bin" ]; then
        expected_bin="$BIN_FILE"
    fi

    # Verify identity prior to sending SIGTERM
    v_rc=0
    verify_process_record "$target_pid" "$expected_lstart" "$expected_bin" || v_rc=$?
    case "$v_rc" in
        0)
            # Verified
            ;;
        3)
            # Process already not running
            if [ -f "$PID_FILE" ]; then
                cur_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
                if [ "$cur_pid" = "$target_pid" ]; then
                    rm -f "$PID_FILE"
                fi
            fi
            return 0
            ;;
        *)
            echo "error: process identity verification failed before SIGTERM for PID $target_pid (expected: $expected_lstart, $expected_bin); refusing to signal" >&2
            return 1
            ;;
    esac

    kill -TERM "$target_pid" 2>/dev/null || true

    stopped=0
    for i in $(seq 1 30); do
        if ! kill -0 "$target_pid" 2>/dev/null; then
            stopped=1
            break
        fi
        sleep 0.1
    done

    # If not stopped, verify identity again prior to sending SIGKILL
    if [ "$stopped" -ne 1 ]; then
        v_rc=0
        verify_process_record "$target_pid" "$expected_lstart" "$expected_bin" || v_rc=$?
        case "$v_rc" in
            0)
                kill -KILL "$target_pid" 2>/dev/null || true
                ;;
            3)
                stopped=1
                ;;
            *)
                echo "error: process identity verification failed before SIGKILL for PID $target_pid; refusing to kill" >&2
                return 1
                ;;
        esac
    fi

    if [ -f "$PID_FILE" ]; then
        cur_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ "$cur_pid" = "$target_pid" ]; then
            rm -f "$PID_FILE"
        fi
    fi
    return 0
}

cmd_self_test() {
    echo "========================================================"
    echo "=== Running Local Native Relay Self-Test Pipeline    ==="
    echo "========================================================"

    pre_existing_pid=""
    if [ -f "$PID_FILE" ]; then
        if verify_pid_identity "$PID_FILE" >/dev/null 2>&1; then
            pre_existing_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
        fi
    fi

    test_spawned_pid=""
    test_spawned_lstart=""
    test_spawned_bin=""
    if [ -n "$pre_existing_pid" ]; then
        echo "Existing verified Relay server found running (PID: $pre_existing_pid); preserving existing instance."
    else
        trap '
            status=$?
            trap - EXIT HUP INT TERM
            if [ -n "$test_spawned_pid" ]; then
                echo "Cleaning up self-test spawned process (PID: $test_spawned_pid)..." >&2
                stop_specific_pid "$test_spawned_pid" "$test_spawned_lstart" "$test_spawned_bin"
            fi
            exit $status
        ' EXIT HUP INT TERM

        start_relay_internal || {
            echo "error: self-test startup failed" >&2
            return 1
        }
        test_spawned_pid="$INTERNAL_SPAWNED_PID"
        test_spawned_lstart="$INTERNAL_SPAWNED_LSTART"
        test_spawned_bin="$INTERNAL_SPAWNED_BIN"
    fi

    echo "--- Running smoke verification ---"
    cmd_smoke

    echo "--- Smoke completed, verifying data boundary ---"
    cmd_verify_data_boundary

    if [ -n "$pre_existing_pid" ]; then
        echo "Pre-existing Relay server (PID: $pre_existing_pid) is preserved and remains running."
    else
        echo "Stopping self-test Relay server (PID: $test_spawned_pid)..."
        stop_specific_pid "$test_spawned_pid" "$test_spawned_lstart" "$test_spawned_bin"
        test_spawned_pid=""
        test_spawned_lstart=""
        test_spawned_bin=""
        trap - EXIT HUP INT TERM
    fi

    echo "========================================================"
    echo "=== Local Native Relay Self-Test Passed Successfully ==="
    echo "========================================================"
}

action="${1:-help}"
case "$action" in
    start) cmd_start ;;
    run) cmd_run ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    smoke) cmd_smoke ;;
    verify-data-boundary) cmd_verify_data_boundary ;;
    self-test) cmd_self_test ;;
    _stop_specific_pid)
        shift
        stop_specific_pid "$@"
        ;;
    help|*)
        cat <<EOF
Usage: $0 {start|run|stop|status|smoke|verify-data-boundary|self-test}

Commands:
  start                Build and launch Relay server in background (127.0.0.1:8080)
  run                  Launch Relay server in foreground (logs to stdout)
  stop                 Gracefully terminate running Relay server (SIGTERM)
  status               Check whether Relay server is active and healthy
  smoke                Run end-to-end WSS smoke test (health/ready, RPC, 1000 ordered events)
  verify-data-boundary Verify that zero tokens or sentinels were saved to DB or logs
  self-test            Execute full start -> smoke -> verify -> stop test cycle
EOF
        exit 1
        ;;
esac
