package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.ListenAddr != ":8080" {
		t.Errorf("expected ListenAddr :8080, got %s", cfg.ListenAddr)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected LogLevel info, got %s", cfg.LogLevel)
	}
	if cfg.MaxFrameBytes != MaxAllowedFrameBytes {
		t.Errorf("expected MaxFrameBytes %d, got %d", MaxAllowedFrameBytes, cfg.MaxFrameBytes)
	}
	if cfg.HeartbeatInterval != 30*time.Second {
		t.Errorf("expected HeartbeatInterval 30s, got %v", cfg.HeartbeatInterval)
	}
	if cfg.HeartbeatTimeout != 10*time.Second {
		t.Errorf("expected HeartbeatTimeout 10s, got %v", cfg.HeartbeatTimeout)
	}
}

func TestValidate_DevMode(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = true
	cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-entropy-32"
	cfg.DevAuthHostToken = "dev-host-token-with-sufficient-entropy-32"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid config in dev mode, got: %v", err)
	}
}

func TestValidate_DevMode_MissingOrWeakTokens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = true

	// Missing tokens
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "DEV_AUTH_ADMIN_TOKEN") {
		t.Fatalf("expected error for missing DEV_AUTH_ADMIN_TOKEN, got: %v", err)
	}

	// 16 chars (less than 32 chars)
	cfg.DevAuthAdminToken = "1234567890123456"
	cfg.DevAuthHostToken = "1234567890123456"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must be at least 32 characters long") {
		t.Fatalf("expected error for short dev tokens (<32), got: %v", err)
	}

	// 31 chars
	cfg.DevAuthAdminToken = "1234567890123456789012345678901"
	cfg.DevAuthHostToken = "1234567890123456789012345678901"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must be at least 32 characters long") {
		t.Fatalf("expected error for 31-char dev tokens, got: %v", err)
	}

	// Invalid characters (not in OpaqueToken charset)
	cfg.DevAuthAdminToken = "token_with_invalid_char_@#$%_1234567890"
	cfg.DevAuthHostToken = "token_with_invalid_char_@#$%_1234567890"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must match OpaqueToken character set") {
		t.Fatalf("expected error for invalid characters in dev tokens, got: %v", err)
	}

	// Low entropy / uniform characters (32 identical chars)
	cfg.DevAuthAdminToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cfg.DevAuthHostToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "insufficient entropy") {
		t.Fatalf("expected error for weak uniform dev tokens, got: %v", err)
	}

	// Repetitive short sequence pattern
	cfg.DevAuthAdminToken = "12345678123456781234567812345678"
	cfg.DevAuthHostToken = "12345678123456781234567812345678"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "insufficient entropy") {
		t.Fatalf("expected error for repetitive pattern dev tokens, got: %v", err)
	}

	// Over 512 characters
	longToken := strings.Repeat("a1b2c3d4-e5f6-g7h8-i9j0.", 25) // 600 chars
	cfg.DevAuthAdminToken = longToken
	cfg.DevAuthHostToken = longToken
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must not exceed 512 characters") {
		t.Fatalf("expected error for dev token exceeding 512 characters, got: %v", err)
	}
}

func TestValidate_ProductionMode_DevTokensRejected(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = false
	cfg.WeChatAppID = "wx123456"
	cfg.WeChatAppSecret = "secret1234567890"
	cfg.AdminOpenID = "openid_admin"
	cfg.TokenHashPepper = "super-secret-pepper-with-sufficient-entropy-12345"
	cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-entropy-32"

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must not be set when DEV_AUTH_MODE is false") {
		t.Fatalf("expected error when dev tokens are set in production mode, got: %v", err)
	}
}

func TestValidate_ProductionMode_MissingSecrets(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = false

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected validation error in production mode with missing secrets")
	}

	errStr := err.Error()
	if !strings.Contains(errStr, "WECHAT_APP_ID is required") {
		t.Errorf("missing WECHAT_APP_ID error check: %s", errStr)
	}
	if !strings.Contains(errStr, "WECHAT_APP_SECRET is required") {
		t.Errorf("missing WECHAT_APP_SECRET error check: %s", errStr)
	}
	if !strings.Contains(errStr, "ADMIN_OPENID is required") {
		t.Errorf("missing ADMIN_OPENID error check: %s", errStr)
	}
	if !strings.Contains(errStr, "TOKEN_HASH_PEPPER is required") {
		t.Errorf("missing TOKEN_HASH_PEPPER error check: %s", errStr)
	}
}

