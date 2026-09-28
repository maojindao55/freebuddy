package protocol

import (
	"strings"
	"testing"
)

func TestWeChatAuthRequest_Validation(t *testing.T) {
	tests := []struct {
		name    string
		req     WeChatAuthRequest
		wantErr bool
	}{
		{
			name: "valid request with deviceLabel",
			req: WeChatAuthRequest{
				Code:          "code_12345",
				ClientVersion: "1.0.0",
				DeviceLabel:   "iPhone 15 Pro",
			},
			wantErr: false,
		},
		{
			name: "valid request without deviceLabel",
			req: WeChatAuthRequest{
				Code:          "code_12345",
				ClientVersion: "1.0.0",
			},
			wantErr: false,
		},
		{
			name: "empty code",
			req: WeChatAuthRequest{
				Code:          "",
				ClientVersion: "1.0.0",
			},
			wantErr: true,
		},
		{
			name: "code too long",
			req: WeChatAuthRequest{
				Code:          strings.Repeat("a", 257),
				ClientVersion: "1.0.0",
			},
			wantErr: true,
		},
		{
			name: "empty clientVersion",
			req: WeChatAuthRequest{
				Code:          "code_12345",
				ClientVersion: "",
			},
			wantErr: true,
		},
		{
			name: "clientVersion too long",
			req: WeChatAuthRequest{
				Code:          "code_12345",
				ClientVersion: strings.Repeat("v", 65),
			},
			wantErr: true,
		},
		{
			name: "deviceLabel too long",
			req: WeChatAuthRequest{
				Code:          "code_12345",
				ClientVersion: "1.0.0",
				DeviceLabel:   strings.Repeat("d", 65),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.req.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestWeChatAuthResponse_Validation(t *testing.T) {
	validToken := strings.Repeat("a", 32)

	tests := []struct {
		name    string
		resp    WeChatAuthResponse
		wantErr bool
	}{
		{
			name: "valid response",
			resp: WeChatAuthResponse{
				AccessToken:      validToken,
				RefreshToken:     validToken,
				ExpiresIn:        86400,
				RefreshExpiresIn: 2592000,
			},
			wantErr: false,
		},
		{
			name: "invalid accessToken (too short)",
			resp: WeChatAuthResponse{
				AccessToken:      "short",
				RefreshToken:     validToken,
				ExpiresIn:        86400,
				RefreshExpiresIn: 2592000,
			},
			wantErr: true,
		},
		{
			name: "expiresIn too small",
			resp: WeChatAuthResponse{
				AccessToken:      validToken,
				RefreshToken:     validToken,
				ExpiresIn:        59,
				RefreshExpiresIn: 2592000,
			},
			wantErr: true,
		},
		{
			name: "expiresIn too large",
			resp: WeChatAuthResponse{
				AccessToken:      validToken,
				RefreshToken:     validToken,
				ExpiresIn:        86401,
				RefreshExpiresIn: 2592000,
			},
			wantErr: true,
		},
		{
			name: "refreshExpiresIn too small",
			resp: WeChatAuthResponse{
				AccessToken:      validToken,
				RefreshToken:     validToken,
				ExpiresIn:        86400,
				RefreshExpiresIn: 59,
			},
			wantErr: true,
		},
		{
			name: "refreshExpiresIn too large",
			resp: WeChatAuthResponse{
				AccessToken:      validToken,
				RefreshToken:     validToken,
				ExpiresIn:        86400,
				RefreshExpiresIn: 7776001,
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.resp.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestDecodeHTTPJSONBody_DisallowUnknownFields(t *testing.T) {
	// Unknown field should be rejected
	body := `{"code": "abc", "clientVersion": "1.0", "unknownField": "bad"}`
	var req WeChatAuthRequest
	err := DecodeHTTPJSONBody(strings.NewReader(body), &req)
	if err == nil {
		t.Errorf("expected error decoding json with unknown fields, got nil")
	}

	// Valid body should succeed
	validBody := `{"code": "abc", "clientVersion": "1.0"}`
	var validReq WeChatAuthRequest
	err = DecodeHTTPJSONBody(strings.NewReader(validBody), &validReq)
	if err != nil {
		t.Errorf("unexpected error decoding valid json: %v", err)
	}

	// Trailing data should be rejected
	trailingBody := `{"code": "abc", "clientVersion": "1.0"} extra`
	var trailingReq WeChatAuthRequest
	err = DecodeHTTPJSONBody(strings.NewReader(trailingBody), &trailingReq)
	if err == nil {
		t.Errorf("expected error decoding json with trailing data, got nil")
	}
}
