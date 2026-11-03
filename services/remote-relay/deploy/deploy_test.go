package deploy

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDockerfileSecurityContract(t *testing.T) {
	dockerfile := readFile(t, filepath.Join("..", "Dockerfile"))
	if strings.Count(dockerfile, "FROM ") < 2 {
		t.Fatal("Dockerfile must use a multi-stage build")
	}
	for _, required := range []string{
		"CGO_ENABLED=0",
		"USER 10001:10001",
		"VOLUME [\"/data\"]",
		"EXPOSE 8080",
		"/readyz",
	} {
		if !strings.Contains(dockerfile, required) {
			t.Fatalf("Dockerfile missing %q", required)
		}
	}
	for _, forbidden := range []string{"DEV_AUTH_ADMIN_TOKEN=", "DEV_AUTH_HOST_TOKEN=", "WECHAT_APP_SECRET="} {
		if strings.Contains(dockerfile, forbidden) {
			t.Fatalf("Dockerfile must not bake secret %q", forbidden)
		}
	}
}

func TestComposeNetworkAndRuntimeContract(t *testing.T) {
	compose := readFile(t, "compose.yaml")
	relay := serviceBlock(t, compose, "relay", "caddy")
	caddy := serviceBlock(t, compose, "caddy", "")

	for _, required := range []string{
		"LISTEN_ADDR: \":8080\"",
		"SQLITE_PATH: \"/data/relay.db\"",
		"target: /data",
		"read_only: true",
		"user: \"10001:10001\"",
		"no-new-privileges:true",
		"stop_grace_period: 15s",
		"/readyz",
	} {
		if !strings.Contains(relay, required) {
			t.Fatalf("relay service missing %q", required)
		}
	}
	if strings.Contains(relay, "\n    ports:") {
		t.Fatal("relay service must not publish container port 8080")
	}
	if !strings.Contains(relay, "\n    expose:\n      - \"8080\"") {
		t.Fatal("relay service must expose 8080 only to the container network")
	}

	for _, required := range []string{
		"\"80:80/tcp\"",
		"\"443:443/tcp\"",
		"user: \"10000:10000\"",
		"NET_BIND_SERVICE",
		"net.ipv4.ip_unprivileged_port_start: \"0\"",
		"no-new-privileges:true",
	} {
		if !strings.Contains(caddy, required) {
			t.Fatalf("caddy service missing %q", required)
		}
	}
	if strings.Contains(caddy, "8080:8080") || strings.Contains(compose, "0.0.0.0:8080") {
		t.Fatal("compose must never publish Relay port 8080")
	}
	if strings.Contains(caddy, "DEV_AUTH_ADMIN_TOKEN") || strings.Contains(caddy, "DEV_AUTH_HOST_TOKEN") {
		t.Fatal("caddy service must not receive Relay authentication secrets")
	}
	if !strings.Contains(compose, "internal: true") {
		t.Fatal("compose must isolate the relay network")
	}
}

func TestCaddyAndExampleConfigContract(t *testing.T) {
	caddyfile := readFile(t, "Caddyfile")
	for _, required := range []string{
		"{$RELAY_DOMAIN}",
		"reverse_proxy relay:8080",
		"health_uri /readyz",
		"format filter",
		"wrap json",
		"request>headers>Authorization delete",
		"request>headers>X-Dev-Admin-Token delete",
		"request>headers>X-Dev-Host-Token delete",
	} {
		if !strings.Contains(caddyfile, required) {
			t.Fatalf("Caddyfile missing %q", required)
		}
	}

	example := readFile(t, "remote-relay.env.example")
	for _, required := range []string{
		"PUBLIC_BASE_URL=https://relay.invalid",
		"SQLITE_PATH=/data/relay.db",
		"TRUST_PROXY=false",
		"DEV_AUTH_MODE=true",
		"DEV_AUTH_ADMIN_TOKEN=REPLACE_ME",
		"DEV_AUTH_HOST_TOKEN=REPLACE_ME",
	} {
		if !strings.Contains(example, required) {
			t.Fatalf("example configuration missing %q", required)
		}
	}
}

func TestDeploymentRunbookCoverage(t *testing.T) {
	runbook := readFile(t, filepath.Join("..", "DEPLOYMENT.md"))
	for _, required := range []string{
		"DNS、备案与 TLS",
		"云侧安全组",
		"外部 TLS/WSS 验证",
		"重启与持久性",
		"升级",
		"回滚",
		"备份",
		"恢复演练",
		"秘密轮换",
		"日志与 SQLite 数据边界",
		"外部验证阻塞",
	} {
		if !strings.Contains(runbook, required) {
			t.Fatalf("deployment runbook missing section %q", required)
		}
	}

	// Verify DEPLOYMENT.md forbids bare compose config which leaks env secrets
	if strings.Contains(runbook, "compose.yaml config\n") {
		t.Fatal("DEPLOYMENT.md must not instruct bare 'compose config' that prints env secrets")
	}
	if !strings.Contains(runbook, "config --quiet") || !strings.Contains(runbook, "config --services") {
		t.Fatal("DEPLOYMENT.md must recommend config --quiet or --services")
	}

	// Verify DEPLOYMENT.md does not contain non-executable placeholder for SMOKE_PAYLOAD_SENTINEL
	if strings.Contains(runbook, "<本次 smoke 使用的值>") {
		t.Fatal("DEPLOYMENT.md must not contain non-executable placeholder '<本次 smoke 使用的值>'")
	}

	// Verify DEPLOYMENT.md does not run wss-smoke from repo root where go.mod is absent
	if strings.Contains(runbook, "go run ./services/remote-relay/cmd/wss-smoke") {
		t.Fatal("DEPLOYMENT.md must not run wss-smoke from repo root where go.mod is absent")
	}

	// Verify DEPLOYMENT.md instructs entering services/remote-relay directory and running ./cmd/wss-smoke
	if !strings.Contains(runbook, "cd services/remote-relay") {
		t.Fatal("DEPLOYMENT.md must instruct switching from the checkout root to services/remote-relay")
	}
	if !strings.Contains(runbook, "go run ./cmd/wss-smoke") {
		t.Fatal("DEPLOYMENT.md must instruct running 'go run ./cmd/wss-smoke'")
	}

	// Verify DEPLOYMENT.md specifies single SSH stdin verification without persisting sentinel on cloud disk
	for _, required := range []string{
		"sudo -n bash -s",
		"BatchMode=yes",
		"StrictHostKeyChecking=yes",
		"^[0-9a-fA-F]{32,64}$",
	} {
		if !strings.Contains(runbook, required) {
			t.Fatalf("DEPLOYMENT.md missing single SSH stdin pipeline requirement %q", required)
		}
	}

	// Verify DEPLOYMENT.md specifies known_hosts verification via ssh-keygen -F
	// and accurately documents that ssh-keygen -F only checks record presence in known_hosts,
	// rather than proving host key provenance or authenticity.
	if !strings.Contains(runbook, "ssh-keygen -F") {
		t.Fatal("DEPLOYMENT.md must instruct checking host key presence in known_hosts via ssh-keygen -F")
	}
	if !strings.Contains(runbook, "known_hosts") {
		t.Fatal("DEPLOYMENT.md must document known_hosts requirements")
	}

	// Verify DEPLOYMENT.md forbids local temporary sentinel files or file sourcing
	if strings.Contains(runbook, "LOCAL_SENTINEL_ENV") || strings.Contains(runbook, "LOCAL_SENTINEL=") {
		t.Fatal("DEPLOYMENT.md must not use temporary sentinel files or file sourcing")
	}
	if strings.Contains(runbook, ". \"$SMOKE_ENV_FILE\"") || strings.Contains(runbook, "source \"$SMOKE_ENV_FILE\"") {
		t.Fatal("DEPLOYMENT.md must not source $SMOKE_ENV_FILE")
	}
	if strings.Contains(runbook, ": \"${SMOKE_ENV_FILE:=") {
		t.Fatal("DEPLOYMENT.md must not load SMOKE_ENV_FILE")
	}
	if !strings.Contains(runbook, "禁止使用 SMOKE_ENV_FILE") {
		t.Fatal("DEPLOYMENT.md must explicitly forbid SMOKE_ENV_FILE")
	}
	if !strings.Contains(runbook, "-z \"${DEV_AUTH_ADMIN_TOKEN:-}\"") || !strings.Contains(runbook, "-z \"${DEV_AUTH_HOST_TOKEN:-}\"") {
		t.Fatal("DEPLOYMENT.md must validate DEV_AUTH_ADMIN_TOKEN and DEV_AUTH_HOST_TOKEN are non-empty")
	}

	// Verify DEPLOYMENT.md registers correct signal exit traps (130 on INT, 143 on TERM) and cleanup on EXIT
	for _, required := range []string{
		"trap cleanup_local_smoke EXIT",
		"trap cleanup_cloud_verify EXIT",
		"trap 'exit 130' INT",
		"trap 'exit 143' TERM",
	} {
		if !strings.Contains(runbook, required) {
			t.Fatalf("DEPLOYMENT.md missing trap requirement %q", required)
		}
	}

	// Verify DEPLOYMENT.md forbids buggy trap handlers that do not exit on INT/TERM
	if strings.Contains(runbook, "trap cleanup_local_smoke EXIT INT TERM") {
		t.Fatal("DEPLOYMENT.md must not use buggy 'trap cleanup_local_smoke EXIT INT TERM' which fails to exit on INT/TERM")
	}
	if strings.Contains(runbook, "trap cleanup_cloud_verify EXIT INT TERM") {
		t.Fatal("DEPLOYMENT.md must not use buggy 'trap cleanup_cloud_verify EXIT INT TERM' which fails to exit on INT/TERM")
	}

	// Verify DEPLOYMENT.md unsets all sensitive tokens and sentinel upon cleanup
	if !strings.Contains(runbook, "unset DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN SMOKE_ADMIN_TOKEN SMOKE_HOST_TOKEN SMOKE_PAYLOAD_SENTINEL") {
		t.Fatal("DEPLOYMENT.md must instruct unsetting sensitive tokens and sentinel upon cleanup")
	}

	// Verify cloud host execution specifies root identity via sudo bash and validates mode/owner
	if !strings.Contains(runbook, "validate_secure_file") {
		t.Fatal("DEPLOYMENT.md must validate file owner (UID 0) and mode (0600/0400)")
	}

	// Verify DEPLOYMENT.md strictly forbids sourcing or executing RELAY_ENV_FILE on remote host
	if strings.Contains(runbook, ". \"$RELAY_ENV_FILE\"") || strings.Contains(runbook, "source \"$RELAY_ENV_FILE\"") {
		t.Fatal("DEPLOYMENT.md must not source or execute $RELAY_ENV_FILE on remote host")
	}

	// Verify DEPLOYMENT.md safely encodes tokens on operator machine and delivers via single SSH stdin pipeline
	for _, required := range []string{
		"ENCODED_ADMIN_TOKEN",
		"ENCODED_HOST_TOKEN",
		"base64 -d",
	} {
		if !strings.Contains(runbook, required) {
			t.Fatalf("DEPLOYMENT.md missing encoded token delivery requirement %q", required)
		}
	}

	// Verify DEPLOYMENT.md forbids buggy same-host sudo bash snippet
	if strings.Contains(runbook, "sudo bash <<'EOF'") {
		t.Fatal("DEPLOYMENT.md must not contain buggy same-host 'sudo bash <<EOF'")
	}

	// Verify DEPLOYMENT.md forbids fixed /tmp/smoke-sentinel.env and argv token exposure
	if strings.Contains(runbook, "/tmp/smoke-sentinel.env") {
		t.Fatal("DEPLOYMENT.md must not use fixed /tmp/smoke-sentinel.env due to symlink race risks")
	}
	if strings.Contains(runbook, "bash -s \"$SMOKE_PAYLOAD_SENTINEL\"") || strings.Contains(runbook, "bash -s $SMOKE_PAYLOAD_SENTINEL") {
		t.Fatal("DEPLOYMENT.md must not pass sentinel in argv")
	}

	// Verify cloud provider terminology: references Baidu AI Cloud BCC and forbids mismatched Tencent CVM
	if strings.Contains(runbook, "腾讯云 CVM") || strings.Contains(runbook, "CVM/BCC") {
		t.Fatal("DEPLOYMENT.md must not use mismatched Tencent CVM terminology for current Baidu AI Cloud BCC target")
	}
	if !strings.Contains(runbook, "百度智能云 BCC") {
		t.Fatal("DEPLOYMENT.md must accurately reference Baidu AI Cloud BCC target")
	}
}