func TestValidate_ProductionMode_WeakPepper(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = false
	cfg.WeChatAppID = "wx123456"
	cfg.WeChatAppSecret = "secret123"
	cfg.AdminOpenID = "openid_admin"
	cfg.TokenHashPepper = "short"

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must be at least 16 characters") {
		t.Fatalf("expected error for weak pepper, got: %v", err)
	}

	cfg.TokenHashPepper = "super-secret-pepper-with-sufficient-entropy-12345"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid prod config, got: %v", err)
	}
}

func TestValidate_ValidPublicBaseURL(t *testing.T) {
	validURLs := []string{
		"https://remote.example.com",
		"https://remote.example.com/",
		"http://localhost:8080",
		"http://127.0.0.1:8080",
	}

	for _, u := range validURLs {
		cfg := DefaultConfig()
		cfg.DevAuthMode = true
		cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-entropy-32"
		cfg.DevAuthHostToken = "dev-host-token-with-sufficient-entropy-32"
		cfg.PublicBaseURL = u
		if err := cfg.Validate(); err != nil {
			t.Errorf("expected valid for PublicBaseURL %q, got: %v", u, err)
		}
	}
}

func TestValidate_InvalidFields(t *testing.T) {
	tests := []struct {
		name      string
		modify    func(c *Config)
		expectErr string
	}{
		{
			name: "empty listen addr",
			modify: func(c *Config) {
				c.ListenAddr = ""
			},
			expectErr: "LISTEN_ADDR must not be empty",
		},
		{
			name: "invalid listen addr",
			modify: func(c *Config) {
				c.ListenAddr = "invalid:address:format:123"
			},
			expectErr: "LISTEN_ADDR is invalid",
		},
		{
			name: "invalid public base url scheme",
			modify: func(c *Config) {
				c.PublicBaseURL = "ftp://invalid-scheme"
			},
			expectErr: "PUBLIC_BASE_URL must be a valid absolute HTTP or HTTPS URL",
		},
		{
			name: "public base url with userinfo credentials",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://user:token123@remote.example.com"
			},
			expectErr: "PUBLIC_BASE_URL must not contain userinfo",
		},
		{
			name: "public base url with userinfo username only",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://token123@remote.example.com"
			},
			expectErr: "PUBLIC_BASE_URL must not contain userinfo",
		},
		{
			name: "public base url with path",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com/v1/auth"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a path",
		},
		{
			name: "public base url with secret token path",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com/secret-token-value"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a path",
		},
		{
			name: "public base url with query string",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com?token=secret123"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a query string",
		},
		{
			name: "public base url with empty query mark",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com/?"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a query string",
		},
		{
			name: "public base url with fragment",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com#token=secret123"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a fragment",
		},
		{
			name: "public base url with empty fragment mark",
			modify: func(c *Config) {
				c.PublicBaseURL = "https://remote.example.com/#"
			},
			expectErr: "PUBLIC_BASE_URL must not contain a fragment",
		},
		{
			name: "empty sqlite path",
			modify: func(c *Config) {
				c.SQLitePath = ""
			},
			expectErr: "SQLITE_PATH must not be empty",
		},
		{
			name: "invalid log level",
			modify: func(c *Config) {
				c.LogLevel = "verbose"
			},
			expectErr: "LOG_LEVEL \"verbose\" is invalid",
		},
		{
			name: "invalid log format",
			modify: func(c *Config) {
				c.LogFormat = "yaml"
			},
			expectErr: "LOG_FORMAT \"yaml\" is invalid",
		},
		{
			name: "zero or negative timeout",
			modify: func(c *Config) {
				c.HTTPReadTimeout = -1 * time.Second
			},
			expectErr: "HTTP_READ_TIMEOUT must be positive",
		},
		{
			name: "zero max frame bytes",
			modify: func(c *Config) {
				c.MaxFrameBytes = 0
			},
			expectErr: "MAX_FRAME_BYTES must be positive",
		},
		{
			name: "negative max frame bytes",
			modify: func(c *Config) {
				c.MaxFrameBytes = -1
			},
			expectErr: "MAX_FRAME_BYTES must be positive",
		},
		{
			name: "max frame bytes exceeds protocol limit 262144",
			modify: func(c *Config) {
				c.MaxFrameBytes = 262145
			},
			expectErr: "MAX_FRAME_BYTES must not exceed protocol limit of 262144 bytes",
		},
		{
			name: "max frame bytes double protocol limit",
			modify: func(c *Config) {
				c.MaxFrameBytes = 524288
			},
			expectErr: "MAX_FRAME_BYTES must not exceed protocol limit of 262144 bytes",
		},
		{
			name: "rpc timeout too small",
			modify: func(c *Config) {
				c.RPCTimeout = 500 * time.Millisecond
			},
			expectErr: "RPC_TIMEOUT must be between 1s and 120s",
		},
		{
			name: "rpc timeout too large",
			modify: func(c *Config) {
				c.RPCTimeout = 150 * time.Second
			},
			expectErr: "RPC_TIMEOUT must be between 1s and 120s",
		},
		{
			name: "challenge ttl too small",
			modify: func(c *Config) {
				c.ChallengeTTL = 500 * time.Millisecond
			},
			expectErr: "CHALLENGE_TTL must be between 1s and 300s",
		},
		{
			name: "challenge ttl too large",
			modify: func(c *Config) {
				c.ChallengeTTL = 350 * time.Second
			},
			expectErr: "CHALLENGE_TTL must be between 1s and 300s",
		},
		{
			name: "heartbeat interval too small",
			modify: func(c *Config) {
				c.HeartbeatInterval = 2 * time.Second
			},
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name: "heartbeat interval too large",
			modify: func(c *Config) {
				c.HeartbeatInterval = 150 * time.Second
			},
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name: "empty dev host id",
			modify: func(c *Config) {
				c.DevAuthHostID = ""
			},
			expectErr: "DEV_AUTH_HOST_ID must not be empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.DevAuthMode = true
			cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-entropy-32"
			cfg.DevAuthHostToken = "dev-host-token-with-sufficient-entropy-32"
			tt.modify(&cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.expectErr)
			}
			if !strings.Contains(err.Error(), tt.expectErr) {
				t.Fatalf("expected error containing %q, got %q", tt.expectErr, err.Error())
			}
		})
	}
}

