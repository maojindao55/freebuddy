package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
)

// GenerateOpaqueToken creates a cryptographically secure, high-entropy random token
// conforming to OpaqueToken in protocol/remote/v1/common.schema.json (32 bytes -> 43 base64url chars).
func GenerateOpaqueToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate secure random bytes: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	if err := protocol.ValidateOpaqueToken(token); err != nil {
		return "", fmt.Errorf("generated token failed protocol validation: %w", err)
	}
	return token, nil
}

// HashToken computes a keyed HMAC-SHA256 hash over the token string using the server pepper.
// Returns a 64-character lowercase hex string.
// Raw tokens must NEVER be stored or logged; only this hash may be persisted.
func HashToken(token, pepper string) string {
	if pepper == "" {
		pepper = "dev_fallback_token_pepper_value_32_chars"
	}
	mac := hmac.New(sha256.New, []byte(pepper))
	mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}
