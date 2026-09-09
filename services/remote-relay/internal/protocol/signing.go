package protocol

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

// BuildHostAuthCanonicalPayload constructs the exact canonical signing bytes for host.auth.
func BuildHostAuthCanonicalPayload(hostID, challenge, connectionID, issuedAt string) string {
	return fmt.Sprintf(
		"freebuddy-remote-host-auth-v1\nhostId:%s\nchallenge:%s\nconnectionId:%s\nissuedAt:%s\n",
		hostID, challenge, connectionID, issuedAt,
	)
}

// BuildPairingStartCanonicalPayload constructs the exact canonical signing bytes for pairing-start.
func BuildPairingStartCanonicalPayload(hostID, keyID, publicKey, secretHash string) string {
	return fmt.Sprintf(
		"freebuddy-remote-pairing-start-v1\nhostId:%s\nkeyId:%s\npublicKey:%s\nsecretHash:%s\n",
		hostID, keyID, publicKey, secretHash,
	)
}

// ComputePairingSecretHash computes SHA-256 over wire secret bytes and encodes as base64url unpadded.
func ComputePairingSecretHash(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// VerifyHostAuthSignature verifies an Ed25519 signature over canonical host auth payload.
func VerifyHostAuthSignature(pubKeyBase64url, sigBase64url, canonical string) (bool, error) {
	pubKeyBytes, err := base64.RawURLEncoding.DecodeString(pubKeyBase64url)
	if err != nil {
		return false, fmt.Errorf("invalid base64url public key: %w", err)
	}
	if len(pubKeyBytes) != ed25519.PublicKeySize {
		return false, fmt.Errorf("invalid public key length %d (expected %d)", len(pubKeyBytes), ed25519.PublicKeySize)
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(sigBase64url)
	if err != nil {
		return false, fmt.Errorf("invalid base64url signature: %w", err)
	}
	if len(sigBytes) != ed25519.SignatureSize {
		return false, fmt.Errorf("invalid signature length %d (expected %d)", len(sigBytes), ed25519.SignatureSize)
	}

	ok := ed25519.Verify(pubKeyBytes, []byte(canonical), sigBytes)
	return ok, nil
}

// VerifyPairingStartProof verifies an Ed25519 signature over canonical pairing-start payload.
func VerifyPairingStartProof(pubKeyBase64url, proofBase64url, canonical string) (bool, error) {
	return VerifyHostAuthSignature(pubKeyBase64url, proofBase64url, canonical)
}

// GenerateEd25519KeyPair generates a new Ed25519 keypair for testing or host bootstrap.
func GenerateEd25519KeyPair() (pubKeyBase64url, privKeyBase64url string, err error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(pub), base64.RawURLEncoding.EncodeToString(priv), nil
}

// SignCanonicalPayload signs a canonical string with an Ed25519 private key.
func SignCanonicalPayload(privKeyBase64url, canonical string) (string, error) {
	privBytes, err := base64.RawURLEncoding.DecodeString(privKeyBase64url)
	if err != nil {
		return "", fmt.Errorf("invalid base64url private key: %w", err)
	}
	if len(privBytes) != ed25519.PrivateKeySize {
		return "", errors.New("invalid private key size")
	}
	sig := ed25519.Sign(privBytes, []byte(canonical))
	return base64.RawURLEncoding.EncodeToString(sig), nil
}