func TestDeploymentRunbookShellSnippetsSyntax(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not found on system, skipping snippet syntax validation")
	}

	runbook := readFile(t, filepath.Join("..", "DEPLOYMENT.md"))
	lines := strings.Split(runbook, "\n")

	inBlock := false
	blockLang := ""
	var currentBlock []string
	startLine := 0
	checkedCount := 0

	for idx, line := range lines {
		if strings.HasPrefix(line, "```") {
			if inBlock {
				inBlock = false
				if blockLang == "bash" {
					snippet := strings.Join(currentBlock, "\n")
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					cmd := exec.CommandContext(ctx, bashPath, "-n")
					cmd.Stdin = strings.NewReader(snippet)
					var stderr bytes.Buffer
					cmd.Stderr = &stderr
					if err := cmd.Run(); err != nil {
						cancel()
						t.Fatalf("bash syntax check failed for snippet at line %d:\n%s\nStderr: %s\nError: %v",
							startLine, snippet, stderr.String(), err)
					}
					cancel()
					checkedCount++
				}
				currentBlock = nil
			} else {
				inBlock = true
				blockLang = strings.TrimSpace(strings.TrimPrefix(line, "```"))
				startLine = idx + 1
				currentBlock = nil
			}
		} else if inBlock {
			currentBlock = append(currentBlock, line)
		}
	}

	if checkedCount == 0 {
		t.Fatal("expected at least one bash snippet to check, found none")
	}
}

func TestVerifyDataBoundaryScriptContract(t *testing.T) {
	script := readFile(t, "verify-data-boundary.sh")

	// Must pipe value into grep stdin (-f -) to prevent token leaks in process argv
	if !strings.Contains(script, "grep -aFq -f -") {
		t.Fatal("verify-data-boundary.sh must read search pattern from stdin to prevent argv leakage")
	}

	// Must cover SQLite WAL and SHM files
	for _, required := range []string{"${database_file}-wal", "${database_file}-shm"} {
		if !strings.Contains(script, required) {
			t.Fatalf("verify-data-boundary.sh missing coverage for %q", required)
		}
	}

	// Must trap EXIT for cleanup, and explicit signal traps for INT (130), TERM (143), HUP (129)
	for _, required := range []string{
		"trap cleanup EXIT",
		"trap 'exit 129' HUP",
		"trap 'exit 130' INT",
		"trap 'exit 143' TERM",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("verify-data-boundary.sh missing signal trap contract %q", required)
		}
	}

	// Must unset sensitive tokens in cleanup
	if !strings.Contains(script, "unset DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN SMOKE_PAYLOAD_SENTINEL") {
		t.Fatal("verify-data-boundary.sh must unset sensitive tokens upon cleanup")
	}
}

