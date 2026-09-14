package deploy

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
		"腾讯云安全组",
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