func TestLoadFromEnv(t *testing.T) {
	t.Setenv("LISTEN_ADDR", ":9090")
	t.Setenv("DEV_AUTH_MODE", "true")
	t.Setenv("DEV_ADMIN_TOKEN", "dev-admin-token-with-sufficient-entropy-32")
	t.Setenv("DEV_HOST_TOKEN", "dev-host-token-with-sufficient-entropy-32")
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("MAX_FRAME_BYTES", "131072")
	t.Setenv("RPC_TIMEOUT", "45s")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("unexpected error loading from env: %v", err)
	}

	if cfg.ListenAddr != ":9090" {
		t.Errorf("expected ListenAddr :9090, got %s", cfg.ListenAddr)
	}
	if !cfg.DevAuthMode {
		t.Errorf("expected DevAuthMode true")
	}
	if cfg.DevAuthAdminToken != "dev-admin-token-with-sufficient-entropy-32" {
		t.Errorf("expected DevAuthAdminToken loaded")
	}
	if cfg.DevAuthHostToken != "dev-host-token-with-sufficient-entropy-32" {
		t.Errorf("expected DevAuthHostToken loaded")
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("expected LogLevel debug, got %s", cfg.LogLevel)
	}
	if cfg.MaxFrameBytes != 131072 {
		t.Errorf("expected MaxFrameBytes 131072, got %d", cfg.MaxFrameBytes)
	}
	if cfg.RPCTimeout != 45*time.Second {
		t.Errorf("expected RPCTimeout 45s, got %v", cfg.RPCTimeout)
	}
}

func TestLoadFromEnv_ExceedsMaxFrameBytes(t *testing.T) {
	t.Setenv("DEV_AUTH_MODE", "true")
	t.Setenv("DEV_AUTH_ADMIN_TOKEN", "dev-admin-token-with-sufficient-entropy-32")
	t.Setenv("DEV_AUTH_HOST_TOKEN", "dev-host-token-with-sufficient-entropy-32")
	t.Setenv("MAX_FRAME_BYTES", "524288")

	_, err := LoadFromEnv()
	if err == nil {
		t.Fatal("expected error loading config with MAX_FRAME_BYTES > 262144, got nil")
	}
	if !strings.Contains(err.Error(), "MAX_FRAME_BYTES must not exceed protocol limit") {
		t.Errorf("expected protocol limit error, got: %v", err)
	}
}

func TestLoadFromEnv_InvalidPublicBaseURL_CarryingToken(t *testing.T) {
	t.Setenv("DEV_AUTH_MODE", "true")
	t.Setenv("DEV_AUTH_ADMIN_TOKEN", "dev-admin-token-with-sufficient-entropy-32")
	t.Setenv("DEV_AUTH_HOST_TOKEN", "dev-host-token-with-sufficient-entropy-32")
	t.Setenv("PUBLIC_BASE_URL", "https://token123:secret456@remote.example.com")

	_, err := LoadFromEnv()
	if err == nil {
		t.Fatal("expected error loading config with userinfo in PUBLIC_BASE_URL, got nil")
	}
	if !strings.Contains(err.Error(), "PUBLIC_BASE_URL must not contain userinfo") {
		t.Errorf("expected userinfo error, got: %v", err)
	}
}