func TestVerifyDataBoundaryExecutionWithMockDocker(t *testing.T) {
	scriptPath, err := filepath.Abs("verify-data-boundary.sh")
	if err != nil {
		t.Fatal(err)
	}

	tempDir := t.TempDir()
	binDir := filepath.Join(tempDir, "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		t.Fatal(err)
	}

	mockDockerScript := `#!/bin/sh
if [ -n "${MOCK_DOCKER_SIGNAL_SELF:-}" ]; then
	kill -s "${MOCK_DOCKER_SIGNAL_SELF}" $PPID
	exit 0
fi
for arg in "$@"; do
	if [ "$arg" = "relay" ]; then
		if [ "${MOCK_DOCKER_RELAY_FAIL:-0}" = "1" ]; then
			echo "mock relay log error" >&2
			exit 1
		fi
		if [ -n "${MOCK_DOCKER_RELAY_LOGS_FILE:-}" ] && [ -f "$MOCK_DOCKER_RELAY_LOGS_FILE" ]; then
			cat "$MOCK_DOCKER_RELAY_LOGS_FILE"
		fi
		exit 0
	elif [ "$arg" = "caddy" ]; then
		if [ "${MOCK_DOCKER_CADDY_FAIL:-0}" = "1" ]; then
			echo "mock caddy log error" >&2
			exit 1
		fi
		if [ -n "${MOCK_DOCKER_CADDY_LOGS_FILE:-}" ] && [ -f "$MOCK_DOCKER_CADDY_LOGS_FILE" ]; then
			cat "$MOCK_DOCKER_CADDY_LOGS_FILE"
		fi
		exit 0
	fi
done
exit 0
`
	mockDockerPath := filepath.Join(binDir, "docker")
	if err := os.WriteFile(mockDockerPath, []byte(mockDockerScript), 0755); err != nil {
		t.Fatal(err)
	}

	adminToken := "ADMIN_TOKEN_12345678901234567890123456789012"
	hostToken := "HOST_TOKEN_123456789012345678901234567890123"
	sentinel := "SENTINEL_MARKER_9876543210987654321"

	envFile := filepath.Join(tempDir, "remote-relay.env")
	if err := os.WriteFile(envFile, []byte("PUBLIC_BASE_URL=https://relay.test\n"), 0600); err != nil {
		t.Fatal(err)
	}

	runScript := func(t *testing.T, dataDir string, relayLogs, caddyLogs string, relayFail, caddyFail bool) (int, string, string) {
		t.Helper()
		relayLogFile := filepath.Join(t.TempDir(), "relay.log")
		if err := os.WriteFile(relayLogFile, []byte(relayLogs), 0600); err != nil {
			t.Fatal(err)
		}
		caddyLogFile := filepath.Join(t.TempDir(), "caddy.log")
		if err := os.WriteFile(caddyLogFile, []byte(caddyLogs), 0600); err != nil {
			t.Fatal(err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		cmd := exec.CommandContext(ctx, "/bin/sh", scriptPath)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		pathEnv := binDir + string(filepath.ListSeparator) + os.Getenv("PATH")
		cmd.Env = []string{
			"PATH=" + pathEnv,
			"RELAY_ENV_FILE=" + envFile,
			"RELAY_DATA_DIR=" + dataDir,
			"DEV_AUTH_ADMIN_TOKEN=" + adminToken,
			"DEV_AUTH_HOST_TOKEN=" + hostToken,
			"SMOKE_PAYLOAD_SENTINEL=" + sentinel,
			"MOCK_DOCKER_RELAY_LOGS_FILE=" + relayLogFile,
			"MOCK_DOCKER_CADDY_LOGS_FILE=" + caddyLogFile,
		}
		if relayFail {
			cmd.Env = append(cmd.Env, "MOCK_DOCKER_RELAY_FAIL=1")
		}
		if caddyFail {
			cmd.Env = append(cmd.Env, "MOCK_DOCKER_CADDY_FAIL=1")
		}

		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				t.Fatalf("failed to run script: %v", err)
			}
		}
		return exitCode, stdout.String(), stderr.String()
	}

	runScriptWithSignal := func(t *testing.T, dataDir string, signalName string) (int, string, string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if signalName == "HUP" {
			sigChan := make(chan os.Signal, 1)
			signal.Notify(sigChan, syscall.SIGHUP)
			defer signal.Stop(sigChan)
		}

		cmd := exec.CommandContext(ctx, "/bin/sh", scriptPath)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		pathEnv := binDir + string(filepath.ListSeparator) + os.Getenv("PATH")
		cmd.Env = []string{
			"PATH=" + pathEnv,
			"RELAY_ENV_FILE=" + envFile,
			"RELAY_DATA_DIR=" + dataDir,
			"DEV_AUTH_ADMIN_TOKEN=" + adminToken,
			"DEV_AUTH_HOST_TOKEN=" + hostToken,
			"SMOKE_PAYLOAD_SENTINEL=" + sentinel,
			"MOCK_DOCKER_SIGNAL_SELF=" + signalName,
		}
		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				t.Fatalf("failed to run script: %v", err)
			}
		}
		return exitCode, stdout.String(), stderr.String()
	}

	t.Run("normal_scan_passes", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, false)
		if code != 0 {
			t.Fatalf("expected exit 0, got %d, stderr: %s", code, errStr)
		}
		if !strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("expected pass message, got: %s", out)
		}
	})

	t.Run("fail_closed_relay_log_collection", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", true, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when relay log collection fails, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass on relay log collection failure: %s", out)
		}
		if !strings.Contains(errStr, "Relay log collection failed") {
			t.Fatalf("expected error message for relay log collection failure, got: %s", errStr)
		}
	})

	t.Run("fail_closed_caddy_log_collection", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, true)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when caddy log collection fails, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass on caddy log collection failure: %s", out)
		}
		if !strings.Contains(errStr, "Caddy log collection failed") {
			t.Fatalf("expected error message for caddy log collection failure, got: %s", errStr)
		}
	})

	t.Run("fail_closed_missing_sqlite_db", func(t *testing.T) {
		dataDir := t.TempDir()
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when relay.db is missing, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when relay.db missing: %s", out)
		}
		if !strings.Contains(errStr, "Relay SQLite file is missing") {
			t.Fatalf("expected error message for missing database, got: %s", errStr)
		}
	})

	t.Run("detects_secret_in_relay_logs", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "request header: Bearer "+adminToken+"\n", "clean caddy logs\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when relay logs leak token, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when relay logs leak secret: %s", out)
		}
		if !strings.Contains(errStr, "Relay logs contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error, got: %s", errStr)
		}
	})

	t.Run("detects_secret_in_caddy_logs", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "request URI: /?token="+sentinel+"\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when caddy logs leak sentinel, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when caddy logs leak secret: %s", out)
		}
		if !strings.Contains(errStr, "Caddy logs contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error, got: %s", errStr)
		}
	})

	t.Run("detects_secret_in_sqlite_db", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("data row: "+hostToken), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when relay.db leaks token, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when db leaks secret: %s", out)
		}
		if !strings.Contains(errStr, "Relay SQLite (relay.db) contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error, got: %s", errStr)
		}
	})

	t.Run("detects_secret_in_sqlite_wal", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db-wal"), []byte("wal frame: "+sentinel), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when wal leaks sentinel, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when wal leaks secret: %s", out)
		}
		if !strings.Contains(errStr, "Relay SQLite (relay.db-wal) contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error, got: %s", errStr)
		}
	})

	t.Run("detects_secret_in_sqlite_shm", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db-shm"), []byte("shm header: "+adminToken), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, errStr := runScript(t, dataDir, "clean relay logs\n", "clean caddy logs\n", false, false)
		if code == 0 {
			t.Fatalf("expected non-zero exit code when shm leaks token, got 0")
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass when shm leaks secret: %s", out)
		}
		if !strings.Contains(errStr, "Relay SQLite (relay.db-shm) contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error, got: %s", errStr)
		}
	})

	t.Run("signal_int_exits_130_without_continuing", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, _ := runScriptWithSignal(t, dataDir, "INT")
		if code != 130 {
			t.Fatalf("expected exit code 130 on SIGINT, got %d", code)
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass after receiving SIGINT: %s", out)
		}
	})

	t.Run("signal_term_exits_143_without_continuing", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, _ := runScriptWithSignal(t, dataDir, "TERM")
		if code != 143 {
			t.Fatalf("expected exit code 143 on SIGTERM, got %d", code)
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass after receiving SIGTERM: %s", out)
		}
	})

	t.Run("signal_hup_exits_129_without_continuing", func(t *testing.T) {
		dataDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte("clean database"), 0600); err != nil {
			t.Fatal(err)
		}
		code, out, _ := runScriptWithSignal(t, dataDir, "HUP")
		if code != 129 {
			t.Fatalf("expected exit code 129 on SIGHUP, got %d", code)
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not report pass after receiving SIGHUP: %s", out)
		}
	})
}

func extractExternalVerificationSnippet(t *testing.T, runbook string) string {
	t.Helper()
	marker := "## 外部 TLS/WSS 验证"
	idx := strings.Index(runbook, marker)
	if idx < 0 {
		t.Fatalf("could not find %q section in runbook", marker)
	}
	section := runbook[idx+len(marker):]
	nextHeadingIdx := strings.Index(section, "\n## ")
	if nextHeadingIdx >= 0 {
		section = section[:nextHeadingIdx]
	}

	startFence := "```bash\n"
	startIdx := strings.Index(section, startFence)
	if startIdx < 0 {
		t.Fatalf("could not find bash code block in %q section", marker)
	}

	// Verify that there is exactly ONE bash code block in this section
	if strings.Count(section, startFence) != 1 {
		t.Fatalf("expected exactly one bash code block in %q section, found %d", marker, strings.Count(section, startFence))
	}

	codeStart := startIdx + len(startFence)
	endIdx := strings.Index(section[codeStart:], "\n```")
	if endIdx < 0 {
		t.Fatalf("could not find end of bash code block in %q section", marker)
	}

	return section[codeStart : codeStart+endIdx]
}

func extractRemoteVerificationHeredoc(t *testing.T, runbook string) string {
	t.Helper()
	pipelineScript := extractExternalVerificationSnippet(t, runbook)
	startMarker := "cat <<'EOF'\n"
	startIdx := strings.Index(pipelineScript, startMarker)
	if startIdx < 0 {
		t.Fatalf("could not find %q in external verification snippet", startMarker)
	}
	heredocStart := startIdx + len(startMarker)
	endMarker := "\nEOF"
	endIdx := strings.Index(pipelineScript[heredocStart:], endMarker)
	if endIdx < 0 {
		t.Fatalf("could not find end marker %q for remote verification heredoc", endMarker)
	}
	return pipelineScript[heredocStart : heredocStart+endIdx]
}

