package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MaxAllowedFrameBytes is the fixed upper bound defined by protocol/remote/v1 (256 KiB = 262144 bytes).
const MaxAllowedFrameBytes int64 = 262144

// Config represents the application configuration for the Remote Relay service.
type Config struct {
	// Server network settings
	ListenAddr    string
	PublicBaseURL string
	TrustProxy    bool

	// Storage
	SQLitePath string

	// Authentication (Production)
	WeChatAppID     string
	WeChatAppSecret string
	AdminOpenID     string
	TokenHashPepper string

	// Development / POC Mode
	DevAuthMode       bool
	DevAuthAdminToken string
	DevAuthHostToken  string
	DevAuthHostID     string

	// Logging
	LogLevel  string // "debug", "info", "warn", "error"
	LogFormat string // "json", "text"

	// Timeouts and Limits
	HTTPReadHeaderTimeout time.Duration
	HTTPReadTimeout       time.Duration
	HTTPWriteTimeout      time.Duration
	HTTPIdleTimeout       time.Duration
	ShutdownGracePeriod   time.Duration

	MaxFrameBytes    int64
	MaxSendQueueSize int
	RPCTimeout       time.Duration
	PairingTTL       time.Duration
	TokenTTL         time.Duration
	RefreshTokenTTL  time.Duration
	ChallengeTTL     time.Duration

	HeartbeatInterval time.Duration
	HeartbeatTimeout  time.Duration
}

// DefaultConfig returns a Config initialized with sensible defaults.
func DefaultConfig() Config {
	return Config{
		ListenAddr:            ":8080",
		PublicBaseURL:         "",
		TrustProxy:            false,
		SQLitePath:            ":memory:",
		WeChatAppID:           "",
		WeChatAppSecret:       "",
		AdminOpenID:           "",
		TokenHashPepper:       "",
		DevAuthMode:           false,
		DevAuthAdminToken:     "",
		DevAuthHostToken:      "",
		DevAuthHostID:         "host_dev",
		LogLevel:              "info",
		LogFormat:             "json",
		HTTPReadHeaderTimeout: 5 * time.Second,
		HTTPReadTimeout:       15 * time.Second,
		HTTPWriteTimeout:      30 * time.Second,
		HTTPIdleTimeout:       60 * time.Second,
		ShutdownGracePeriod:   10 * time.Second,
		MaxFrameBytes:         MaxAllowedFrameBytes, // 256 KiB (262144 bytes)
		MaxSendQueueSize:      256,
		RPCTimeout:            30 * time.Second,
		PairingTTL:            5 * time.Minute,
		TokenTTL:              24 * time.Hour,
		RefreshTokenTTL:       30 * 24 * time.Hour,
		ChallengeTTL:          60 * time.Second,
		HeartbeatInterval:     30 * time.Second,
		HeartbeatTimeout:      10 * time.Second,
	}
}

