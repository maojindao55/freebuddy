package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestWeChatClient_Code2Session(t *testing.T) {
	expectedAppID := "wx_test_appid_123"
	expectedAppSecret := "wx_test_secret_456"

	// Fake WeChat HTTP service
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sns/jscode2session" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("appid") != expectedAppID || q.Get("secret") != expectedAppSecret {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40125,
				"errmsg":  "invalid appsecret",
			})
			return
		}
		if q.Get("grant_type") != "authorization_code" {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40002,
				"errmsg":  "invalid grant_type",
			})
			return
		}

		code := q.Get("js_code")
		switch code {
		case "valid_code":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"openid":      "openid_user_123",
				"session_key": "raw_session_key_to_discard",
				"unionid":     "unionid_user_123",
				"errcode":     0,
			})
		case "invalid_code":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40029,
				"errmsg":  "invalid code",
			})
		case "rate_limit_code":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 45011,
				"errmsg":  "rate limit",
			})
		case "server_error":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40013,
				"errmsg":  "invalid appid",
			})
		}
	}))
	defer ts.Close()

	client := NewWeChatClient(WeChatClientConfig{
		BaseURL:    ts.URL,
		AppID:      expectedAppID,
		AppSecret:  expectedAppSecret,
		HTTPClient: ts.Client(),
	})

	ctx := context.Background()

	// 1. Valid code
	res, err := client.Code2Session(ctx, "valid_code")
	if err != nil {
		t.Fatalf("Code2Session failed for valid code: %v", err)
	}
	if res.OpenID != "openid_user_123" {
		t.Errorf("expected openid_user_123, got %s", res.OpenID)
	}
	if res.UnionID != "unionid_user_123" {
		t.Errorf("expected unionid_user_123, got %s", res.UnionID)
	}

	// 2. Invalid code
	_, err = client.Code2Session(ctx, "invalid_code")
	if !errors.Is(err, ErrWeChatInvalidCode) {
		t.Errorf("expected ErrWeChatInvalidCode, got %v", err)
	}

	// 3. Rate limit code
	_, err = client.Code2Session(ctx, "rate_limit_code")
	if !errors.Is(err, ErrWeChatRateLimited) {
		t.Errorf("expected ErrWeChatRateLimited, got %v", err)
	}

	// 4. Server error
	_, err = client.Code2Session(ctx, "server_error")
	if !errors.Is(err, ErrWeChatUpstream) {
		t.Errorf("expected ErrWeChatUpstream, got %v", err)
	}

	// 5. Empty code
	_, err = client.Code2Session(ctx, "")
	if !errors.Is(err, ErrWeChatInvalidCode) {
		t.Errorf("expected ErrWeChatInvalidCode for empty code, got %v", err)
	}
}

