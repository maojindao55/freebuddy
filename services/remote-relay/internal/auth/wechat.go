package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultWeChatBaseURL   = "https://api.weixin.qq.com"
	defaultWeChatTimeout   = 5 * time.Second
	maxWeChatResponseBytes = 65536 // 64 KiB
)

var (
	// ErrWeChatAuthFailed indicates WeChat returned an authentication or business error.
	ErrWeChatAuthFailed = errors.New("wechat authentication failed")
	// ErrWeChatInvalidCode indicates the provided js_code was invalid or expired (errcode 40029).
	ErrWeChatInvalidCode = errors.New("invalid or expired wechat code")
	// ErrWeChatRateLimited indicates WeChat API rate limit was exceeded (errcode 45011).
	ErrWeChatRateLimited = errors.New("wechat rate limit reached")
	// ErrWeChatUpstream indicates a network or upstream server error connecting to WeChat.
	ErrWeChatUpstream = errors.New("wechat upstream service error")
)

// WeChatClientConfig configures the WeChat HTTP client.
type WeChatClientConfig struct {
	BaseURL    string
	AppID      string
	AppSecret  string
	HTTPClient *http.Client
}

// WeChatClient handles interaction with WeChat's code2Session endpoint.
type WeChatClient struct {
	baseURL    string
	appID      string
	appSecret  string
	httpClient *http.Client
}

// NewWeChatClient initializes a new WeChat API client.
func NewWeChatClient(cfg WeChatClientConfig) *WeChatClient {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	if baseURL == "" {
		baseURL = defaultWeChatBaseURL
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: defaultWeChatTimeout,
		}
	}
	return &WeChatClient{
		baseURL:    baseURL,
		appID:      cfg.AppID,
		appSecret:  cfg.AppSecret,
		httpClient: client,
	}
}

// Code2SessionResult contains the safe extracted identity returned by WeChat.
// Note: session_key is intentionally discarded to prevent secret retention.
type Code2SessionResult struct {
	OpenID  string
	UnionID string
}

type wechatRawResponse struct {
	OpenID     string `json:"openid"`
	SessionKey string `json:"session_key"`
	UnionID    string `json:"unionid"`
	ErrCode    int    `json:"errcode"`
	ErrMsg     string `json:"errmsg"`
}

// Code2Session exchanges an authorization code for OpenID via WeChat's jscode2session endpoint.
// Invariant: This function NEVER prints, logs, or formats errors containing AppSecret, code, or session_key.
func (c *WeChatClient) Code2Session(ctx context.Context, code string) (*Code2SessionResult, error) {
	if strings.TrimSpace(code) == "" {
		return nil, ErrWeChatInvalidCode
	}

	u, err := url.Parse(c.baseURL + "/sns/jscode2session")
	if err != nil {
		return nil, fmt.Errorf("invalid wechat endpoint url: %w", err)
	}

	q := u.Query()
	q.Set("appid", c.appID)
	q.Set("secret", c.appSecret)
	q.Set("js_code", code)
	q.Set("grant_type", "authorization_code")
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create wechat request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Strictly avoid wrapping req or u which contains secrets
		return nil, fmt.Errorf("%w: transport failure", ErrWeChatUpstream)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrWeChatUpstream, resp.StatusCode)
	}

	if resp.ContentLength > maxWeChatResponseBytes {
		return nil, fmt.Errorf("%w: response exceeded size limit", ErrWeChatUpstream)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxWeChatResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read response failed", ErrWeChatUpstream)
	}

	if int64(len(body)) > maxWeChatResponseBytes {
		return nil, fmt.Errorf("%w: response exceeded size limit", ErrWeChatUpstream)
	}

	var raw wechatRawResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("%w: decode response failed", ErrWeChatUpstream)
	}

	// SessionKey is discarded and never retained or logged

	if raw.ErrCode != 0 {
		switch raw.ErrCode {
		case 40029:
			return nil, ErrWeChatInvalidCode
		case 45011:
			return nil, ErrWeChatRateLimited
		default:
			return nil, fmt.Errorf("%w (errcode %d)", ErrWeChatAuthFailed, raw.ErrCode)
		}
	}

	if raw.OpenID == "" {
		return nil, fmt.Errorf("%w: response missing openid", ErrWeChatAuthFailed)
	}

	return &Code2SessionResult{
		OpenID:  raw.OpenID,
		UnionID: raw.UnionID,
	}, nil
}
