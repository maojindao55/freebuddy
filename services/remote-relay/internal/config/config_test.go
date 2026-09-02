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
}

func TestValidate_DevMode(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DevAuthMode = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid config in dev mode, got: %v", err)
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
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.DevAuthMode = true
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
}
