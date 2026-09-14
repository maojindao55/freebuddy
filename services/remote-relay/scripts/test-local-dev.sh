#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELAY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOCAL_DEV_SH="$SCRIPT_DIR/local-dev.sh"

FAILED=0

pass() {
    printf "  \033[32mPASS\033[0m: %s\n" "$1"
}

fail() {
    printf "  \033[31mFAIL\033[0m: %s\n" "$1" >&2
    FAILED=1
}

echo "============================================================"
echo "=== Running Local Dev Native Security & Lifecycle Tests ==="
echo "============================================================"

# Test 1: 恶意env未执行 (Malicious env commands & redirects not executed)
echo "[Test 1] 恶意env未执行 (Command substitution & redirection prevention)"
TEST_DIR_1=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_1"' EXIT
mkdir -p "$TEST_DIR_1/.local"
chmod 700 "$TEST_DIR_1/.local"

CANARY_CMD="$TEST_DIR_1/canary_cmd"
CANARY_BT="$TEST_DIR_1/canary_bt"
CANARY_REDIR="$TEST_DIR_1/canary_redir"

cat > "$TEST_DIR_1/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=\$(touch $CANARY_CMD)
DEV_AUTH_HOST_TOKEN=\`touch $CANARY_BT\`
LISTEN_ADDR=127.0.0.1:8080 > $CANARY_REDIR
SQLITE_PATH=$TEST_DIR_1/.local/relay.db
EOF
chmod 600 "$TEST_DIR_1/.local/dev.env"

# Run status (which parses dev.env)
set +e
RELAY_LOCAL_DATA_DIR="$TEST_DIR_1/.local" "$LOCAL_DEV_SH" status >/dev/null 2>&1
status_rc=$?
set -e

if [ -e "$CANARY_CMD" ]; then
    fail "Command substitution \$(touch ...) was executed!"
else
    pass "Command substitution was NOT executed"
fi

if [ -e "$CANARY_BT" ]; then
    fail "Backtick command substitution \`touch ...\` was executed!"
else
    pass "Backtick substitution was NOT executed"
fi

if [ -e "$CANARY_REDIR" ]; then
    fail "Redirection > ... was executed!"
else
    pass "Redirection was NOT executed"
fi
rm -rf "$TEST_DIR_1"

# Test 2: group/world perms/symlink拒绝
echo "[Test 2] group/world perms/symlink拒绝 (Permission & symlink enforcement)"
TEST_DIR_2=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_2"' EXIT
mkdir -p "$TEST_DIR_2/.local"
chmod 700 "$TEST_DIR_2/.local"

# 2a. Symlink rejection
REAL_ENV="$TEST_DIR_2/real.env"
cat > "$REAL_ENV" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=valid_token_12345678901234567890123456789012
DEV_AUTH_HOST_TOKEN=valid_token_12345678901234567890123456789012
LISTEN_ADDR=127.0.0.1:8080
EOF
chmod 600 "$REAL_ENV"
ln -s "$REAL_ENV" "$TEST_DIR_2/.local/dev.env"

set +e
out_sym=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_2/.local" "$LOCAL_DEV_SH" status 2>&1)
rc_sym=$?
set -e
if [ "$rc_sym" -ne 0 ] && printf '%s\n' "$out_sym" | grep -qi "symbolic link"; then
    pass "Symlink env file was strictly rejected"
else
    fail "Symlink env file was not rejected (rc=$rc_sym, out=$out_sym)"
fi
rm -f "$TEST_DIR_2/.local/dev.env"

# 2b. Permissions rejection: 0644, 0666, 0640, 0700
cp "$REAL_ENV" "$TEST_DIR_2/.local/dev.env"
for bad_perm in 0644 0666 0640 0700; do
    chmod "$bad_perm" "$TEST_DIR_2/.local/dev.env"
    set +e
    out_perm=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_2/.local" "$LOCAL_DEV_SH" status 2>&1)
    rc_perm=$?
    set -e
    if [ "$rc_perm" -ne 0 ] && printf '%s\n' "$out_perm" | grep -qi "invalid permissions"; then
        pass "Permissive mode $bad_perm was rejected"
    else
        fail "Permissive mode $bad_perm was not rejected (rc=$rc_perm)"
    fi
done

# 2c. Valid permissions: 0600 and 0400 accepted
for good_perm in 0600 0400; do
    chmod "$good_perm" "$TEST_DIR_2/.local/dev.env"
    set +e
    out_good=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_2/.local" "$LOCAL_DEV_SH" status 2>&1)
    rc_good=$?
    set -e
    # status exits 3 when server is stopped, but env validation succeeds
    if [ "$rc_good" -eq 3 ] && printf '%s\n' "$out_good" | grep -qi "stopped"; then
        pass "Secure mode $good_perm was accepted"
    else
        fail "Secure mode $good_perm failed env validation (rc=$rc_good, out=$out_good)"
    fi
done

# 2d. 生成时symlink拒绝与0600保证 (Generation symlink rejection & 0600 mode)
TARGET_SENSITIVE="$TEST_DIR_2/sensitive_file"
echo "ORIGINAL_CONTENT" > "$TARGET_SENSITIVE"
chmod 600 "$TARGET_SENSITIVE"
rm -f "$TEST_DIR_2/.local/dev.env"
ln -s "$TARGET_SENSITIVE" "$TEST_DIR_2/.local/dev.env"

set +e
out_gen_sym=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_2/.local" "$LOCAL_DEV_SH" start 2>&1)
rc_gen_sym=$?
set -e

if [ "$rc_gen_sym" -ne 0 ] && printf '%s\n' "$out_gen_sym" | grep -qi "symbolic link"; then
    pass "Generation rejected pre-existing symlink at dev.env"
else
    fail "Generation did not reject pre-existing symlink (rc=$rc_gen_sym, out=$out_gen_sym)"
fi

if [ "$(cat "$TARGET_SENSITIVE")" = "ORIGINAL_CONTENT" ]; then
    pass "Symlink target was NOT overwritten during env generation"
else
    fail "Symlink target WAS OVERWRITTEN during env generation!"
fi

# 2e. 正常生成确认权限严格为0600
rm -f "$TEST_DIR_2/.local/dev.env"
RELAY_LOCAL_DATA_DIR="$TEST_DIR_2/.local" "$LOCAL_DEV_SH" status >/dev/null 2>&1 || true
# trigger generation via ensuring tokens
if [ -f "$TEST_DIR_2/.local/dev.env" ]; then
    gen_stat=$(ls -l "$TEST_DIR_2/.local/dev.env" | awk '{print $1}')
    case "$gen_stat" in
        -rw-------*)
            pass "Generated dev.env strictly has 0600 permissions ($gen_stat)"
            ;;
        *)
            fail "Generated dev.env has invalid permissions: $gen_stat"
            ;;
    esac
fi

rm -rf "$TEST_DIR_2"

# Test 3: 监听覆盖拒绝 (Non-loopback listen address override rejected)
echo "[Test 3] 监听覆盖拒绝 (Forced 127.0.0.1 loopback & override rejection)"
TEST_DIR_3=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_3"' EXIT
mkdir -p "$TEST_DIR_3/.local"
chmod 700 "$TEST_DIR_3/.local"
cat > "$TEST_DIR_3/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=valid_token_12345678901234567890123456789012
DEV_AUTH_HOST_TOKEN=valid_token_12345678901234567890123456789012
LISTEN_ADDR=127.0.0.1:8080
EOF
chmod 600 "$TEST_DIR_3/.local/dev.env"

# Test ambient overrides
for bad_addr in "0.0.0.0:8080" ":8080" "192.168.1.1:8080" "localhost:8080" "10.0.0.1:8080"; do
    set +e
    out_override=$(LISTEN_ADDR="$bad_addr" RELAY_LOCAL_DATA_DIR="$TEST_DIR_3/.local" "$LOCAL_DEV_SH" status 2>&1)
    rc_override=$?
    set -e
    if [ "$rc_override" -ne 0 ] && printf '%s\n' "$out_override" | grep -qi "override rejected"; then
        pass "Ambient LISTEN_ADDR=$bad_addr was rejected"
    else
        fail "Ambient LISTEN_ADDR=$bad_addr was NOT rejected (rc=$rc_override, out=$out_override)"
    fi
done

# Test env file override with non-loopback
cat > "$TEST_DIR_3/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=valid_token_12345678901234567890123456789012
DEV_AUTH_HOST_TOKEN=valid_token_12345678901234567890123456789012
LISTEN_ADDR=0.0.0.0:8080
EOF
chmod 600 "$TEST_DIR_3/.local/dev.env"
set +e
out_env_bad=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_3/.local" "$LOCAL_DEV_SH" status 2>&1)
rc_env_bad=$?
set -e
if [ "$rc_env_bad" -ne 0 ] && printf '%s\n' "$out_env_bad" | grep -qi "override rejected"; then
    pass "dev.env LISTEN_ADDR=0.0.0.0:8080 was rejected"
else
    fail "dev.env LISTEN_ADDR=0.0.0.0:8080 was NOT rejected (rc=$rc_env_bad, out=$out_env_bad)"
fi
rm -rf "$TEST_DIR_3"

# Test 4: 伪造PID与多清理分支不杀无关进程 (PID identity binding & cleanup branch protection)
echo "[Test 4] 伪造PID与清理分支不伤无关进程 (PID/start-time/exec identity verification across all signal paths)"
TEST_DIR_4=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_4"' EXIT
mkdir -p "$TEST_DIR_4/.local"
chmod 700 "$TEST_DIR_4/.local"

# Start unrelated sleep process
sleep 120 &
SLEEP_PID=$!
sleep 0.1
SLEEP_LSTART=$(ps -p "$SLEEP_PID" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)

# 4a. 正常 stop: 伪造PID文件（缺少LSTART）
cat > "$TEST_DIR_4/.local/relay.pid" <<EOF
$SLEEP_PID
EOF
chmod 600 "$TEST_DIR_4/.local/relay.pid"

set +e
out_stop_4a=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" stop 2>&1)
rc_stop_4a=$?
set -e

if [ "$rc_stop_4a" -ne 0 ] && printf '%s\n' "$out_stop_4a" | grep -qi "does not match"; then
    pass "Stop operation refused on forged PID without LSTART"
else
    fail "Stop operation did not properly reject forged PID without LSTART (rc=$rc_stop_4a, out=$out_stop_4a)"
fi
if kill -0 "$SLEEP_PID" 2>/dev/null; then
    pass "Unrelated sleep process was NOT killed (4a)"
else
    fail "Unrelated sleep process WAS KILLED by stop (4a)!"
fi

# 4b. 正常 stop: 伪造PID文件（错误LSTART）
cat > "$TEST_DIR_4/.local/relay.pid" <<EOF
$SLEEP_PID
LSTART=Mon Jan  1 00:00:00 2001
BIN=$TEST_DIR_4/.local/relay
EOF
chmod 600 "$TEST_DIR_4/.local/relay.pid"

set +e
out_stop_4b=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" stop 2>&1)
rc_stop_4b=$?
set -e

if [ "$rc_stop_4b" -ne 0 ] && printf '%s\n' "$out_stop_4b" | grep -qi "does not match"; then
    pass "Stop operation refused on forged PID with wrong LSTART"
else
    fail "Stop operation did not reject forged PID with wrong LSTART (rc=$rc_stop_4b, out=$out_stop_4b)"
fi
if kill -0 "$SLEEP_PID" 2>/dev/null; then
    pass "Unrelated sleep process was NOT killed (4b)"
else
    fail "Unrelated sleep process WAS KILLED by stop (4b)!"
fi

# 4c. 正常 stop: 伪造PID文件（正确PID/LSTART，但可执行程序不符）
cat > "$TEST_DIR_4/.local/relay.pid" <<EOF
$SLEEP_PID
LSTART=$SLEEP_LSTART
BIN=/bin/sleep
EOF
chmod 600 "$TEST_DIR_4/.local/relay.pid"

set +e
out_stop_4c=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" stop 2>&1)
rc_stop_4c=$?
set -e

if [ "$rc_stop_4c" -ne 0 ] && printf '%s\n' "$out_stop_4c" | grep -qi "does not match"; then
    pass "Stop operation refused when executable does not match Relay identity"
else
    fail "Stop operation did not reject mismatched executable (rc=$rc_stop_4c, out=$out_stop_4c)"
fi
if kill -0 "$SLEEP_PID" 2>/dev/null; then
    pass "Unrelated sleep process was NOT killed (4c)"
else
    fail "Unrelated sleep process WAS KILLED by stop (4c)!"
fi

# 4d. stop_specific_pid 直接调用验证（无LSTART、错误LSTART、错误BIN均拒绝）
set +e
out_sp_no_lstart=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" _stop_specific_pid "$SLEEP_PID" 2>&1)
rc_sp_no_lstart=$?
set -e
if [ "$rc_sp_no_lstart" -ne 0 ]; then
    pass "stop_specific_pid refused PID without verified launch record"
else
    fail "stop_specific_pid unexpectedly succeeded without launch record"
fi

set +e
out_sp_bad_lstart=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" _stop_specific_pid "$SLEEP_PID" "Mon Jan  1 00:00:00 2001" "$TEST_DIR_4/.local/relay" 2>&1)
rc_sp_bad_lstart=$?
set -e
if [ "$rc_sp_bad_lstart" -ne 0 ]; then
    pass "stop_specific_pid refused PID with mismatched start time"
else
    fail "stop_specific_pid unexpectedly succeeded with mismatched start time"
fi

set +e
out_sp_bad_bin=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" _stop_specific_pid "$SLEEP_PID" "$SLEEP_LSTART" "$TEST_DIR_4/.local/relay" 2>&1)
rc_sp_bad_bin=$?
set -e
if [ "$rc_sp_bad_bin" -ne 0 ]; then
    pass "stop_specific_pid refused PID with mismatched executable"
else
    fail "stop_specific_pid unexpectedly succeeded with mismatched executable"
fi

if kill -0 "$SLEEP_PID" 2>/dev/null; then
    pass "Unrelated sleep process was NOT killed across all stop_specific_pid checks"
else
    fail "Unrelated sleep process WAS KILLED by stop_specific_pid!"
fi

# 4e. 启动异常/超时清理分支保护 (Startup timeout cleanup identity verification)
set +e
out_startup_clean=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" _stop_specific_pid "$SLEEP_PID" "FakeStartTime" "$TEST_DIR_4/.local/relay" 2>&1)
rc_startup_clean=$?
set -e
if [ "$rc_startup_clean" -ne 0 ]; then
    pass "Startup failure cleanup refused to signal unrelated PID"
else
    fail "Startup failure cleanup signaled unrelated PID!"
fi

# 4f. self-test trap 清理分支保护 (Self-test trap cleanup identity verification)
set +e
(
    test_spawned_pid="$SLEEP_PID"
    test_spawned_lstart="FakeStartTime"
    test_spawned_bin="$TEST_DIR_4/.local/relay"
    RELAY_LOCAL_DATA_DIR="$TEST_DIR_4/.local" "$LOCAL_DEV_SH" _stop_specific_pid "$test_spawned_pid" "$test_spawned_lstart" "$test_spawned_bin" >/dev/null 2>&1
)
set -e
if kill -0 "$SLEEP_PID" 2>/dev/null; then
    pass "Self-test trap cleanup branch preserved unrelated sleep process"
else
    fail "Self-test trap cleanup branch KILLED unrelated sleep process!"
fi

# Clean up sleep process
kill -TERM "$SLEEP_PID" 2>/dev/null || true
wait "$SLEEP_PID" 2>/dev/null || true
rm -rf "$TEST_DIR_4"

# Test 5: smoke失败自动清理 (Self-test failure cleanup of child process)
echo "[Test 5] smoke失败自动清理 (Spawned child process cleanup on smoke failure)"
TEST_DIR_5=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_5"' EXIT
mkdir -p "$TEST_DIR_5/.local"
chmod 700 "$TEST_DIR_5/.local"

# Configure invalid events so smoke fails immediately
cat > "$TEST_DIR_5/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=aW52YWxpZF9hZG1pbl90b2tlbl8zMl9ieXRlc19yYW5kb21fbG9uZ18
DEV_AUTH_HOST_TOKEN=aW52YWxpZF9ob3N0X3Rva2VuXzMyX2J5dGVzX3JhbmRvbV9sb25nXw
LISTEN_ADDR=127.0.0.1:8191
SQLITE_PATH=$TEST_DIR_5/.local/relay.db
LOG_LEVEL=info
LOG_FORMAT=json
SMOKE_EVENTS=-1
EOF
chmod 600 "$TEST_DIR_5/.local/dev.env"

set +e
out_fail=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_5/.local" "$LOCAL_DEV_SH" self-test 2>&1)
rc_fail=$?
set -e

if [ "$rc_fail" -ne 0 ]; then
    pass "Self-test failed as expected when smoke config is invalid"
else
    fail "Self-test unexpectedly succeeded with invalid config"
fi

# Check if any relay process remains bound to 127.0.0.1:8191 or running from TEST_DIR_5
sleep 0.5
if curl -s "http://127.0.0.1:8191/readyz" >/dev/null 2>&1; then
    fail "Relay process was leaked after self-test failure!"
else
    pass "Spawned Relay process was automatically cleaned up on failure"
fi
rm -rf "$TEST_DIR_5"

# Test 6: 本轮已有服务保留 (Existing running service preserved during self-test)
echo "[Test 6] 本轮已有服务保留 (Preserving pre-existing service during self-test)"
TEST_DIR_6=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_6"' EXIT
mkdir -p "$TEST_DIR_6/.local"
chmod 700 "$TEST_DIR_6/.local"

# Generate valid tokens
ADMIN_TOK=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")
HOST_TOK=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")

cat > "$TEST_DIR_6/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=$ADMIN_TOK
DEV_AUTH_HOST_TOKEN=$HOST_TOK
LISTEN_ADDR=127.0.0.1:8192
SQLITE_PATH=$TEST_DIR_6/.local/relay.db
LOG_LEVEL=info
LOG_FORMAT=json
MAX_SEND_QUEUE_SIZE=2048
SMOKE_EVENTS=5
EOF
chmod 600 "$TEST_DIR_6/.local/dev.env"

# 6a. Start relay explicitly
RELAY_LOCAL_DATA_DIR="$TEST_DIR_6/.local" "$LOCAL_DEV_SH" start
ORIG_PID=$(head -n 1 "$TEST_DIR_6/.local/relay.pid")

if kill -0 "$ORIG_PID" 2>/dev/null; then
    pass "Relay server started with PID $ORIG_PID"
else
    fail "Relay server failed to start"
fi

# 6b. Run self-test against existing service
set +e
out_pres=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_6/.local" "$LOCAL_DEV_SH" self-test 2>&1)
rc_pres=$?
set -e

if [ "$rc_pres" -eq 0 ]; then
    pass "Self-test succeeded against existing instance"
else
    fail "Self-test failed against existing instance (out=$out_pres)"
fi

# 6c. Verify original PID is STILL running!
if kill -0 "$ORIG_PID" 2>/dev/null; then
    CURR_PID=$(head -n 1 "$TEST_DIR_6/.local/relay.pid")
    if [ "$CURR_PID" = "$ORIG_PID" ]; then
        pass "Existing Relay server (PID: $ORIG_PID) was PRESERVED and remains active"
    else
        fail "PID file changed from $ORIG_PID to $CURR_PID"
    fi
else
    fail "Existing Relay server (PID: $ORIG_PID) was killed by self-test!"
fi

# 6d. Clean stop
RELAY_LOCAL_DATA_DIR="$TEST_DIR_6/.local" "$LOCAL_DEV_SH" stop
if ! kill -0 "$ORIG_PID" 2>/dev/null; then
    pass "Relay server stopped cleanly"
else
    fail "Relay server did not stop"
fi
rm -rf "$TEST_DIR_6"

# Test 7: 单一FD解析防TOCTOU与白名单保护 (Single FD verification & non-executable whitelist)
echo "[Test 7] 单一FD解析防TOCTOU与白名单保护 (Single-FD parse & strict whitelist enforcement)"
TEST_DIR_7=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_7"' EXIT
mkdir -p "$TEST_DIR_7/.local"
chmod 700 "$TEST_DIR_7/.local"

cat > "$TEST_DIR_7/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_test7
DEV_AUTH_ADMIN_TOKEN=valid_test_admin_token_32_bytes_long_entropy_string
DEV_AUTH_HOST_TOKEN=valid_test_host_token_32_bytes_long_entropy_string
LISTEN_ADDR=127.0.0.1:8193
UNAUTHORIZED_INJECTION=malicious_payload
SYSTEM_SECRET=do_not_export
EOF
chmod 600 "$TEST_DIR_7/.local/dev.env"

# Run helper dump directly: only whitelisted keys should be dumped
HELPER_BIN="$RELAY_DIR/.local/safeenv-helper"
if [ -x "$HELPER_BIN" ]; then
    dump_out=$("$HELPER_BIN" dump "$TEST_DIR_7/.local/dev.env")
    if printf '%s\n' "$dump_out" | grep -q "UNAUTHORIZED_INJECTION"; then
        fail "safeenv-helper dumped unauthorized key UNAUTHORIZED_INJECTION!"
    else
        pass "safeenv-helper excluded non-whitelisted key"
    fi
    if printf '%s\n' "$dump_out" | grep -q "DEV_AUTH_HOST_ID=host_test7"; then
        pass "safeenv-helper properly parsed whitelisted key"
    else
        fail "safeenv-helper missing whitelisted key in dump output"
    fi
fi

# Run status to trigger load_and_validate_env
status_test_out=$(RELAY_LOCAL_DATA_DIR="$TEST_DIR_7/.local" "$LOCAL_DEV_SH" status 2>&1 || true)
if printf '%s\n' "$status_test_out" | grep -qi "stopped"; then
    pass "load_and_validate_env loaded env through single-fd helper without errors"
else
    fail "load_and_validate_env failed on valid env file: $status_test_out"
fi
rm -rf "$TEST_DIR_7"

# Test 8: 确定性延迟exec启动与身份验证 (Deterministic delayed-exec startup & identity verification)
echo "[Test 8] 确定性延迟exec启动与身份验证 (Deterministic delayed-exec & identity stabilization)"
TEST_DIR_8=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_8"' EXIT
mkdir -p "$TEST_DIR_8/.local"
chmod 700 "$TEST_DIR_8/.local"

ADMIN_TOK8=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")
HOST_TOK8=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")

cat > "$TEST_DIR_8/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=$ADMIN_TOK8
DEV_AUTH_HOST_TOKEN=$HOST_TOK8
LISTEN_ADDR=127.0.0.1:8194
SQLITE_PATH=$TEST_DIR_8/.local/relay.db
LOG_LEVEL=info
LOG_FORMAT=json
MAX_SEND_QUEUE_SIZE=2048
SMOKE_EVENTS=5
EOF
chmod 600 "$TEST_DIR_8/.local/dev.env"

set +e
out_delayed=$(LOCAL_DEV_DELAY_EXEC_SECS=0.3 RELAY_LOCAL_DATA_DIR="$TEST_DIR_8/.local" "$LOCAL_DEV_SH" start 2>&1)
rc_delayed=$?
set -e

if [ "$rc_delayed" -eq 0 ] && [ -f "$TEST_DIR_8/.local/relay.pid" ]; then
    pass "Relay server successfully started under 0.3s delayed exec hook"
else
    fail "Relay server failed to start under delayed exec hook (rc=$rc_delayed, out=$out_delayed)"
fi

PID_8=$(head -n 1 "$TEST_DIR_8/.local/relay.pid" 2>/dev/null || true)
LSTART_8=$(grep '^LSTART=' "$TEST_DIR_8/.local/relay.pid" 2>/dev/null | sed 's/^LSTART=//' || true)
COMM_8=$(grep '^COMMAND=' "$TEST_DIR_8/.local/relay.pid" 2>/dev/null | sed 's/^COMMAND=//' || true)

if [ -n "$PID_8" ] && kill -0 "$PID_8" 2>/dev/null; then
    pass "Process $PID_8 is actively running"
else
    fail "Process $PID_8 is not running after delayed exec start"
fi

if [ -n "$LSTART_8" ]; then
    pass "LSTART was recorded after exec completion: $LSTART_8"
else
    fail "LSTART was empty in PID file after delayed exec start"
fi

comm_base=$(basename "$(printf '%s' "$COMM_8" | awk '{print $1}')")
case "$comm_base" in
    relay|relay.*)
        pass "COMMAND accurately records relay binary identity ($comm_base)"
        ;;
    *)
        fail "COMMAND recorded invalid pre-exec command: $COMM_8"
        ;;
esac

# Probe readyz
if curl -s -f "http://127.0.0.1:8194/readyz" >/dev/null 2>&1; then
    pass "readyz probe succeeded for delayed-exec instance"
else
    fail "readyz probe failed for delayed-exec instance"
fi

# Clean stop
RELAY_LOCAL_DATA_DIR="$TEST_DIR_8/.local" "$LOCAL_DEV_SH" stop >/dev/null 2>&1
if ! kill -0 "$PID_8" 2>/dev/null; then
    pass "Delayed-exec instance stopped cleanly"
else
    fail "Delayed-exec instance failed to stop"
fi
rm -rf "$TEST_DIR_8"

# Test 9: 延迟exec超时fail-closed与安全清理本轮child
echo "[Test 9] 延迟exec超时fail-closed与安全清理本轮child (Timeout fail-closed & child cleanup)"
TEST_DIR_9=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_9"' EXIT
mkdir -p "$TEST_DIR_9/.local"
chmod 700 "$TEST_DIR_9/.local"

cat > "$TEST_DIR_9/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=$ADMIN_TOK8
DEV_AUTH_HOST_TOKEN=$HOST_TOK8
LISTEN_ADDR=127.0.0.1:8195
SQLITE_PATH=$TEST_DIR_9/.local/relay.db
LOG_LEVEL=info
LOG_FORMAT=json
MAX_SEND_QUEUE_SIZE=2048
EOF
chmod 600 "$TEST_DIR_9/.local/dev.env"

# Unrelated process to guarantee no collateral termination
sleep 120 &
UNRELATED_PID_9=$!

set +e
out_timeout=$(LOCAL_DEV_DELAY_EXEC_SECS=3.0 LOCAL_DEV_EXEC_WAIT_LIMIT=3 RELAY_LOCAL_DATA_DIR="$TEST_DIR_9/.local" "$LOCAL_DEV_SH" start 2>&1)
rc_timeout=$?
set -e

if [ "$rc_timeout" -ne 0 ] && printf '%s\n' "$out_timeout" | grep -qi "timeout waiting"; then
    pass "Startup timed out and failed-closed as expected when exec was delayed beyond limit"
else
    fail "Startup unexpectedly succeeded or did not report timeout (rc=$rc_timeout, out=$out_timeout)"
fi

if [ ! -f "$TEST_DIR_9/.local/relay.pid" ]; then
    pass "No PID file was left behind after timeout"
else
    fail "PID file was improperly created despite exec timeout!"
fi

if kill -0 "$UNRELATED_PID_9" 2>/dev/null; then
    pass "Unrelated process was NOT harmed during startup timeout cleanup"
else
    fail "Unrelated process WAS KILLED during startup timeout cleanup!"
fi
kill -TERM "$UNRELATED_PID_9" 2>/dev/null || true
wait "$UNRELATED_PID_9" 2>/dev/null || true

# Verify no leaked relay process on port 8195
sleep 0.3
if curl -s "http://127.0.0.1:8195/readyz" >/dev/null 2>&1; then
    fail "A leaked relay process responded on port 8195 after timeout!"
else
    pass "No leaked processes on port 8195"
fi
rm -rf "$TEST_DIR_9"

# Test 10: 连续重复 start -> smoke -> stop 稳定性验证
echo "[Test 10] 连续重复 start -> smoke -> stop 稳定性验证 (Repeated lifecycle stress test)"
TEST_DIR_10=$(mktemp -d)
trap 'rm -rf "$TEST_DIR_10"' EXIT
mkdir -p "$TEST_DIR_10/.local"
chmod 700 "$TEST_DIR_10/.local"

ADMIN_TOK10=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")
HOST_TOK10=$(head -c 32 /dev/urandom | base64 | tr "+/" "-_" | tr -d "\n\r=")

cat > "$TEST_DIR_10/.local/dev.env" <<EOF
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=$ADMIN_TOK10
DEV_AUTH_HOST_TOKEN=$HOST_TOK10
LISTEN_ADDR=127.0.0.1:8196
SQLITE_PATH=$TEST_DIR_10/.local/relay.db
LOG_LEVEL=info
LOG_FORMAT=json
MAX_SEND_QUEUE_SIZE=2048
SMOKE_EVENTS=5
ALLOW_LOOPBACK_WS=true
EOF
chmod 600 "$TEST_DIR_10/.local/dev.env"

repeat_ok=1
for iter in 1 2 3; do
    # Start
    if ! RELAY_LOCAL_DATA_DIR="$TEST_DIR_10/.local" "$LOCAL_DEV_SH" start >/dev/null 2>&1; then
        repeat_ok=0
        fail "Repeated cycle $iter: start failed"
        break
    fi

    # Smoke
    if ! RELAY_LOCAL_DATA_DIR="$TEST_DIR_10/.local" "$LOCAL_DEV_SH" smoke >/dev/null 2>&1; then
        repeat_ok=0
        fail "Repeated cycle $iter: smoke failed"
        RELAY_LOCAL_DATA_DIR="$TEST_DIR_10/.local" "$LOCAL_DEV_SH" stop >/dev/null 2>&1 || true
        break
    fi

    # Stop
    if ! RELAY_LOCAL_DATA_DIR="$TEST_DIR_10/.local" "$LOCAL_DEV_SH" stop >/dev/null 2>&1; then
        repeat_ok=0
        fail "Repeated cycle $iter: stop failed"
        break
    fi
done

if [ "$repeat_ok" -eq 1 ]; then
    pass "3 consecutive repeated start -> smoke -> stop cycles passed with zero errors"
fi
rm -rf "$TEST_DIR_10"

trap - EXIT
echo "============================================================"
if [ "$FAILED" -eq 0 ]; then
    echo "=== ALL LOCAL DEV SECURITY & LIFECYCLE TESTS PASSED!     ==="
    echo "============================================================"
    exit 0
else
    echo "=== SOME TESTS FAILED                                    ==="
    echo "============================================================"
    exit 1
fi