// LoadFromEnv loads configuration from environment variables, falling back to defaults.
func LoadFromEnv() (Config, error) {
	cfg := DefaultConfig()

	if v := os.Getenv("LISTEN_ADDR"); v != "" {
		cfg.ListenAddr = v
	}
	if v := os.Getenv("PUBLIC_BASE_URL"); v != "" {
		cfg.PublicBaseURL = v
	}
	if v := os.Getenv("TRUST_PROXY"); v != "" {
		cfg.TrustProxy = parseBool(v, cfg.TrustProxy)
	}
	if v := os.Getenv("SQLITE_PATH"); v != "" {
		cfg.SQLitePath = v
	}
	if v := os.Getenv("WECHAT_APP_ID"); v != "" {
		cfg.WeChatAppID = v
	}
	if v := os.Getenv("WECHAT_APP_SECRET"); v != "" {
		cfg.WeChatAppSecret = v
	}
	if v := os.Getenv("ADMIN_OPENID"); v != "" {
		cfg.AdminOpenID = v
	}
	if v := os.Getenv("TOKEN_HASH_PEPPER"); v != "" {
		cfg.TokenHashPepper = v
	}
	if v := os.Getenv("DEV_AUTH_MODE"); v != "" {
		cfg.DevAuthMode = parseBool(v, cfg.DevAuthMode)
	}
	if v := os.Getenv("DEV_AUTH_ADMIN_TOKEN"); v != "" {
		cfg.DevAuthAdminToken = v
	} else if v := os.Getenv("DEV_ADMIN_TOKEN"); v != "" {
		cfg.DevAuthAdminToken = v
	}
	if v := os.Getenv("DEV_AUTH_HOST_TOKEN"); v != "" {
		cfg.DevAuthHostToken = v
	} else if v := os.Getenv("DEV_HOST_TOKEN"); v != "" {
		cfg.DevAuthHostToken = v
	}
	if v := os.Getenv("DEV_AUTH_HOST_ID"); v != "" {
		cfg.DevAuthHostID = v
	} else if v := os.Getenv("DEV_HOST_ID"); v != "" {
		cfg.DevAuthHostID = v
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.LogLevel = strings.ToLower(v)
	}
	if v := os.Getenv("LOG_FORMAT"); v != "" {
		cfg.LogFormat = strings.ToLower(v)
	}

	if v := os.Getenv("HTTP_READ_HEADER_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HTTPReadHeaderTimeout = d
		}
	}
	if v := os.Getenv("HTTP_READ_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HTTPReadTimeout = d
		}
	}
	if v := os.Getenv("HTTP_WRITE_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HTTPWriteTimeout = d
		}
	}
	if v := os.Getenv("HTTP_IDLE_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HTTPIdleTimeout = d
		}
	}
	if v := os.Getenv("SHUTDOWN_GRACE_PERIOD"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ShutdownGracePeriod = d
		}
	}
	if v := os.Getenv("MAX_FRAME_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			cfg.MaxFrameBytes = n
		}
	}
	if v := os.Getenv("MAX_SEND_QUEUE_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.MaxSendQueueSize = n
		}
	}
	if v := os.Getenv("RPC_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.RPCTimeout = d
		}
	}
	if v := os.Getenv("PAIRING_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.PairingTTL = d
		}
	}
	if v := os.Getenv("TOKEN_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.TokenTTL = d
		}
	}
	if v := os.Getenv("REFRESH_TOKEN_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.RefreshTokenTTL = d
		}
	}
	if v := os.Getenv("CHALLENGE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ChallengeTTL = d
		}
	}
	if v := os.Getenv("HEARTBEAT_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HeartbeatInterval = d
		}
	}
	if v := os.Getenv("HEARTBEAT_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HeartbeatTimeout = d
		}
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("config validation failed: %w", err)
	}

	return cfg, nil
}