func TestRedactedString_NoSecretsLeaked(t *testing.T) {
	cfg := DefaultConfig()
	cfg.PublicBaseURL = "https://remote.example.com"
	cfg.WeChatAppSecret = "super-secret-appsecret-12345"
	cfg.AdminOpenID = "admin_openid_secret_999"
	cfg.TokenHashPepper = "pepper_secret_12345"
	cfg.DevAuthAdminToken = "dev_admin_secret_token"
	cfg.DevAuthHostToken = "dev_host_secret_token"

	s := cfg.RedactedString()
	str := cfg.String()

	secrets := []string{
		"super-secret-appsecret-12345",
		"admin_openid_secret_999",
		"pepper_secret_12345",
		"dev_admin_secret_token",
		"dev_host_secret_token",
	}

	for _, secret := range secrets {
		if strings.Contains(s, secret) {
			t.Errorf("RedactedString leaked secret: %s", secret)
		}
		if strings.Contains(str, secret) {
			t.Errorf("String() leaked secret: %s", secret)
		}
	}

	if !strings.Contains(s, "<redacted>") {
		t.Errorf("expected <redacted> in RedactedString, got: %s", s)
	}

	// Test slog logging does not leak secrets via LogValuer
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Info("startup_config", "config", cfg)

	logOutput := buf.String()
	for _, secret := range secrets {
		if strings.Contains(logOutput, secret) {
			t.Errorf("slog output leaked secret: %s", secret)
		}
	}

	if !strings.Contains(s, "HeartbeatInterval:30s") || !strings.Contains(s, "HeartbeatTimeout:10s") {
		t.Errorf("expected Heartbeat settings in RedactedString, got: %s", s)
	}
}

func TestValidate_Heartbeat(t *testing.T) {
	tests := []struct {
		name      string
		interval  time.Duration
		timeout   time.Duration
		expectErr string
	}{
		{
			name:      "zero interval",
			interval:  0,
			timeout:   10 * time.Second,
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name:      "negative interval",
			interval:  -10 * time.Second,
			timeout:   10 * time.Second,
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name:      "interval below 5s minimum",
			interval:  4 * time.Second,
			timeout:   1 * time.Second,
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name:      "interval above 120s maximum",
			interval:  130 * time.Second,
			timeout:   10 * time.Second,
			expectErr: "HEARTBEAT_INTERVAL must be between 5s and 120s",
		},
		{
			name:      "zero timeout",
			interval:  30 * time.Second,
			timeout:   0,
			expectErr: "HEARTBEAT_TIMEOUT must be positive",
		},
		{
			name:      "negative timeout",
			interval:  30 * time.Second,
			timeout:   -5 * time.Second,
			expectErr: "HEARTBEAT_TIMEOUT must be positive",
		},
		{
			name:      "timeout equal to interval",
			interval:  10 * time.Second,
			timeout:   10 * time.Second,
			expectErr: "HEARTBEAT_TIMEOUT must be less than HEARTBEAT_INTERVAL",
		},
		{
			name:      "timeout greater than interval",
			interval:  10 * time.Second,
			timeout:   15 * time.Second,
			expectErr: "HEARTBEAT_TIMEOUT must be less than HEARTBEAT_INTERVAL",
		},
		{
			name:      "valid interval and timeout",
			interval:  10 * time.Second,
			timeout:   3 * time.Second,
			expectErr: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.DevAuthMode = true
			cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-entropy-32"
			cfg.DevAuthHostToken = "dev-host-token-with-sufficient-entropy-32"
			cfg.HeartbeatInterval = tc.interval
			cfg.HeartbeatTimeout = tc.timeout

			err := cfg.Validate()
			if tc.expectErr == "" {
				if err != nil {
					t.Fatalf("expected valid heartbeat config, got: %v", err)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), tc.expectErr) {
					t.Fatalf("expected error containing %q, got: %v", tc.expectErr, err)
				}
			}
		})
	}
}

func TestLoadFromEnv_Heartbeat(t *testing.T) {
	t.Setenv("DEV_AUTH_MODE", "true")
	t.Setenv("DEV_AUTH_ADMIN_TOKEN", "dev-admin-token-with-sufficient-entropy-32")
	t.Setenv("DEV_AUTH_HOST_TOKEN", "dev-host-token-with-sufficient-entropy-32")
	t.Setenv("HEARTBEAT_INTERVAL", "15s")
	t.Setenv("HEARTBEAT_TIMEOUT", "5s")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("unexpected error loading env: %v", err)
	}

	if cfg.HeartbeatInterval != 15*time.Second {
		t.Errorf("expected HeartbeatInterval 15s, got %v", cfg.HeartbeatInterval)
	}
	if cfg.HeartbeatTimeout != 5*time.Second {
		t.Errorf("expected HeartbeatTimeout 5s, got %v", cfg.HeartbeatTimeout)
	}
}
