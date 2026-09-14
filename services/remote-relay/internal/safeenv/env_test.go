package safeenv

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAndValidateEnvFile_Permissions(t *testing.T) {
	tempDir := t.TempDir()

	validContent := "DEV_AUTH_MODE=true\nDEV_AUTH_HOST_ID=test_host\n"

	// 0600: valid
	p600 := filepath.Join(tempDir, "test_0600.env")
	if err := os.WriteFile(p600, []byte(validContent), 0600); err != nil {
		t.Fatal(err)
	}
	envMap, err := OpenAndValidateEnvFile(p600)
	if err != nil {
		t.Fatalf("expected 0600 file to be accepted, got: %v", err)
	}
	if envMap["DEV_AUTH_MODE"] != "true" || envMap["DEV_AUTH_HOST_ID"] != "test_host" {
		t.Fatalf("unexpected parsed map: %+v", envMap)
	}

	// 0400: valid
	p400 := filepath.Join(tempDir, "test_0400.env")
	if err := os.WriteFile(p400, []byte(validContent), 0400); err != nil {
		t.Fatal(err)
	}
	envMap400, err := OpenAndValidateEnvFile(p400)
	if err != nil {
		t.Fatalf("expected 0400 file to be accepted, got: %v", err)
	}
	if envMap400["DEV_AUTH_MODE"] != "true" {
		t.Fatalf("unexpected parsed map: %+v", envMap400)
	}

	// Invalid permissions: group/world readable or writable or executable
	invalidPerms := []os.FileMode{
		0644, // world-readable
		0666, // world-writable
		0640, // group-readable
		0660, // group-writable
		0700, // owner-executable
		0755, // group/world executable
		0777, // everything
		0604, // other-readable
		0602, // other-writable
		0620, // group-writable
	}

	for _, mode := range invalidPerms {
		p := filepath.Join(tempDir, fmt.Sprintf("invalid_%04o.env", mode))
		if err := os.WriteFile(p, []byte(validContent), mode); err != nil {
			t.Fatal(err)
		}
		// Ensure OS didn't mask permissions with umask
		_ = os.Chmod(p, mode)

		_, err := OpenAndValidateEnvFile(p)
		if err == nil {
			t.Fatalf("expected permissions %04o to be rejected, but it succeeded", mode)
		}
		if !strings.Contains(err.Error(), "invalid permissions") {
			t.Fatalf("expected error message to mention invalid permissions, got: %v", err)
		}
	}
}

func TestOpenAndValidateEnvFile_SymlinkRejected(t *testing.T) {
	tempDir := t.TempDir()

	realPath := filepath.Join(tempDir, "real.env")
	if err := os.WriteFile(realPath, []byte("DEV_AUTH_MODE=true\n"), 0600); err != nil {
		t.Fatal(err)
	}

	linkPath := filepath.Join(tempDir, "symlink.env")
	if err := os.Symlink(realPath, linkPath); err != nil {
		t.Fatal(err)
	}

	_, err := OpenAndValidateEnvFile(linkPath)
	if err == nil {
		t.Fatal("expected symlink env file to be rejected, but it succeeded")
	}
	if !strings.Contains(err.Error(), "symbolic link") && !strings.Contains(err.Error(), "too many levels of symbolic links") {
		t.Fatalf("expected symlink rejection error, got: %v", err)
	}
}

func TestOpenAndValidateEnvFile_NonRegularFileRejected(t *testing.T) {
	tempDir := t.TempDir()
	subDir := filepath.Join(tempDir, "some_dir.env")
	if err := os.Mkdir(subDir, 0700); err != nil {
		t.Fatal(err)
	}

	_, err := OpenAndValidateEnvFile(subDir)
	if err == nil {
		t.Fatal("expected directory path to be rejected, but it succeeded")
	}
	if !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("expected 'not a regular file' error, got: %v", err)
	}
}

func TestParseEnvData_NonExecutable(t *testing.T) {
	canaryFile := filepath.Join(t.TempDir(), "canary_pwned")

	maliciousInput := fmt.Sprintf(`
# Comment line
export DEV_AUTH_ADMIN_TOKEN="$(touch %s)"
DEV_AUTH_HOST_TOKEN='`+"`touch %s`"+`'
DEV_AUTH_HOST_ID=valid_host_id
LISTEN_ADDR=127.0.0.1:8080 > %s
UNAUTHORIZED_KEY=malicious_payload
`, canaryFile, canaryFile, canaryFile)

	parsed, err := ParseEnvData([]byte(maliciousInput), AllowedWhitelistKeys)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}

	// Verify canary was NEVER touched/created
	if _, statErr := os.Stat(canaryFile); statErr == nil {
		_ = os.Remove(canaryFile)
		t.Fatal("SECURITY VIOLATION: command substitution or redirection was executed during env parsing!")
	}

	// Verify literal values are preserved without execution
	expectedAdminToken := fmt.Sprintf("$(touch %s)", canaryFile)
	if parsed["DEV_AUTH_ADMIN_TOKEN"] != expectedAdminToken {
		t.Errorf("expected literal token string %q, got %q", expectedAdminToken, parsed["DEV_AUTH_ADMIN_TOKEN"])
	}

	expectedHostToken := fmt.Sprintf("`touch %s`", canaryFile)
	if parsed["DEV_AUTH_HOST_TOKEN"] != expectedHostToken {
		t.Errorf("expected literal host token %q, got %q", expectedHostToken, parsed["DEV_AUTH_HOST_TOKEN"])
	}

	if parsed["DEV_AUTH_HOST_ID"] != "valid_host_id" {
		t.Errorf("expected valid_host_id, got %q", parsed["DEV_AUTH_HOST_ID"])
	}

	// Whitelist rejection: UNAUTHORIZED_KEY must NOT be in parsed map
	if _, ok := parsed["UNAUTHORIZED_KEY"]; ok {
		t.Error("expected unauthorized key to be excluded by whitelist")
	}
}