func TestSingleSSHPipelineExecutionAndFailureRegression(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not found on system, skipping single SSH pipeline regression")
	}

	runbook := readFile(t, filepath.Join("..", "DEPLOYMENT.md"))
	extractedScript := extractExternalVerificationSnippet(t, runbook)

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("failed to resolve repo root: %v", err)
	}

	tempDir := t.TempDir()
	binDir := filepath.Join(tempDir, "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Note: TestSingleSSHPipelineExecutionAndFailureRegression tests the operator machine's
	// verbatim execution flow extracted from DEPLOYMENT.md up to the SSH transport boundary.
	// It dynamically validates sentinel generation, strict in-memory regex validation, known_hosts check
	// via ssh-keygen, argv secret hygiene, secure stdin delivery, and signal/exit-code propagation.
	//
	// The remote execution heredoc itself (including safe token decoding, zero env file execution side-effects,
	// validate_secure_file enforcement, and verify invocation) is independently and dynamically verified in
	// TestRemoteVerificationScriptHeredocContract. The remote boundary verification logic (verify-data-boundary.sh,
	// Docker log inspection, SQLite WAL/SHM file checks, signal handling) is also dynamically verified with mock Docker
	// in TestVerifyDataBoundaryExecutionWithMockDocker.

	validHexSentinel := "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
	adminToken := "ADMIN_TOKEN_12345678901234567890123456789012"
	hostToken := "HOST_TOKEN_123456789012345678901234567890123"

	// Create mock ssh-keygen to test known_hosts check
	mockSSHKeygenScript := `#!/bin/sh
if [ -n "$MOCK_LOG_DIR" ]; then
	printf '%s\n' "$@" > "$MOCK_LOG_DIR/ssh_keygen_argv.log"
fi
for arg in "$@"; do
	if [ -n "$TEST_ADMIN_TOKEN" ] && case "$arg" in *"$TEST_ADMIN_TOKEN"*) exit 88;; esac; then :; fi
	if [ -n "$TEST_HOST_TOKEN" ] && case "$arg" in *"$TEST_HOST_TOKEN"*) exit 89;; esac; then :; fi
	if [ -n "$TEST_SENTINEL" ] && case "$arg" in *"$TEST_SENTINEL"*) exit 90;; esac; then :; fi
done
if [ "${MOCK_SSH_KEYGEN_FAIL:-0}" = "1" ]; then
	exit 1
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "ssh-keygen"), []byte(mockSSHKeygenScript), 0755); err != nil {
		t.Fatal(err)
	}

	// Create mock go
	mockGoScript := `#!/bin/sh
for arg in "$@"; do
	if [ -n "$TEST_ADMIN_TOKEN" ] && case "$arg" in *"$TEST_ADMIN_TOKEN"*) exit 91;; esac; then :; fi
	if [ -n "$TEST_HOST_TOKEN" ] && case "$arg" in *"$TEST_HOST_TOKEN"*) exit 92;; esac; then :; fi
	if [ -n "$TEST_SENTINEL" ] && case "$arg" in *"$TEST_SENTINEL"*) exit 93;; esac; then :; fi
done

if [ -n "$MOCK_LOG_DIR" ]; then
	printf '%s\n' "$@" > "$MOCK_LOG_DIR/go_argv.log"
fi

if [ -z "$DEV_AUTH_ADMIN_TOKEN" ] || [ -z "$SMOKE_PAYLOAD_SENTINEL" ]; then
	echo "mock go: missing DEV_AUTH_ADMIN_TOKEN or SMOKE_PAYLOAD_SENTINEL in env" >&2
	exit 94
fi

if [ "${MOCK_GO_FAIL:-0}" = "1" ]; then
	echo "mock go: wss-smoke failed" >&2
	exit 1
fi

if [ -n "${MOCK_GO_SIGNAL_LOCAL:-}" ]; then
	if [ "$MOCK_GO_SIGNAL_LOCAL" = "INT" ]; then
		# Model the Go child returning 130 after Ctrl+C. Noninteractive Bash started by
		# exec.Command may ignore a direct SIGINT sent only to its parent process.
		exit 130
	fi
	kill -s "${MOCK_GO_SIGNAL_LOCAL}" $PPID
	exit 0
fi

exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "go"), []byte(mockGoScript), 0755); err != nil {
		t.Fatal(err)
	}

	// Create mock ssh
	mockSSHScript := `#!/bin/sh
for arg in "$@"; do
	if [ -n "$TEST_ADMIN_TOKEN" ] && case "$arg" in *"$TEST_ADMIN_TOKEN"*) exit 95;; esac; then :; fi
	if [ -n "$TEST_HOST_TOKEN" ] && case "$arg" in *"$TEST_HOST_TOKEN"*) exit 96;; esac; then :; fi
	if [ -n "$TEST_SENTINEL" ] && case "$arg" in *"$TEST_SENTINEL"*) exit 97;; esac; then :; fi
done

if [ "${MOCK_SSH_FAIL:-0}" = "1" ]; then
	echo "mock ssh: connection refused or host unreachable" >&2
	exit 255
fi

if [ -n "${MOCK_SSH_SIGNAL_SELF:-}" ]; then
	kill -s "${MOCK_SSH_SIGNAL_SELF}" $PPID
	exit 0
fi

if [ -n "$MOCK_LOG_DIR" ]; then
	printf '%s\n' "$@" > "$MOCK_LOG_DIR/ssh_argv.log"
	cat > "$MOCK_LOG_DIR/ssh_stdin.log"
fi

remote_cmd=""
for arg in "$@"; do
	remote_cmd="$arg"
done

if [ -n "$MOCK_LOG_DIR" ] && [ -f "$MOCK_LOG_DIR/ssh_stdin.log" ]; then
	eval "$remote_cmd" < "$MOCK_LOG_DIR/ssh_stdin.log"
	exit $?
else
	eval "$remote_cmd"
	exit $?
fi
`
	if err := os.WriteFile(filepath.Join(binDir, "ssh"), []byte(mockSSHScript), 0755); err != nil {
		t.Fatal(err)
	}

	// Create mock sudo
	mockSudoScript := `#!/bin/sh
for arg in "$@"; do
	if [ -n "$TEST_ADMIN_TOKEN" ] && case "$arg" in *"$TEST_ADMIN_TOKEN"*) exit 98;; esac; then :; fi
	if [ -n "$TEST_HOST_TOKEN" ] && case "$arg" in *"$TEST_HOST_TOKEN"*) exit 99;; esac; then :; fi
	if [ -n "$TEST_SENTINEL" ] && case "$arg" in *"$TEST_SENTINEL"*) exit 100;; esac; then :; fi
done

if [ -n "$MOCK_LOG_DIR" ]; then
	printf '%s\n' "$@" > "$MOCK_LOG_DIR/sudo_argv.log"
fi

if [ "${MOCK_REMOTE_VERIFY_FAIL:-0}" = "1" ]; then
	echo "mock sudo: verify-data-boundary failed" >&2
	exit 1
fi

if [ -n "${MOCK_REMOTE_VERIFY_SIGNAL:-}" ]; then
	if [ "$MOCK_REMOTE_VERIFY_SIGNAL" = "INT" ]; then
		exit 130
	elif [ "$MOCK_REMOTE_VERIFY_SIGNAL" = "TERM" ]; then
		exit 143
	else
		exit 1
	fi
fi

stdin_content=""
if [ -n "$MOCK_LOG_DIR" ] && [ -f "$MOCK_LOG_DIR/ssh_stdin.log" ]; then
	stdin_content=$(cat "$MOCK_LOG_DIR/ssh_stdin.log")
else
	stdin_content=$(cat)
fi

case "$stdin_content" in
	*"export SMOKE_PAYLOAD_SENTINEL="*) ;;
	*) echo "mock sudo: missing SMOKE_PAYLOAD_SENTINEL in stdin" >&2; exit 101 ;;
esac

case "$stdin_content" in
	*"ENCODED_ADMIN_TOKEN="*) ;;
	*) echo "mock sudo: missing ENCODED_ADMIN_TOKEN in stdin" >&2; exit 104 ;;
esac

case "$stdin_content" in
	*"ENCODED_HOST_TOKEN="*) ;;
	*) echo "mock sudo: missing ENCODED_HOST_TOKEN in stdin" >&2; exit 105 ;;
esac

case "$stdin_content" in
	*'. "$RELAY_ENV_FILE"'*|*"source \"\$RELAY_ENV_FILE\""*)
		echo "mock sudo: forbidden sourcing of RELAY_ENV_FILE detected in stdin" >&2
		exit 106
		;;
esac

case "$stdin_content" in
	*"validate_secure_file"*) ;;
	*) echo "mock sudo: missing validate_secure_file in stdin" >&2; exit 102 ;;
esac

case "$stdin_content" in
	*"services/remote-relay/deploy/verify-data-boundary.sh"*) ;;
	*) echo "mock sudo: missing verify-data-boundary invocation in stdin" >&2; exit 103 ;;
esac

exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "sudo"), []byte(mockSudoScript), 0755); err != nil {
		t.Fatal(err)
	}

	runPipeline := func(t *testing.T, sentinelVal string, extraEnv []string) (int, string, string) {
		t.Helper()
		testRunDir := t.TempDir()
		logDir := filepath.Join(testRunDir, "logs")
		for _, variable := range extraEnv {
			if strings.HasPrefix(variable, "MOCK_LOG_DIR=") {
				logDir = strings.TrimPrefix(variable, "MOCK_LOG_DIR=")
			}
		}
		if err := os.MkdirAll(logDir, 0755); err != nil {
			t.Fatal(err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		cmd := exec.CommandContext(ctx, bashPath, "-c", extractedScript)
		cmd.Dir = repoRoot
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		pathEnv := binDir + string(filepath.ListSeparator) + os.Getenv("PATH")
		envMap := map[string]string{
			"PATH":                 pathEnv,
			"TMPDIR":               testRunDir,
			"DEV_AUTH_ADMIN_TOKEN": adminToken,
			"DEV_AUTH_HOST_TOKEN":  hostToken,
			"TEST_ADMIN_TOKEN":     adminToken,
			"TEST_HOST_TOKEN":      hostToken,
			"MOCK_LOG_DIR":         logDir,
		}
		if sentinelVal != "" {
			envMap["TEST_SENTINEL"] = sentinelVal
			envMap["SMOKE_PAYLOAD_SENTINEL"] = sentinelVal
		}
		for _, variable := range extraEnv {
			if strings.HasPrefix(variable, "MOCK_LOG_DIR=") {
				continue
			}
			parts := strings.SplitN(variable, "=", 2)
			if len(parts) == 2 {
				if parts[0] == "UNSET_KEY" {
					delete(envMap, parts[1])
				} else {
					envMap[parts[0]] = parts[1]
				}
			}
		}

		cmd.Env = make([]string, 0, len(envMap))
		for k, v := range envMap {
			cmd.Env = append(cmd.Env, k+"="+v)
		}

		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				t.Fatalf("failed to execute pipeline: %v", err)
			}
		}

		// Verify that no temporary sentinel files were created in TMPDIR
		entries, _ := os.ReadDir(testRunDir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "freebuddy-smoke.") {
				t.Fatalf("residue temporary sentinel file found in TMPDIR: %s", e.Name())
			}
		}

		return exitCode, stdout.String(), stderr.String()
	}

	t.Run("normal_pipeline_passes_and_cleans_up", func(t *testing.T) {
		code, _, errStr := runPipeline(t, validHexSentinel, nil)
		if code != 0 {
			t.Fatalf("expected exit code 0, got %d, stderr: %s", code, errStr)
		}
	})

	t.Run("default_sentinel_generation_passes_and_cleans_up", func(t *testing.T) {
		code, _, errStr := runPipeline(t, "", nil)
		if code != 0 {
			t.Fatalf("expected exit code 0, got %d, stderr: %s", code, errStr)
		}
	})

	t.Run("missing_required_admin_token_fails_closed_and_blocks_execution", func(t *testing.T) {
		logDir := filepath.Join(t.TempDir(), "logs")
		code, _, errStr := runPipeline(t, validHexSentinel, []string{
			"UNSET_KEY=DEV_AUTH_ADMIN_TOKEN",
			"MOCK_LOG_DIR=" + logDir,
		})
		if code != 1 {
			t.Fatalf("expected exit code 1 when DEV_AUTH_ADMIN_TOKEN is missing, got %d", code)
		}
		if !strings.Contains(errStr, "DEV_AUTH_ADMIN_TOKEN") {
			t.Fatalf("expected missing admin token error message, got: %s", errStr)
		}
		if _, err := os.Stat(filepath.Join(logDir, "go_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock go was invoked when admin token was missing")
		}
		if _, err := os.Stat(filepath.Join(logDir, "ssh_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock ssh was invoked when admin token was missing")
		}
	})

	t.Run("missing_required_host_token_fails_closed_and_blocks_execution", func(t *testing.T) {
		logDir := filepath.Join(t.TempDir(), "logs")
		code, _, errStr := runPipeline(t, validHexSentinel, []string{
			"UNSET_KEY=DEV_AUTH_HOST_TOKEN",
			"MOCK_LOG_DIR=" + logDir,
		})
		if code != 1 {
			t.Fatalf("expected exit code 1 when DEV_AUTH_HOST_TOKEN is missing, got %d", code)
		}
		if !strings.Contains(errStr, "DEV_AUTH_HOST_TOKEN") {
			t.Fatalf("expected missing host token error message, got: %s", errStr)
		}
		if _, err := os.Stat(filepath.Join(logDir, "go_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock go was invoked when host token was missing")
		}
		if _, err := os.Stat(filepath.Join(logDir, "ssh_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock ssh was invoked when host token was missing")
		}
	})

	t.Run("malicious_sentinel_env_file_has_no_execution_side_effects_and_blocks_calling_tools", func(t *testing.T) {
		sideEffectFile := filepath.Join(t.TempDir(), "side_effect_env_file.txt")
		maliciousEnvFile := filepath.Join(t.TempDir(), "malicious.env")
		maliciousContent := fmt.Sprintf("SMOKE_PAYLOAD_SENTINEL=$(touch %q)\nDEV_AUTH_ADMIN_TOKEN=%s\nDEV_AUTH_HOST_TOKEN=%s\n",
			sideEffectFile, adminToken, hostToken)
		if err := os.WriteFile(maliciousEnvFile, []byte(maliciousContent), 0600); err != nil {
			t.Fatal(err)
		}

		logDir := filepath.Join(t.TempDir(), "logs")
		code, _, errStr := runPipeline(t, "", []string{
			"SMOKE_ENV_FILE=" + maliciousEnvFile,
			"MOCK_LOG_DIR=" + logDir,
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 when SMOKE_ENV_FILE is passed, got %d", code)
		}
		if !strings.Contains(errStr, "禁止使用 SMOKE_ENV_FILE") {
			t.Fatalf("expected forbidden SMOKE_ENV_FILE error message, got: %s", errStr)
		}
		if _, err := os.Stat(sideEffectFile); !os.IsNotExist(err) {
			t.Fatalf("malicious command in env file was executed! side-effect file exists: %s", sideEffectFile)
		}
		if _, err := os.Stat(filepath.Join(logDir, "go_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock go was invoked when SMOKE_ENV_FILE was supplied")
		}
		if _, err := os.Stat(filepath.Join(logDir, "ssh_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock ssh was invoked when SMOKE_ENV_FILE was supplied")
		}
	})

	t.Run("malicious_sentinel_in_process_env_has_no_execution_side_effects_and_blocks_calling_tools", func(t *testing.T) {
		sideEffectFile := filepath.Join(t.TempDir(), "side_effect_process_env.txt")
		maliciousSentinel := fmt.Sprintf("$(touch %q)", sideEffectFile)

		logDir := filepath.Join(t.TempDir(), "logs")
		code, _, errStr := runPipeline(t, maliciousSentinel, []string{
			"MOCK_LOG_DIR=" + logDir,
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 for malicious sentinel in process env, got %d", code)
		}
		if !strings.Contains(errStr, "纯 Hex 字符串") {
			t.Fatalf("expected pure hex error message, got: %s", errStr)
		}
		if _, err := os.Stat(sideEffectFile); !os.IsNotExist(err) {
			t.Fatalf("malicious sentinel in process env was evaluated! side-effect file exists: %s", sideEffectFile)
		}
		if _, err := os.Stat(filepath.Join(logDir, "go_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock go was invoked on malicious process env sentinel")
		}
		if _, err := os.Stat(filepath.Join(logDir, "ssh_argv.log")); !os.IsNotExist(err) {
			t.Fatal("mock ssh was invoked on malicious process env sentinel")
		}
	})

	t.Run("known_hosts_missing_fails_closed", func(t *testing.T) {
		code, _, errStr := runPipeline(t, validHexSentinel, []string{"MOCK_SSH_KEYGEN_FAIL=1"})
		if code != 1 {
			t.Fatalf("expected exit code 1 when host key is missing from known_hosts, got %d", code)
		}
		if !strings.Contains(errStr, "known_hosts") {
			t.Fatalf("expected known_hosts error message, got: %s", errStr)
		}
	})

	t.Run("ssh_transmission_failure_fail_closed_and_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_SSH_FAIL=1"})
		if code != 255 {
			t.Fatalf("expected exit code 255 on ssh transmission failure, got %d", code)
		}
	})

	t.Run("remote_verify_interrupted_by_int_exits_130_and_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_REMOTE_VERIFY_SIGNAL=INT"})
		if code != 130 {
			t.Fatalf("expected exit code 130 on remote verify SIGINT, got %d", code)
		}
	})

	t.Run("remote_verify_interrupted_by_term_exits_143_and_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_REMOTE_VERIFY_SIGNAL=TERM"})
		if code != 143 {
			t.Fatalf("expected exit code 143 on remote verify SIGTERM, got %d", code)
		}
	})

	t.Run("remote_verify_failure_fail_closed_and_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_REMOTE_VERIFY_FAIL=1"})
		if code != 1 {
			t.Fatalf("expected exit code 1 on remote verify failure, got %d", code)
		}
	})

	t.Run("local_child_interrupt_exit_130_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_GO_SIGNAL_LOCAL=INT"})
		if code != 130 {
			t.Fatalf("expected exit code 130 on local SIGINT, got %d", code)
		}
	})

	t.Run("local_signal_term_interruption_exits_143_and_cleans_up", func(t *testing.T) {
		code, _, _ := runPipeline(t, validHexSentinel, []string{"MOCK_GO_SIGNAL_LOCAL=TERM"})
		if code != 143 {
			t.Fatalf("expected exit code 143 on local SIGTERM, got %d", code)
		}
	})

	t.Run("no_secret_residue_in_argv_and_secure_stdin_contract", func(t *testing.T) {
		logDir := filepath.Join(t.TempDir(), "inspect_logs")
		code, _, errStr := runPipeline(t, validHexSentinel, []string{"MOCK_LOG_DIR=" + logDir})
		if code != 0 {
			t.Fatalf("expected exit 0, got %d: %s", code, errStr)
		}

		for _, logName := range []string{"go_argv.log", "ssh_argv.log", "sudo_argv.log", "ssh_keygen_argv.log"} {
			logPath := filepath.Join(logDir, logName)
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatalf("failed to read %s: %v", logName, err)
			}
			content := string(data)
			if strings.Contains(content, validHexSentinel) {
				t.Fatalf("sensitive sentinel leaked in %s: %s", logName, content)
			}
			if strings.Contains(content, adminToken) || strings.Contains(content, hostToken) {
				t.Fatalf("sensitive tokens leaked in %s: %s", logName, content)
			}
		}

		// Sentinel and tokens must NEVER be passed as process arguments
		sshArgvBytes, err := os.ReadFile(filepath.Join(logDir, "ssh_argv.log"))
		if err != nil {
			t.Fatalf("failed to read mock ssh argv: %v", err)
		}
		sshArgvStr := string(sshArgvBytes)

		// Must use BatchMode, StrictHostKeyChecking, and non-interactive sudo
		for _, expectedArg := range []string{
			"-o\nBatchMode=yes",
			"-o\nStrictHostKeyChecking=yes",
			"ops@remote.example.com",
			"sudo -n bash -s",
		} {
			if !strings.Contains(sshArgvStr, expectedArg) {
				t.Fatalf("SSH argv missing expected argument %q in:\n%s", expectedArg, sshArgvStr)
			}
		}

		// ssh-keygen argv verification
		keygenArgvBytes, err := os.ReadFile(filepath.Join(logDir, "ssh_keygen_argv.log"))
		if err != nil {
			t.Fatalf("failed to read mock ssh-keygen argv: %v", err)
		}
		keygenArgvStr := string(keygenArgvBytes)
		if !strings.Contains(keygenArgvStr, "-F\nremote.example.com") {
			t.Fatalf("ssh-keygen argv missing expected arguments: %s", keygenArgvStr)
		}

		// Sudo argv verification
		sudoArgvBytes, err := os.ReadFile(filepath.Join(logDir, "sudo_argv.log"))
		if err != nil {
			t.Fatalf("failed to read mock sudo argv: %v", err)
		}
		sudoArgvStr := string(sudoArgvBytes)
		for _, expectedArg := range []string{"-n", "bash", "-s"} {
			if !strings.Contains(sudoArgvStr, expectedArg) {
				t.Fatalf("sudo argv missing expected argument %q in:\n%s", expectedArg, sudoArgvStr)
			}
		}

		// Sentinel and encoded tokens must be delivered securely via stdin
		stdinBytes, err := os.ReadFile(filepath.Join(logDir, "ssh_stdin.log"))
		if err != nil {
			t.Fatalf("failed to read mock ssh stdin: %v", err)
		}
		stdinStr := string(stdinBytes)
		if !strings.Contains(stdinStr, "export SMOKE_PAYLOAD_SENTINEL="+validHexSentinel) {
			t.Fatalf("expected sentinel delivered via stdin, got:\n%s", stdinStr)
		}
		if !strings.Contains(stdinStr, "ENCODED_ADMIN_TOKEN=") || !strings.Contains(stdinStr, "ENCODED_HOST_TOKEN=") {
			t.Fatalf("expected encoded tokens delivered via stdin, got:\n%s", stdinStr)
		}
		if strings.Contains(stdinStr, ". \"$RELAY_ENV_FILE\"") || strings.Contains(stdinStr, "source \"$RELAY_ENV_FILE\"") {
			t.Fatalf("remote heredoc delivered via stdin must not source RELAY_ENV_FILE:\n%s", stdinStr)
		}
	})

	t.Run("defense_against_injection_sentinel", func(t *testing.T) {
		for _, badSentinel := range []string{
			"bad_hex_chars_xyz_123456789012345678",
			"deadbeef; rm -rf /",
			"deadbeef && echo injected",
			"0123456789abcdef`whoami`",
			"short_hex",
			"0123456789abcdef\necho injected",
			"$(whoami)",
			"`id`",
		} {
			sideEffectDir := t.TempDir()
			sideEffectFile := filepath.Join(sideEffectDir, "side_effect.txt")
			testBadSentinel := badSentinel
			if strings.Contains(badSentinel, "echo injected") {
				testBadSentinel = strings.Replace(badSentinel, "echo injected", "touch "+sideEffectFile, 1)
			} else if strings.Contains(badSentinel, "rm -rf /") {
				testBadSentinel = strings.Replace(badSentinel, "rm -rf /", "touch "+sideEffectFile, 1)
			} else if strings.Contains(badSentinel, "whoami") {
				testBadSentinel = strings.Replace(badSentinel, "whoami", "touch "+sideEffectFile, 1)
			} else if strings.Contains(badSentinel, "id") {
				testBadSentinel = strings.Replace(badSentinel, "id", "touch "+sideEffectFile, 1)
			}

			logDir := filepath.Join(sideEffectDir, "logs")
			code, _, errStr := runPipeline(t, testBadSentinel, []string{"MOCK_LOG_DIR=" + logDir})
			if code == 0 {
				t.Fatalf("expected non-zero exit code for malicious/invalid sentinel %q, got 0", testBadSentinel)
			}
			if !strings.Contains(errStr, "纯 Hex 字符串") {
				t.Fatalf("expected pure hex error message for %q, got: %s", testBadSentinel, errStr)
			}
			if _, err := os.Stat(sideEffectFile); !os.IsNotExist(err) {
				t.Fatalf("injection payload was executed for sentinel %q! side-effect file exists: %s", testBadSentinel, sideEffectFile)
			}
			if _, err := os.Stat(filepath.Join(logDir, "go_argv.log")); !os.IsNotExist(err) {
				t.Fatalf("mock go was invoked for bad sentinel %q", testBadSentinel)
			}
			if _, err := os.Stat(filepath.Join(logDir, "ssh_argv.log")); !os.IsNotExist(err) {
				t.Fatalf("mock ssh was invoked for bad sentinel %q", testBadSentinel)
			}
		}
	})
}

type remoteRunOptions struct {
	sentinel            string
	encodedAdminToken   string
	encodedHostToken    string
	omitAdminToken      bool
	omitHostToken       bool
	envFile             string
	dataDir             string
	freebuddyDir        string
	statOwner           string
	statMode            string
	statFail            bool
	verifyFail          bool
	useRealVerifyScript bool
	customStdinPrefix   string
	skipEnvFileCreation bool
	dockerRelayFail     bool
	dockerCaddyFail     bool
	relayLogContent     string
	caddyLogContent     string
	sqliteDbContent     string
}

func TestRemoteVerificationScriptHeredocContract(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not found on system, skipping remote verification heredoc contract")
	}

	runbook := readFile(t, filepath.Join("..", "DEPLOYMENT.md"))
	extractedHeredoc := extractRemoteVerificationHeredoc(t, runbook)

	// Static contract: Ensure extracted heredoc strictly forbids sourcing or executing RELAY_ENV_FILE
	if strings.Contains(extractedHeredoc, ". \"$RELAY_ENV_FILE\"") || strings.Contains(extractedHeredoc, "source \"$RELAY_ENV_FILE\"") {
		t.Fatal("extracted remote heredoc must not source $RELAY_ENV_FILE")
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("failed to resolve repo root: %v", err)
	}

	runRemoteHeredoc := func(t *testing.T, opts remoteRunOptions) (int, string, string, string) {
		t.Helper()
		workDir := t.TempDir()
		binDir := filepath.Join(workDir, "bin")
		if err := os.MkdirAll(binDir, 0755); err != nil {
			t.Fatal(err)
		}

		mockStatScript := `#!/bin/sh
