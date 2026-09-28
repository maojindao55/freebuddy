package protocol

import (
	"encoding/json"
	"fmt"
	"io"
)

// WeChatAuthRequest represents the companion HTTP request body for POST /v1/auth/wechat.
// Corresponds to #/$defs/WeChatAuthRequest in protocol/remote/v1/http.schema.json.
type WeChatAuthRequest struct {
	Code          string `json:"code"`
	ClientVersion string `json:"clientVersion"`
	DeviceLabel   string `json:"deviceLabel,omitempty"`
}

// Validate validates WeChatAuthRequest against http.schema.json constraints.
func (r *WeChatAuthRequest) Validate() error {
	if len(r.Code) < 1 || len(r.Code) > 256 {
		return fmt.Errorf("code length %d out of bounds (1-256)", len(r.Code))
	}
	if len(r.ClientVersion) < 1 || len(r.ClientVersion) > 64 {
		return fmt.Errorf("clientVersion length %d out of bounds (1-64)", len(r.ClientVersion))
	}
	if len(r.DeviceLabel) > 64 {
		return fmt.Errorf("deviceLabel length %d out of bounds (max 64)", len(r.DeviceLabel))
	}
	return nil
}

// WeChatAuthResponse represents the companion HTTP response body for POST /v1/auth/wechat.
// Corresponds to #/$defs/WeChatAuthResponse in protocol/remote/v1/http.schema.json.
type WeChatAuthResponse struct {
	AccessToken      string `json:"accessToken"`
	RefreshToken     string `json:"refreshToken"`
	ExpiresIn        int    `json:"expiresIn"`
	RefreshExpiresIn int    `json:"refreshExpiresIn"`
}

// Validate validates WeChatAuthResponse against http.schema.json constraints.
func (r *WeChatAuthResponse) Validate() error {
	if err := ValidateOpaqueToken(r.AccessToken); err != nil {
		return fmt.Errorf("invalid accessToken: %w", err)
	}
	if err := ValidateOpaqueToken(r.RefreshToken); err != nil {
		return fmt.Errorf("invalid refreshToken: %w", err)
	}
	if r.ExpiresIn < 60 || r.ExpiresIn > 86400 {
		return fmt.Errorf("expiresIn %d out of bounds [60, 86400]", r.ExpiresIn)
	}
	if r.RefreshExpiresIn < 60 || r.RefreshExpiresIn > 7776000 {
		return fmt.Errorf("refreshExpiresIn %d out of bounds [60, 7776000]", r.RefreshExpiresIn)
	}
	return nil
}

// RefreshRequest represents the companion HTTP request body for POST /v1/auth/refresh.
// Corresponds to #/$defs/RefreshRequest in protocol/remote/v1/http.schema.json.
type RefreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// Validate validates RefreshRequest against http.schema.json constraints.
func (r *RefreshRequest) Validate() error {
	if err := ValidateOpaqueToken(r.RefreshToken); err != nil {
		return fmt.Errorf("invalid refreshToken: %w", err)
	}
	return nil
}

// RefreshResponse represents the companion HTTP response body for POST /v1/auth/refresh.
// Corresponds to #/$defs/RefreshResponse in protocol/remote/v1/http.schema.json.
type RefreshResponse = WeChatAuthResponse

// LogoutRequest represents the companion HTTP request body for POST /v1/sessions/logout.
// Corresponds to #/$defs/LogoutRequest in protocol/remote/v1/http.schema.json.
type LogoutRequest struct{}

// DecodeHTTPJSONBody decodes JSON strictly, disallowing unknown fields and verifying EOF.
func DecodeHTTPJSONBody(r io.Reader, v interface{}) error {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("failed to decode JSON: %w", err)
	}
	// Verify no trailing tokens
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("unexpected trailing data in JSON body")
	}
	return nil
}
