package safeenv

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"syscall"
)

var (
	validKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

	// AllowedWhitelistKeys contains standard recognized configuration keys for Remote Relay
	AllowedWhitelistKeys = map[string]bool{
		"DEV_AUTH_MODE":            true,
		"DEV_AUTH_HOST_ID":         true,
		"DEV_AUTH_ADMIN_TOKEN":     true,
		"DEV_AUTH_HOST_TOKEN":      true,
		"DEV_ADMIN_TOKEN":          true,
		"DEV_HOST_TOKEN":           true,
		"DEV_HOST_ID":              true,
		"LISTEN_ADDR":              true,
		"SQLITE_PATH":              true,
		"LOG_LEVEL":                true,
		"LOG_FORMAT":               true,
		"MAX_FRAME_BYTES":          true,
		"MAX_SEND_QUEUE_SIZE":      true,
		"HEARTBEAT_INTERVAL":       true,
		"HEARTBEAT_TIMEOUT":        true,
		"HTTP_READ_HEADER_TIMEOUT": true,
		"HTTP_READ_TIMEOUT":        true,
		"HTTP_WRITE_TIMEOUT":       true,
		"HTTP_IDLE_TIMEOUT":        true,
		"SHUTDOWN_GRACE_PERIOD":    true,
		"PUBLIC_BASE_URL":          true,
		"RELAY_PUBLIC_BASE_URL":    true,
		"TRUST_PROXY":              true,
		"WECHAT_APP_ID":            true,
		"WECHAT_APP_SECRET":        true,
		"ADMIN_OPENID":             true,
		"TOKEN_HASH_PEPPER":        true,
		"RPC_TIMEOUT":              true,
		"PAIRING_TTL":              true,
		"TOKEN_TTL":                true,
		"REFRESH_TOKEN_TTL":        true,
		"CHALLENGE_TTL":            true,
		"SMOKE_PAYLOAD_SENTINEL":   true,
		"SMOKE_HOST_ID":            true,
		"SMOKE_ADMIN_TOKEN":        true,
		"SMOKE_HOST_TOKEN":         true,
		"SMOKE_EVENTS":             true,
		"ALLOW_LOOPBACK_WS":        true,
		"RELAY_LOCAL_DATA_DIR":     true,
		"RELAY_ENV_FILE":           true,
	}
)

// OpenAndValidateEnvFile securely opens an environment file, verifying:
// 1. Not a symlink (via Lstat and syscall.O_NOFOLLOW).
// 2. Regular file only (not a directory, device, fifo, or socket).
// 3. Owned strictly by the current user (UID match).
// 4. Permissions strictly 0400 or 0600 (group and world permissions forbidden).
// 5. Checks are verified on the opened file descriptor via fstat to prevent TOCTOU substitution.
// 6. Reads and parses variables without execution, evaluation, or command substitution.
func OpenAndValidateEnvFile(path string) (map[string]string, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("env file path must not be empty")
	}

	// 1. Pre-open check: reject symlinks via Lstat
	lstatInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("stat env file %s: %w", path, err)
	}
	if lstatInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("env file %s is a symbolic link; symbolic links are strictly rejected", path)
	}
	if !lstatInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("env file %s is not a regular file (mode: %s)", path, lstatInfo.Mode())
	}

	// 2. Open with O_NOFOLLOW to avoid race conditions/symlink swaps
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open env file %s (O_NOFOLLOW): %w", path, err)
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()

	// 3. fstat on the opened file descriptor to verify identity and permissions
	statInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("fstat env file %s: %w", path, err)
	}
	if !statInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("env file %s descriptor is not a regular file", path)
	}

	// Check permissions: strictly 0400 or 0600 (no group or world bits permitted)
	perm := statInfo.Mode().Perm()
	if perm&0077 != 0 || (perm != 0400 && perm != 0600) {
		return nil, fmt.Errorf("env file %s has invalid permissions %04o; must be strictly 0400 or 0600 (group and world permissions forbidden)", path, perm)
	}

	// Check ownership: must match current running process UID
	sys, ok := statInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, errors.New("unable to retrieve file descriptor stat_t sys information")
	}
	currentUID := os.Getuid()
	if sys.Uid != uint32(currentUID) {
		return nil, fmt.Errorf("env file %s is not owned by current user (file UID: %d, current UID: %d)", path, sys.Uid, currentUID)
	}

	// 4. Read contents (bounded to 64 KiB to prevent memory exhaustion)
	data, err := io.ReadAll(io.LimitReader(file, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("read env file %s: %w", path, err)
	}

	// 5. Parse in non-executable whitelist mode
	return ParseEnvData(data, AllowedWhitelistKeys)
}