owner="${MOCK_STAT_OWNER:-0}"
mode="${MOCK_STAT_MODE:-600}"

format=""
target=""
while [ $# -gt 0 ]; do
	case "$1" in
		-c|-f)
			format="$2"
			shift 2
			;;
		*)
			target="$1"
			shift
			;;
	esac
done

if [ "${MOCK_STAT_FAIL:-0}" = "1" ]; then
	echo "mock stat failed" >&2
	exit 1
fi

case "$format" in
	*%u*)
		echo "$owner"
		exit 0
		;;
	*%a*|*%Lp*)
		echo "$mode"
		exit 0
		;;
	*)
		echo "mock stat: unknown format $format" >&2
		exit 1
		;;
esac
`
		if err := os.WriteFile(filepath.Join(binDir, "stat"), []byte(mockStatScript), 0755); err != nil {
			t.Fatal(err)
		}

		freebuddyDir := opts.freebuddyDir
		if freebuddyDir == "" {
			freebuddyDir = filepath.Join(workDir, "opt_freebuddy")
		}
		verifyScriptDir := filepath.Join(freebuddyDir, "services", "remote-relay", "deploy")
		if err := os.MkdirAll(verifyScriptDir, 0755); err != nil {
			t.Fatal(err)
		}

		logDir := filepath.Join(workDir, "logs")
		if err := os.MkdirAll(logDir, 0755); err != nil {
			t.Fatal(err)
		}

		if opts.useRealVerifyScript {
			// Copy real verify-data-boundary.sh and compose.yaml
			realVerifyScriptPath := filepath.Join(repoRoot, "services", "remote-relay", "deploy", "verify-data-boundary.sh")
			realComposePath := filepath.Join(repoRoot, "services", "remote-relay", "deploy", "compose.yaml")
			verifyBytes, err := os.ReadFile(realVerifyScriptPath)
			if err != nil {
				t.Fatalf("failed to read real verify script: %v", err)
			}
			composeBytes, err := os.ReadFile(realComposePath)
			if err != nil {
				t.Fatalf("failed to read real compose file: %v", err)
			}
			if err := os.WriteFile(filepath.Join(verifyScriptDir, "verify-data-boundary.sh"), verifyBytes, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(verifyScriptDir, "compose.yaml"), composeBytes, 0644); err != nil {
				t.Fatal(err)
			}

			// Mock docker for real verify script
			relayLogsFile := filepath.Join(workDir, "relay_mock.log")
			caddyLogsFile := filepath.Join(workDir, "caddy_mock.log")
			relayContent := opts.relayLogContent
			if relayContent == "" {
				relayContent = "clean relay logs\n"
			}
			caddyContent := opts.caddyLogContent
			if caddyContent == "" {
				caddyContent = "clean caddy logs\n"
			}
			if err := os.WriteFile(relayLogsFile, []byte(relayContent), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(caddyLogsFile, []byte(caddyContent), 0600); err != nil {
				t.Fatal(err)
			}

			mockDockerScript := `#!/bin/sh