// Validate performs strict validation of all configuration parameters.
func (c *Config) Validate() error {
	var errs []string

	// Listen address validation
	if strings.TrimSpace(c.ListenAddr) == "" {
		errs = append(errs, "LISTEN_ADDR must not be empty")
	} else {
		// Verify listen address format (either :port or host:port)
		addr := c.ListenAddr
		if strings.HasPrefix(addr, ":") {
			addr = "localhost" + addr
		}
		if _, _, err := net.SplitHostPort(addr); err != nil {
			errs = append(errs, fmt.Sprintf("LISTEN_ADDR is invalid: %v", err))
		}
	}

	// Public Base URL validation (if provided)
	if c.PublicBaseURL != "" {
		parsed, err := url.Parse(c.PublicBaseURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			errs = append(errs, "PUBLIC_BASE_URL must be a valid absolute HTTP or HTTPS URL")
		} else {
			if parsed.User != nil {
				errs = append(errs, "PUBLIC_BASE_URL must not contain userinfo")
			}
			if parsed.Path != "" && parsed.Path != "/" {
				errs = append(errs, "PUBLIC_BASE_URL must not contain a path")
			}
			if parsed.RawQuery != "" || strings.Contains(c.PublicBaseURL, "?") {
				errs = append(errs, "PUBLIC_BASE_URL must not contain a query string")
			}
			if parsed.Fragment != "" || strings.Contains(c.PublicBaseURL, "#") {
				errs = append(errs, "PUBLIC_BASE_URL must not contain a fragment")
			}
		}
	}

	// SQLite path validation
	if strings.TrimSpace(c.SQLitePath) == "" {
		errs = append(errs, "SQLITE_PATH must not be empty")
	}

	// Log level validation
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
		// valid
	default:
		errs = append(errs, fmt.Sprintf("LOG_LEVEL %q is invalid (expected: debug, info, warn, error)", c.LogLevel))
	}

	// Log format validation
	switch c.LogFormat {
	case "json", "text":
		// valid
	default:
		errs = append(errs, fmt.Sprintf("LOG_FORMAT %q is invalid (expected: json, text)", c.LogFormat))
	}

	// Production vs Dev mode validation
	if !c.DevAuthMode {
		// In production mode, dev tokens must not be set
		if c.DevAuthAdminToken != "" || c.DevAuthHostToken != "" {
			errs = append(errs, "DEV_AUTH_ADMIN_TOKEN and DEV_AUTH_HOST_TOKEN must not be set when DEV_AUTH_MODE is false")
		}
		// In production mode, authentication secrets are strictly required and cannot be empty or weak
		if strings.TrimSpace(c.WeChatAppID) == "" {
			errs = append(errs, "WECHAT_APP_ID is required in production mode (DEV_AUTH_MODE=false)")
		}
		if strings.TrimSpace(c.WeChatAppSecret) == "" {
			errs = append(errs, "WECHAT_APP_SECRET is required in production mode (DEV_AUTH_MODE=false)")
		}
		if strings.TrimSpace(c.AdminOpenID) == "" {
			errs = append(errs, "ADMIN_OPENID is required in production mode (DEV_AUTH_MODE=false)")
		}
		if strings.TrimSpace(c.TokenHashPepper) == "" {
			errs = append(errs, "TOKEN_HASH_PEPPER is required in production mode (DEV_AUTH_MODE=false)")
		} else if len(c.TokenHashPepper) < 16 {
			errs = append(errs, "TOKEN_HASH_PEPPER must be at least 16 characters long for cryptographic security")
		}
	} else {
		// In dev auth mode, dev tokens must be provided and have high entropy (>= 32 characters, OpaqueToken character set, non-weak)
		errs = append(errs, validateDevToken("DEV_AUTH_ADMIN_TOKEN (or DEV_ADMIN_TOKEN)", c.DevAuthAdminToken)...)
		errs = append(errs, validateDevToken("DEV_AUTH_HOST_TOKEN (or DEV_HOST_TOKEN)", c.DevAuthHostToken)...)
		if strings.TrimSpace(c.DevAuthHostID) == "" {
			errs = append(errs, "DEV_AUTH_HOST_ID must not be empty when DEV_AUTH_MODE=true")
		}
	}

	// Timeouts must be positive and conform to wire protocol limits
	if c.HTTPReadHeaderTimeout <= 0 {
		errs = append(errs, "HTTP_READ_HEADER_TIMEOUT must be positive")
	}
	if c.HTTPReadTimeout <= 0 {
		errs = append(errs, "HTTP_READ_TIMEOUT must be positive")
	}
	if c.HTTPWriteTimeout <= 0 {
		errs = append(errs, "HTTP_WRITE_TIMEOUT must be positive")
	}
	if c.HTTPIdleTimeout <= 0 {
		errs = append(errs, "HTTP_IDLE_TIMEOUT must be positive")
	}
	if c.ShutdownGracePeriod <= 0 {
		errs = append(errs, "SHUTDOWN_GRACE_PERIOD must be positive")
	}
	if c.MaxFrameBytes <= 0 {
		errs = append(errs, "MAX_FRAME_BYTES must be positive")
	} else if c.MaxFrameBytes > MaxAllowedFrameBytes {
		errs = append(errs, fmt.Sprintf("MAX_FRAME_BYTES must not exceed protocol limit of %d bytes", MaxAllowedFrameBytes))
	}
	if c.MaxSendQueueSize <= 0 {
		errs = append(errs, "MAX_SEND_QUEUE_SIZE must be positive")
	}
	if c.RPCTimeout < 1*time.Second || c.RPCTimeout > 120*time.Second {
		errs = append(errs, "RPC_TIMEOUT must be between 1s and 120s (1000ms to 120000ms)")
	}
	if c.PairingTTL <= 0 {
		errs = append(errs, "PAIRING_TTL must be positive")
	}
	if c.TokenTTL <= 0 {
		errs = append(errs, "TOKEN_TTL must be positive")
	}
	if c.RefreshTokenTTL <= 0 {
		errs = append(errs, "REFRESH_TOKEN_TTL must be positive")
	}
	if c.ChallengeTTL < 1*time.Second || c.ChallengeTTL > 300*time.Second {
		errs = append(errs, "CHALLENGE_TTL must be between 1s and 300s (1000ms to 300000ms)")
	}
	if c.HeartbeatInterval < 5*time.Second || c.HeartbeatInterval > 120*time.Second {
		errs = append(errs, "HEARTBEAT_INTERVAL must be between 5s and 120s (5000ms to 120000ms)")
	}
	if c.HeartbeatTimeout <= 0 {
		errs = append(errs, "HEARTBEAT_TIMEOUT must be positive")
	} else if c.HeartbeatInterval > 0 && c.HeartbeatTimeout >= c.HeartbeatInterval {
		errs = append(errs, "HEARTBEAT_TIMEOUT must be less than HEARTBEAT_INTERVAL")
	}

	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// RedactedString returns a string representation of the config with all sensitive secrets masked.