// ParseEnvData parses environment variable declarations safely without execution or shell evaluation.
func ParseEnvData(data []byte, whitelist map[string]bool) (map[string]string, error) {
	result := make(map[string]string)
	scanner := bufio.NewScanner(bytes.NewReader(data))

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Strip carriage return if any
		line = strings.TrimRight(line, "\r")
		line = strings.TrimSpace(line)

		// Ignore empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Strip optional "export " prefix
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		if !validKeyPattern.MatchString(key) {
			continue
		}

		if whitelist != nil && !whitelist[key] {
			// Skip keys not present in whitelist
			continue
		}

		val := strings.TrimSpace(parts[1])
		// Strip surrounding single or double quotes without evaluating inner content
		if (strings.HasPrefix(val, `"`) && strings.HasSuffix(val, `"`)) ||
			(strings.HasPrefix(val, `'`) && strings.HasSuffix(val, `'`)) {
			if len(val) >= 2 {
				val = val[1 : len(val)-1]
			}
		}

		result[key] = val
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan env lines: %w", err)
	}

	return result, nil
}

// GenerateEnvFile creates a new dev.env file securely:
// 1. Checks path with os.Lstat; if symlink, strictly rejects.
// 2. If regular file exists, validates it with OpenAndValidateEnvFile and returns false, nil if valid.
// 3. If file does not exist, opens with syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW with 0600 mode.
// 4. Calls Chmod(0600) on the opened file descriptor to guarantee exact permissions.
// 5. Writes newly generated high-entropy dev tokens.
func GenerateEnvFile(path string, dbPath string) (bool, error) {
	if strings.TrimSpace(path) == "" {
		return false, errors.New("env file path must not be empty")
	}

	lstatInfo, err := os.Lstat(path)
	if err == nil {
		if lstatInfo.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("env file %s is a symbolic link; symbolic links are strictly rejected", path)
		}
		// File already exists; validate it
		if _, err := OpenAndValidateEnvFile(path); err != nil {
			return false, fmt.Errorf("existing env file %s is invalid: %w", path, err)
		}
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("lstat env file %s: %w", path, err)
	}

	// File does not exist: create atomically with O_EXCL|O_NOFOLLOW
	fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return false, fmt.Errorf("create env file %s (O_NOFOLLOW): %w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()

	if err := f.Chmod(0600); err != nil {
		return false, fmt.Errorf("chmod env file %s: %w", path, err)
	}

	adminBytes := make([]byte, 32)
	if _, err := rand.Read(adminBytes); err != nil {
		return false, fmt.Errorf("generate admin token: %w", err)
	}
	adminToken := base64.RawURLEncoding.EncodeToString(adminBytes)

	hostBytes := make([]byte, 32)
	if _, err := rand.Read(hostBytes); err != nil {
		return false, fmt.Errorf("generate host token: %w", err)
	}
	hostToken := base64.RawURLEncoding.EncodeToString(hostBytes)

	content := fmt.Sprintf(`# FreeBuddy Remote Relay Local Development Environment
DEV_AUTH_MODE=true
DEV_AUTH_HOST_ID=host_dev
DEV_AUTH_ADMIN_TOKEN=%s
DEV_AUTH_HOST_TOKEN=%s
LISTEN_ADDR=127.0.0.1:8080
SQLITE_PATH=%s
LOG_LEVEL=info
LOG_FORMAT=json
MAX_SEND_QUEUE_SIZE=2048
`, adminToken, hostToken, dbPath)

	if _, err := f.WriteString(content); err != nil {
		return false, fmt.Errorf("write env file %s: %w", path, err)
	}

	return true, nil
}