for arg in "$@"; do
	if [ "$arg" = "relay" ]; then
		if [ "${MOCK_DOCKER_RELAY_FAIL:-0}" = "1" ]; then
			echo "mock docker: relay log error" >&2
			exit 1
		fi
		if [ -n "${MOCK_DOCKER_RELAY_LOGS_FILE:-}" ] && [ -f "$MOCK_DOCKER_RELAY_LOGS_FILE" ]; then
			cat "$MOCK_DOCKER_RELAY_LOGS_FILE"
		fi
		exit 0
	elif [ "$arg" = "caddy" ]; then
		if [ "${MOCK_DOCKER_CADDY_FAIL:-0}" = "1" ]; then
			echo "mock docker: caddy log error" >&2
			exit 1
		fi
		if [ -n "${MOCK_DOCKER_CADDY_LOGS_FILE:-}" ] && [ -f "$MOCK_DOCKER_CADDY_LOGS_FILE" ]; then
			cat "$MOCK_DOCKER_CADDY_LOGS_FILE"
		fi
		exit 0
	fi
done
exit 0
`
			if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(mockDockerScript), 0755); err != nil {
				t.Fatal(err)
			}
		} else {
			mockVerifyScript := `#!/bin/sh
if [ -n "$MOCK_VERIFY_LOG_DIR" ]; then
	{
		echo "ADMIN_TOKEN=$DEV_AUTH_ADMIN_TOKEN"
		echo "HOST_TOKEN=$DEV_AUTH_HOST_TOKEN"
		echo "SENTINEL=$SMOKE_PAYLOAD_SENTINEL"
		echo "ENV_FILE=$RELAY_ENV_FILE"
		echo "DATA_DIR=$RELAY_DATA_DIR"
	} > "$MOCK_VERIFY_LOG_DIR/verify_invoked.log"
fi
if [ "${MOCK_VERIFY_FAIL:-0}" = "1" ]; then
	echo "mock verify script failure" >&2
	exit 1