func TestWeChatClient_Code2Session_ResponseSizeLimits(t *testing.T) {
	appID := "wx_test_appid_123"
	appSecret := "wx_test_secret_456"

	tests := []struct {
		name        string
		handler     http.HandlerFunc
		code        string
		wantErr     error
		wantOpenID  string
		wantUnionID string
	}{
		{
			name: "short response",
			code: "code_short",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"openid":"openid_short","unionid":"unionid_short","errcode":0}`))
			},
			wantOpenID:  "openid_short",
			wantUnionID: "unionid_short",
		},
		{
			name: "exactly limit",
			code: "code_exact_limit",
			handler: func(w http.ResponseWriter, r *http.Request) {
				prefix := []byte(`{"openid":"openid_exact","errcode":0}`)
				paddingLen := maxWeChatResponseBytes - len(prefix)
				body := append(prefix, bytes.Repeat([]byte(" "), paddingLen)...)

				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(body)
			},
			wantOpenID: "openid_exact",
		},
		{
			name: "limit plus one with Content-Length",
			code: "code_limit_plus_1",
			handler: func(w http.ResponseWriter, r *http.Request) {
				prefix := []byte(`{"openid":"openid_oversize","errcode":0}`)
				paddingLen := maxWeChatResponseBytes + 1 - len(prefix)
				body := append(prefix, bytes.Repeat([]byte(" "), paddingLen)...)

				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(body)
			},
			wantErr: ErrWeChatUpstream,
		},
		{
			name: "exactly limit chunked without Content-Length",
			code: "code_exact_limit_chunked",
			handler: func(w http.ResponseWriter, r *http.Request) {
				prefix := []byte(`{"openid":"openid_exact_chunked","errcode":0}`)
				paddingLen := maxWeChatResponseBytes - len(prefix)
				body := append(prefix, bytes.Repeat([]byte(" "), paddingLen)...)

				flusher, ok := w.(http.Flusher)
				if !ok {
					http.Error(w, "flusher not supported", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				flusher.Flush()

				_, _ = w.Write(body)
				flusher.Flush()
			},
			wantOpenID: "openid_exact_chunked",
		},
		{
			name: "limit plus one chunked without Content-Length",
			code: "code_limit_plus_1_chunked",
			handler: func(w http.ResponseWriter, r *http.Request) {
				prefix := []byte(`{"openid":"openid_oversize_chunked","errcode":0}`)
				paddingLen := maxWeChatResponseBytes + 1 - len(prefix)
				body := append(prefix, bytes.Repeat([]byte(" "), paddingLen)...)

				flusher, ok := w.(http.Flusher)
				if !ok {
					http.Error(w, "flusher not supported", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				flusher.Flush()

				_, _ = w.Write(body)
				flusher.Flush()
			},
			wantErr: ErrWeChatUpstream,
		},
		{
			name: "valid JSON with excess trailing whitespace",
			code: "code_excess_whitespace",
			handler: func(w http.ResponseWriter, r *http.Request) {
				// Regression test: valid JSON followed by whitespace exceeding 64 KiB
				body := append([]byte(`{"openid":"openid_whitespace","errcode":0}`), bytes.Repeat([]byte(" "), 70000)...)

				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(body)
			},
			wantErr: ErrWeChatUpstream,
		},
		{
			name: "chunked without Content-Length within limit",
			code: "code_chunked_ok",
			handler: func(w http.ResponseWriter, r *http.Request) {
				flusher, ok := w.(http.Flusher)
				if !ok {
					http.Error(w, "flusher not supported", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				flusher.Flush()

				_, _ = w.Write([]byte(`{"openid":"openid_chunked","errcode":0}`))
				flusher.Flush()
			},
			wantOpenID: "openid_chunked",
		},
		{
			name: "chunked without Content-Length exceeding limit with trailing whitespace",
			code: "code_chunked_oversize",
			handler: func(w http.ResponseWriter, r *http.Request) {
				flusher, ok := w.(http.Flusher)
				if !ok {
					http.Error(w, "flusher not supported", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				flusher.Flush()

				// First send valid JSON
				_, _ = w.Write([]byte(`{"openid":"openid_chunked_over","errcode":0}`))
				flusher.Flush()

				// Send excess whitespace chunk pushing total > 64 KiB
				_, _ = w.Write(bytes.Repeat([]byte(" "), 70000))
				flusher.Flush()
			},
			wantErr: ErrWeChatUpstream,
		},
		{
			name: "explicit Content-Length header exceeding limit",
			code: "code_header_oversize",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", "100000")
				w.WriteHeader(http.StatusOK)
			},
			wantErr: ErrWeChatUpstream,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/sns/jscode2session" {
					http.NotFound(w, r)
					return
				}
				tc.handler(w, r)
			}))
			defer ts.Close()

			client := NewWeChatClient(WeChatClientConfig{
				BaseURL:    ts.URL,
				AppID:      appID,
				AppSecret:  appSecret,
				HTTPClient: ts.Client(),
			})

			res, err := client.Code2Session(context.Background(), tc.code)
			if tc.wantErr != nil {
				if err == nil {
					t.Fatalf("expected error wrapping %v, got nil", tc.wantErr)
				}
				if !errors.Is(err, tc.wantErr) {
					t.Errorf("expected error wrapping %v, got: %v", tc.wantErr, err)
				}

				// Security check: ensure error never leaks secrets, code, or payload
				errMsg := err.Error()
				if strings.Contains(errMsg, appSecret) {
					t.Errorf("error leaks app secret: %s", errMsg)
				}
				if strings.Contains(errMsg, tc.code) {
					t.Errorf("error leaks code: %s", errMsg)
				}
				if strings.Contains(errMsg, "openid_") {
					t.Errorf("error leaks response payload: %s", errMsg)
				}
				if strings.Contains(errMsg, ts.URL) {
					t.Errorf("error leaks URL: %s", errMsg)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if res.OpenID != tc.wantOpenID {
					t.Errorf("expected openid %s, got %s", tc.wantOpenID, res.OpenID)
				}
				if tc.wantUnionID != "" && res.UnionID != tc.wantUnionID {
					t.Errorf("expected unionid %s, got %s", tc.wantUnionID, res.UnionID)
				}
			}
		})
	}
}
