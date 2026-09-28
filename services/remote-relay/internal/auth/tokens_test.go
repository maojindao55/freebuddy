package auth

import (
	"strings"
	"testing"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
)

func TestGenerateOpaqueToken(t *testing.T) {
	tokens := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		tok, err := GenerateOpaqueToken()
		if err != nil {
			t.Fatalf("GenerateOpaqueToken failed: %v", err)
		}
		if len(tok) < 32 || len(tok) > 512 {
			t.Errorf("token length %d out of bounds (32-512)", len(tok))
		}
		if err := protocol.ValidateOpaqueToken(tok); err != nil {
			t.Errorf("token failed protocol validation: %v", err)
		}
		if _, exists := tokens[tok]; exists {
			t.Fatalf("duplicate token generated: %s", tok)
		}
		tokens[tok] = struct{}{}
	}
}

func TestHashToken(t *testing.T) {
	pepper := "test-pepper-1234567890"
	token := "valid_opaque_token_string_12345678"

	h1 := HashToken(token, pepper)
	h2 := HashToken(token, pepper)
	if h1 != h2 {
		t.Errorf("expected deterministic hashing: %s != %s", h1, h2)
	}
	if len(h1) != 64 {
		t.Errorf("expected 64 character hex hash, got %d", len(h1))
	}

	// Different token should have different hash
	h3 := HashToken("different_token_string_12345678", pepper)
	if h1 == h3 {
		t.Errorf("hash collision for different tokens: %s", h1)
	}

	// Different pepper should have different hash
	h4 := HashToken(token, "different-pepper-9876543210")
	if h1 == h4 {
		t.Errorf("hash collision for different peppers: %s", h1)
	}

	// Never contain raw token
	if strings.Contains(h1, token) {
		t.Errorf("hash contains raw token")
	}
}