func TestGenerateEnvFile_Success(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, "dev.env")
	dbPath := filepath.Join(tempDir, "relay.db")

	created, err := GenerateEnvFile(envPath, dbPath)
	if err != nil {
		t.Fatalf("expected GenerateEnvFile to succeed, got: %v", err)
	}
	if !created {
		t.Fatal("expected created=true for new file")
	}

	// Verify permissions strictly 0600
	fi, err := os.Stat(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Fatalf("expected 0600 permissions, got %04o", fi.Mode().Perm())
	}

	// Verify parsed content
	parsed, err := OpenAndValidateEnvFile(envPath)
	if err != nil {
		t.Fatalf("expected OpenAndValidateEnvFile to succeed on generated file: %v", err)
	}
	if parsed["DEV_AUTH_MODE"] != "true" {
		t.Errorf("expected DEV_AUTH_MODE=true, got %q", parsed["DEV_AUTH_MODE"])
	}
	if parsed["DEV_AUTH_HOST_ID"] != "host_dev" {
		t.Errorf("expected DEV_AUTH_HOST_ID=host_dev, got %q", parsed["DEV_AUTH_HOST_ID"])
	}
	if len(parsed["DEV_AUTH_ADMIN_TOKEN"]) < 40 {
		t.Errorf("admin token too short: %q", parsed["DEV_AUTH_ADMIN_TOKEN"])
	}
	if len(parsed["DEV_AUTH_HOST_TOKEN"]) < 40 {
		t.Errorf("host token too short: %q", parsed["DEV_AUTH_HOST_TOKEN"])
	}

	// Calling again on valid existing file should not recreate
	createdSecond, err := GenerateEnvFile(envPath, dbPath)
	if err != nil {
		t.Fatalf("expected second GenerateEnvFile call to succeed: %v", err)
	}
	if createdSecond {
		t.Fatal("expected created=false for existing valid file")
	}
}

func TestGenerateEnvFile_SymlinkRejection(t *testing.T) {
	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "target.env")
	if err := os.WriteFile(targetPath, []byte("DEV_AUTH_MODE=true\n"), 0600); err != nil {
		t.Fatal(err)
	}

	symlinkPath := filepath.Join(tempDir, "symlink.env")
	if err := os.Symlink(targetPath, symlinkPath); err != nil {
		t.Fatal(err)
	}

	_, err := GenerateEnvFile(symlinkPath, filepath.Join(tempDir, "relay.db"))
	if err == nil {
		t.Fatal("expected symlink path to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected 'symbolic link' in error message, got: %v", err)
	}

	// Dangling symlink rejection
	danglingPath := filepath.Join(tempDir, "dangling.env")
	if err := os.Symlink(filepath.Join(tempDir, "nonexistent.env"), danglingPath); err != nil {
		t.Fatal(err)
	}
	_, err = GenerateEnvFile(danglingPath, filepath.Join(tempDir, "relay.db"))
	if err == nil {
		t.Fatal("expected dangling symlink path to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected 'symbolic link' in error message, got: %v", err)
	}
}

func TestGenerateEnvFile_BadPermissions(t *testing.T) {
	tempDir := t.TempDir()
	badPath := filepath.Join(tempDir, "bad.env")
	if err := os.WriteFile(badPath, []byte("DEV_AUTH_MODE=true\n"), 0644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(badPath, 0644)

	_, err := GenerateEnvFile(badPath, filepath.Join(tempDir, "relay.db"))
	if err == nil {
		t.Fatal("expected 0644 file to fail validation in GenerateEnvFile, got nil error")
	}
	if !strings.Contains(err.Error(), "invalid permissions") {
		t.Fatalf("expected 'invalid permissions' in error message, got: %v", err)
	}
}

func TestOpenAndValidateEnvFile_Concurrent(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, "concurrent.env")
	_, err := GenerateEnvFile(envPath, filepath.Join(tempDir, "relay.db"))
	if err != nil {
		t.Fatal(err)
	}

	const workers = 20
	errCh := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() {
			parsed, err := OpenAndValidateEnvFile(envPath)
			if err != nil {
				errCh <- err
				return
			}
			if parsed["DEV_AUTH_MODE"] != "true" {
				errCh <- fmt.Errorf("unexpected value: %s", parsed["DEV_AUTH_MODE"])
				return
			}
			errCh <- nil
		}()
	}

	for i := 0; i < workers; i++ {
		if err := <-errCh; err != nil {
			t.Fatalf("worker failed: %v", err)
		}
	}
}