fi
echo "data-boundary verification passed"
exit 0
`
			if err := os.WriteFile(filepath.Join(verifyScriptDir, "verify-data-boundary.sh"), []byte(mockVerifyScript), 0755); err != nil {
				t.Fatal(err)
			}
		}

		dataDir := opts.dataDir
		if dataDir == "" {
			dataDir = filepath.Join(workDir, "data")
			if err := os.MkdirAll(dataDir, 0700); err != nil {
				t.Fatal(err)
			}
			dbContent := opts.sqliteDbContent
			if dbContent == "" {
				dbContent = "clean sqlite database"
			}
			if err := os.WriteFile(filepath.Join(dataDir, "relay.db"), []byte(dbContent), 0600); err != nil {
				t.Fatal(err)
			}
		}

		envFile := opts.envFile
		if envFile == "" && !opts.skipEnvFileCreation {
			envFile = filepath.Join(workDir, "remote-relay.env")
			if err := os.WriteFile(envFile, []byte("PUBLIC_BASE_URL=https://relay.test\n"), 0600); err != nil {
				t.Fatal(err)
			}
		}

		var stdinContent strings.Builder
		if opts.customStdinPrefix != "" {
			stdinContent.WriteString(opts.customStdinPrefix)
		} else {
			sentinel := opts.sentinel
			if sentinel == "" {
				sentinel = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
			}
			adminB64 := opts.encodedAdminToken
			if adminB64 == "" && !opts.omitAdminToken {
				adminB64 = base64.StdEncoding.EncodeToString([]byte("default_admin_token_12345678901234567890"))
			}
			hostB64 := opts.encodedHostToken
			if hostB64 == "" && !opts.omitHostToken {
				hostB64 = base64.StdEncoding.EncodeToString([]byte("default_host_token_12345678901234567890"))
			}

			stdinContent.WriteString(fmt.Sprintf("export SMOKE_PAYLOAD_SENTINEL=%s\n", sentinel))
			stdinContent.WriteString(fmt.Sprintf("ENCODED_ADMIN_TOKEN=%s\n", adminB64))
			stdinContent.WriteString(fmt.Sprintf("ENCODED_HOST_TOKEN=%s\n", hostB64))
		}
		stdinContent.WriteString(extractedHeredoc)
		stdinContent.WriteString("\n")

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		cmd := exec.CommandContext(ctx, bashPath, "-s")
		cmd.Stdin = strings.NewReader(stdinContent.String())
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		pathEnv := binDir + string(filepath.ListSeparator) + os.Getenv("PATH")
		envMap := map[string]string{
			"PATH":                        pathEnv,
			"FREEBUDDY_DIR":               freebuddyDir,
			"RELAY_DATA_DIR":              dataDir,
			"MOCK_VERIFY_LOG_DIR":         logDir,
			"MOCK_STAT_OWNER":             "0",
			"MOCK_STAT_MODE":              "600",
			"MOCK_DOCKER_RELAY_LOGS_FILE": filepath.Join(workDir, "relay_mock.log"),
			"MOCK_DOCKER_CADDY_LOGS_FILE": filepath.Join(workDir, "caddy_mock.log"),
		}
		if envFile != "" {
			envMap["RELAY_ENV_FILE"] = envFile
		}
		if opts.statOwner != "" {
			envMap["MOCK_STAT_OWNER"] = opts.statOwner
		}
		if opts.statMode != "" {
			envMap["MOCK_STAT_MODE"] = opts.statMode
		}
		if opts.statFail {
			envMap["MOCK_STAT_FAIL"] = "1"
		}
		if opts.verifyFail {
			envMap["MOCK_VERIFY_FAIL"] = "1"
		}
		if opts.dockerRelayFail {
			envMap["MOCK_DOCKER_RELAY_FAIL"] = "1"
		}
		if opts.dockerCaddyFail {
			envMap["MOCK_DOCKER_CADDY_FAIL"] = "1"
		}

		cmd.Env = make([]string, 0, len(envMap))
		for k, v := range envMap {
			cmd.Env = append(cmd.Env, k+"="+v)
		}

		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				t.Fatalf("failed to run heredoc: %v", err)
			}
		}

		return exitCode, stdout.String(), stderr.String(), logDir
	}

	t.Run("malicious_env_file_command_substitution_has_zero_side_effects", func(t *testing.T) {
		tempDir := t.TempDir()
		sideEffectAdmin := filepath.Join(tempDir, "side_effect_admin.txt")
		sideEffectHost := filepath.Join(tempDir, "side_effect_host.txt")
		sideEffectCmd := filepath.Join(tempDir, "side_effect_cmd.txt")

		maliciousEnv := filepath.Join(tempDir, "malicious.env")
		content := fmt.Sprintf("PUBLIC_BASE_URL=https://relay.test\nDEV_AUTH_ADMIN_TOKEN=$(touch %q)\nDEV_AUTH_HOST_TOKEN=$(touch %q)\nMALICIOUS_CMD=$(touch %q)\n",
			sideEffectAdmin, sideEffectHost, sideEffectCmd)
		if err := os.WriteFile(maliciousEnv, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}

		expectedAdmin := "operator_admin_token_safe_123"
		expectedHost := "operator_host_token_safe_456"
		code, out, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			envFile:           maliciousEnv,
			encodedAdminToken: base64.StdEncoding.EncodeToString([]byte(expectedAdmin)),
			encodedHostToken:  base64.StdEncoding.EncodeToString([]byte(expectedHost)),
		})

		if code != 0 {
			t.Fatalf("expected exit code 0, got %d, stderr: %s", code, errStr)
		}
		if !strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("expected verify pass message, got: %s", out)
		}

		// Verify zero execution side-effects
		for _, sideFile := range []string{sideEffectAdmin, sideEffectHost, sideEffectCmd} {
			if _, err := os.Stat(sideFile); !os.IsNotExist(err) {
				t.Fatalf("malicious command in RELAY_ENV_FILE was executed! file exists: %s", sideFile)
			}
		}

		// Verify that verify script received operator-injected tokens, NOT the malicious string from env file
		logData, err := os.ReadFile(filepath.Join(logDir, "verify_invoked.log"))
		if err != nil {
			t.Fatalf("failed to read verify log: %v", err)
		}
		logContent := string(logData)
		if !strings.Contains(logContent, "ADMIN_TOKEN="+expectedAdmin) {
			t.Fatalf("verify script did not receive operator admin token: %s", logContent)
		}
		if !strings.Contains(logContent, "HOST_TOKEN="+expectedHost) {
			t.Fatalf("verify script did not receive operator host token: %s", logContent)
		}
		if strings.Contains(logContent, sideEffectAdmin) || strings.Contains(logContent, sideEffectHost) {
			t.Fatalf("verify script received token from env file instead of stdin stream: %s", logContent)
		}
	})

	t.Run("success_data_flow_delivers_decoded_tokens_to_verify", func(t *testing.T) {
		expectedAdmin := "admin_token_0987654321_fedcba"
		expectedHost := "host_token_1234567890_abcdef"
		expectedSentinel := "0123456789abcdef0123456789abcdef"

		code, out, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			sentinel:          expectedSentinel,
			encodedAdminToken: base64.StdEncoding.EncodeToString([]byte(expectedAdmin)),
			encodedHostToken:  base64.StdEncoding.EncodeToString([]byte(expectedHost)),
		})

		if code != 0 {
			t.Fatalf("expected exit code 0, got %d, stderr: %s", code, errStr)
		}
		if !strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("expected pass message, got: %s", out)
		}

		logData, err := os.ReadFile(filepath.Join(logDir, "verify_invoked.log"))
		if err != nil {
			t.Fatalf("failed to read verify log: %v", err)
		}
		logContent := string(logData)
		if !strings.Contains(logContent, "ADMIN_TOKEN="+expectedAdmin) {
			t.Fatalf("missing expected admin token in verify log: %s", logContent)
		}
		if !strings.Contains(logContent, "HOST_TOKEN="+expectedHost) {
			t.Fatalf("missing expected host token in verify log: %s", logContent)
		}
		if !strings.Contains(logContent, "SENTINEL="+expectedSentinel) {
			t.Fatalf("missing expected sentinel in verify log: %s", logContent)
		}
	})

	t.Run("arbitrary_token_characters_cannot_break_shell_syntax", func(t *testing.T) {
		tempDir := t.TempDir()
		sideFile := filepath.Join(tempDir, "token_side_effect.txt")
		metaAdmin := fmt.Sprintf("token'with$quotes;rm -rf /;$(touch %q)\"and spaces\nnewline", sideFile)
		metaHost := "host`id`&>&<|;{}$PATH"

		code, out, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			encodedAdminToken: base64.StdEncoding.EncodeToString([]byte(metaAdmin)),
			encodedHostToken:  base64.StdEncoding.EncodeToString([]byte(metaHost)),
		})

		if code != 0 {
			t.Fatalf("expected exit code 0, got %d, stderr: %s", code, errStr)
		}
		if !strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("expected verify pass message, got: %s", out)
		}
		if _, err := os.Stat(sideFile); !os.IsNotExist(err) {
			t.Fatalf("token content broke shell syntax and executed command! %s", sideFile)
		}

		logData, err := os.ReadFile(filepath.Join(logDir, "verify_invoked.log"))
		if err != nil {
			t.Fatalf("failed to read verify log: %v", err)
		}
		logContent := string(logData)
		if !strings.Contains(logContent, "ADMIN_TOKEN="+metaAdmin) {
			t.Fatalf("token with meta-characters was corrupted: %s", logContent)
		}
		if !strings.Contains(logContent, "HOST_TOKEN="+metaHost) {
			t.Fatalf("host token with meta-characters was corrupted: %s", logContent)
		}
	})

	t.Run("missing_relay_env_file_fails_closed_and_blocks_verify", func(t *testing.T) {
		nonExistentFile := filepath.Join(t.TempDir(), "nonexistent.env")
		code, _, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			envFile: nonExistentFile,
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 for missing env file, got %d", code)
		}
		if !strings.Contains(errStr, "文件不存在") {
			t.Fatalf("expected missing file error, got: %s", errStr)
		}
		if _, err := os.Stat(filepath.Join(logDir, "verify_invoked.log")); !os.IsNotExist(err) {
			t.Fatal("verify script was invoked when env file was missing!")
		}
	})

	t.Run("non_root_file_owner_fails_closed_and_blocks_verify", func(t *testing.T) {
		code, _, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			statOwner: "1000",
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 for non-root file owner, got %d", code)
		}
		if !strings.Contains(errStr, "属主必须为 root (UID 0)") {
			t.Fatalf("expected root owner error, got: %s", errStr)
		}
		if _, err := os.Stat(filepath.Join(logDir, "verify_invoked.log")); !os.IsNotExist(err) {
			t.Fatal("verify script was invoked when file owner was not root!")
		}
	})

	t.Run("insecure_file_mode_fails_closed_and_blocks_verify", func(t *testing.T) {
		for _, badMode := range []string{"644", "777", "660", "700", "000"} {
			code, _, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
				statMode: badMode,
			})

			if code != 1 {
				t.Fatalf("expected exit code 1 for insecure mode %s, got %d", badMode, code)
			}
			if !strings.Contains(errStr, "权限必须为 0600 或 0400") {
				t.Fatalf("expected mode error for %s, got: %s", badMode, errStr)
			}
			if _, err := os.Stat(filepath.Join(logDir, "verify_invoked.log")); !os.IsNotExist(err) {
				t.Fatalf("verify script was invoked when file mode was %s!", badMode)
			}
		}
	})

	t.Run("missing_or_empty_encoded_token_fails_closed_and_blocks_verify", func(t *testing.T) {
		code, _, errStr, logDir := runRemoteHeredoc(t, remoteRunOptions{
			omitAdminToken: true,
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 for missing encoded admin token, got %d", code)
		}
		if !strings.Contains(errStr, "安全校验失败") {
			t.Fatalf("expected security error, got: %s", errStr)
		}
		if _, err := os.Stat(filepath.Join(logDir, "verify_invoked.log")); !os.IsNotExist(err) {
			t.Fatal("verify script was invoked when encoded admin token was missing!")
		}
	})

	t.Run("verify_script_failure_fail_closed", func(t *testing.T) {
		code, _, errStr, _ := runRemoteHeredoc(t, remoteRunOptions{
			verifyFail: true,
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 when verify fails, got %d", code)
		}
		if !strings.Contains(errStr, "mock verify script failure") {
			t.Fatalf("expected verify failure message in stderr, got: %s", errStr)
		}
	})

	t.Run("end_to_end_with_real_verify_data_boundary_script_passes_clean_state", func(t *testing.T) {
		code, out, errStr, _ := runRemoteHeredoc(t, remoteRunOptions{
			useRealVerifyScript: true,
		})

		if code != 0 {
			t.Fatalf("expected exit code 0 for real verify script on clean state, got %d, stderr: %s", code, errStr)
		}
		if !strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("expected pass message in stdout, got: %s", out)
		}
	})

	t.Run("end_to_end_with_real_verify_data_boundary_detects_token_leak_in_sqlite", func(t *testing.T) {
		leakedToken := "LEAKED_ADMIN_TOKEN_9999888877776666"
		code, out, errStr, _ := runRemoteHeredoc(t, remoteRunOptions{
			useRealVerifyScript: true,
			encodedAdminToken:   base64.StdEncoding.EncodeToString([]byte(leakedToken)),
			sqliteDbContent:     "sqlite header table record: " + leakedToken + " end",
		})

		if code != 1 {
			t.Fatalf("expected exit code 1 when sqlite db leaks token, got %d", code)
		}
		if strings.Contains(out, "data-boundary verification passed") {
			t.Fatalf("must not pass when database leaks token: %s", out)
		}
		if !strings.Contains(errStr, "Relay SQLite (relay.db) contains a sensitive marker") {
			t.Fatalf("expected sensitive marker error in stderr, got: %s", errStr)
		}
	})
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func serviceBlock(t *testing.T, compose, service, nextService string) string {
	t.Helper()
	startMarker := "  " + service + ":\n"
	start := strings.Index(compose, startMarker)
	if start < 0 {
		t.Fatalf("compose missing service %s", service)
	}
	block := compose[start+len(startMarker):]
	if nextService != "" {
		end := strings.Index(block, "  "+nextService+":\n")
		if end < 0 {
			t.Fatalf("compose missing service %s", nextService)
		}
		block = block[:end]
	} else if end := strings.Index(block, "\nnetworks:\n"); end >= 0 {
		block = block[:end]
	}
	return block
}