func (c Config) RedactedString() string {
	mask := func(s string) string {
		if s == "" {
			return "<unset>"
		}
		return "<redacted>"
	}

	return fmt.Sprintf(
		"Config{ListenAddr:%s, PublicBaseURL:%s, TrustProxy:%v, SQLitePath:%s, "+
			"WeChatAppID:%s, WeChatAppSecret:%s, AdminOpenID:%s, TokenHashPepper:%s, "+
			"DevAuthMode:%v, DevAuthAdminToken:%s, DevAuthHostToken:%s, DevAuthHostID:%s, LogLevel:%s, LogFormat:%s, "+
			"ShutdownGracePeriod:%v, MaxFrameBytes:%d, RPCTimeout:%v, "+
			"HeartbeatInterval:%v, HeartbeatTimeout:%v}",
		c.ListenAddr,
		c.PublicBaseURL,
		c.TrustProxy,
		c.SQLitePath,
		c.WeChatAppID,
		mask(c.WeChatAppSecret),
		mask(c.AdminOpenID),
		mask(c.TokenHashPepper),
		c.DevAuthMode,
		mask(c.DevAuthAdminToken),
		mask(c.DevAuthHostToken),
		c.DevAuthHostID,
		c.LogLevel,
		c.LogFormat,
		c.ShutdownGracePeriod,
		c.MaxFrameBytes,
		c.RPCTimeout,
		c.HeartbeatInterval,
		c.HeartbeatTimeout,
	)
}

// String implements fmt.Stringer to ensure config string representations are always redacted.
func (c Config) String() string {
	return c.RedactedString()
}

// LogValue implements slog.LogValuer to ensure structured logging always redacts sensitive fields.
func (c Config) LogValue() slog.Value {
	return slog.StringValue(c.RedactedString())
}

func parseBool(val string, defaultVal bool) bool {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "1", "t", "true", "yes", "on":
		return true
	case "0", "f", "false", "no", "off":
		return false
	default:
		return defaultVal
	}
}

var opaqueTokenRegex = regexp.MustCompile(`^[A-Za-z0-9._~-]{32,512}$`)

func isWeakToken(token string) bool {
	// 1. Check distinct characters (at least 8 distinct characters)
	seen := make(map[rune]struct{})
	for _, r := range token {
		seen[r] = struct{}{}
	}
	if len(seen) < 8 {
		return true
	}
	// 2. Check for simple repeating patterns (period 1 to 8)
	for period := 1; period <= 8; period++ {
		pattern := token[:period]
		repeats := true
		for i := period; i < len(token); i += period {
			end := i + period
			if end > len(token) {
				end = len(token)
			}
			if token[i:end] != pattern[:end-i] {
				repeats = false
				break
			}
		}
		if repeats {
			return true
		}
	}
	return false
}

func validateDevToken(name, token string) []string {
	var errs []string
	if strings.TrimSpace(token) == "" {
		errs = append(errs, fmt.Sprintf("%s is required when DEV_AUTH_MODE=true", name))
		return errs
	}
	if len(token) < 32 {
		errs = append(errs, fmt.Sprintf("%s must be at least 32 characters long", name))
	} else if len(token) > 512 {
		errs = append(errs, fmt.Sprintf("%s must not exceed 512 characters", name))
	}
	if !opaqueTokenRegex.MatchString(token) {
		errs = append(errs, fmt.Sprintf("%s must match OpaqueToken character set (^[A-Za-z0-9._~-]+$)", name))
	}
	if isWeakToken(token) {
		errs = append(errs, fmt.Sprintf("%s rejected due to insufficient entropy or weak repetitive pattern", name))
	}
	return errs
}
