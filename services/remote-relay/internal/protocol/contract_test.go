package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func findProtocolRootDir(t *testing.T) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "..", "..", "protocol", "remote", "v1"),
		filepath.Join("..", "..", "..", "protocol", "remote", "v1"),
		filepath.Join("..", "..", "protocol", "remote", "v1"),
		filepath.Join("..", "protocol", "remote", "v1"),
		filepath.Join("protocol", "remote", "v1"),
	}

	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			abs, err := filepath.Abs(c)
			if err == nil {
				return abs
			}
			return c
		}
	}
	t.Fatal("could not find protocol/remote/v1 directory")
	return ""
}

type Manifest struct {
	Valid              []string `json:"valid"`
	Invalid            []string `json:"invalid"`
	Signing            []string `json:"signing"`
	Runtime            []string `json:"runtime"`
	HTTPValid          []string `json:"httpValid"`
	HTTPInvalid        []string `json:"httpInvalid"`
	RequiredFrameTypes []string `json:"requiredFrameTypes"`
}

type InvalidFixture struct {
	Reason string          `json:"reason"`
	Reject string          `json:"reject"`
	Frame  json.RawMessage `json:"frame"`
}

func TestManifestValidFixtures(t *testing.T) {
	rootDir := findProtocolRootDir(t)
	manifestPath := filepath.Join(rootDir, "fixtures", "manifest.json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("failed to read manifest.json: %v", err)
	}

	var manifest Manifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatalf("failed to unmarshal manifest.json: %v", err)
	}

	if len(manifest.Valid) == 0 {
		t.Fatal("manifest.valid contains no fixtures")
	}

	for _, file := range manifest.Valid {
		t.Run("valid/"+file, func(t *testing.T) {
			filePath := filepath.Join(rootDir, "fixtures", "valid", file)
			data, err := os.ReadFile(filePath)
			if err != nil {
				t.Fatalf("failed to read fixture file %s: %v", file, err)
			}

			env, err := DecodeEnvelope(data)
			if err != nil {
				t.Fatalf("expected valid envelope for %s, got error: %v", file, err)
			}

			// Verify re-encoding produces valid data under frame limit
			encoded, err := EncodeEnvelope(env)
			if err != nil {
				t.Fatalf("failed to re-encode envelope: %v", err)
			}
			if len(encoded) == 0 {
				t.Fatal("encoded envelope is empty")
			}
		})
	}
}

func TestManifestInvalidFixtures(t *testing.T) {
	rootDir := findProtocolRootDir(t)
	manifestPath := filepath.Join(rootDir, "fixtures", "manifest.json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("failed to read manifest.json: %v", err)
	}

	var manifest Manifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatalf("failed to unmarshal manifest.json: %v", err)
	}

	for _, file := range manifest.Invalid {
		t.Run("invalid/"+file, func(t *testing.T) {
			filePath := filepath.Join(rootDir, "fixtures", "invalid", file)
			data, err := os.ReadFile(filePath)
			if err != nil {
				t.Fatalf("failed to read invalid fixture file %s: %v", file, err)
			}

			var inv InvalidFixture
			if err := json.Unmarshal(data, &inv); err != nil {
				t.Fatalf("failed to parse invalid fixture envelope container %s: %v", file, err)
			}

			env, err := DecodeEnvelope(inv.Frame)
			if inv.Reject == "schema" || inv.Reject == "parse" {
				if err == nil {
					t.Fatalf("expected failure for invalid fixture %s (reason: %s), but DecodeEnvelope succeeded", file, inv.Reason)
				}
			} else if inv.Reject == "runtime" {
				// In runtime reject (such as expired-write.json), envelope is schema-valid, but runtime validation catches expiry
				if err != nil {
					t.Fatalf("expected schema parse to succeed for runtime reject %s, got error: %v", file, err)
				}
				if inv.Reason == ErrCodeRequestExpired {
					if env.ExpiresAt == "" {
						t.Fatalf("expected expiresAt in expired write fixture")
					}
					expTime, err := time.Parse(time.RFC3339Nano, env.ExpiresAt)
					if err != nil {
						t.Fatalf("invalid expiresAt: %v", err)
					}
					// Verify that timestamp is in the past
					if !expTime.Before(time.Now().UTC()) {
						t.Fatalf("expected expiresAt to be in the past for %s", file)
					}
				}
			}
		})
	}
}

func TestSigningGoldenFixtures(t *testing.T) {
	rootDir := findProtocolRootDir(t)
	signingDir := filepath.Join(rootDir, "fixtures", "signing")

	// 1. canonical.json
	t.Run("canonical.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(signingDir, "canonical.json"))
		if err != nil {
			t.Fatalf("failed to read canonical.json: %v", err)
		}
		var fixture struct {
			HostID         string `json:"hostId"`
			Challenge      string `json:"challenge"`
			ConnectionID   string `json:"connectionId"`
			IssuedAt       string `json:"issuedAt"`
			CanonicalUtf8  string `json:"canonicalUtf8"`
			CanonicalHex   string `json:"canonicalHex"`
			Utf8ByteLength int    `json:"utf8ByteLength"`
		}
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatalf("failed to unmarshal canonical.json: %v", err)
		}

		canonical := BuildHostAuthCanonicalPayload(fixture.HostID, fixture.Challenge, fixture.ConnectionID, fixture.IssuedAt)
		if canonical != fixture.CanonicalUtf8 {
			t.Fatalf("canonical UTF-8 mismatch:\nexpected: %q\ngot:      %q", fixture.CanonicalUtf8, canonical)
		}

		canonicalHex := hex.EncodeToString([]byte(canonical))
		if canonicalHex != fixture.CanonicalHex {
			t.Fatalf("canonical hex mismatch:\nexpected: %s\ngot:      %s", fixture.CanonicalHex, canonicalHex)
		}

		if len([]byte(canonical)) != fixture.Utf8ByteLength {
			t.Fatalf("canonical byte length mismatch: expected %d, got %d", fixture.Utf8ByteLength, len([]byte(canonical)))
		}
	})

	// 2. valid-signature.json
	t.Run("valid-signature.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(signingDir, "valid-signature.json"))
		if err != nil {
			t.Fatalf("failed to read valid-signature.json: %v", err)
		}
		var fixture struct {
			Expect                string `json:"expect"`
			PublicKeyRawBase64url string `json:"publicKeyRawBase64url"`
			SignatureBase64url    string `json:"signatureBase64url"`
			CanonicalUtf8         string `json:"canonicalUtf8"`
		}
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatalf("failed to unmarshal valid-signature.json: %v", err)
		}

		ok, err := VerifyHostAuthSignature(fixture.PublicKeyRawBase64url, fixture.SignatureBase64url, fixture.CanonicalUtf8)
		if err != nil {
			t.Fatalf("unexpected error verifying signature: %v", err)
		}
		if !ok {
			t.Fatalf("expected valid signature verification for valid-signature.json")
		}
	})

	// 3. tampered-hostId.json
	t.Run("tampered-hostId.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(signingDir, "tampered-hostId.json"))
		if err != nil {
			t.Fatalf("failed to read tampered-hostId.json: %v", err)
		}
		var fixture struct {
			Expect                string `json:"expect"`
			PublicKeyRawBase64url string `json:"publicKeyRawBase64url"`
			SignatureBase64url    string `json:"signatureBase64url"`
			CanonicalUtf8         string `json:"canonicalUtf8"`
		}
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatalf("failed to unmarshal tampered-hostId.json: %v", err)
		}

		ok, _ := VerifyHostAuthSignature(fixture.PublicKeyRawBase64url, fixture.SignatureBase64url, fixture.CanonicalUtf8)
		if ok {
			t.Fatalf("expected tampered signature verification to fail, but it succeeded")
		}
	})

	// 4. pairing-start-canonical.json
	t.Run("pairing-start-canonical.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(signingDir, "pairing-start-canonical.json"))
		if err != nil {
			t.Fatalf("failed to read pairing-start-canonical.json: %v", err)
		}
		var fixture struct {
			HostID        string `json:"hostId"`
			KeyID         string `json:"keyId"`
			PublicKey     string `json:"publicKey"`
			Secret        string `json:"secret"`
			SecretHash    string `json:"secretHash"`
			CanonicalUtf8 string `json:"canonicalUtf8"`
			CanonicalHex  string `json:"canonicalHex"`
			Proof         string `json:"proof"`
		}
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatalf("failed to unmarshal pairing-start-canonical.json: %v", err)
		}

		secretHash := ComputePairingSecretHash(fixture.Secret)
		if secretHash != fixture.SecretHash {
			t.Fatalf("secretHash mismatch: expected %s, got %s", fixture.SecretHash, secretHash)
		}

		canonical := BuildPairingStartCanonicalPayload(fixture.HostID, fixture.KeyID, fixture.PublicKey, secretHash)
		if canonical != fixture.CanonicalUtf8 {
			t.Fatalf("pairing-start canonical mismatch:\nexpected: %q\ngot:      %q", fixture.CanonicalUtf8, canonical)
		}

		canonicalHex := hex.EncodeToString([]byte(canonical))
		if canonicalHex != fixture.CanonicalHex {
			t.Fatalf("pairing-start canonical hex mismatch:\nexpected: %s\ngot:      %s", fixture.CanonicalHex, canonicalHex)
		}

		ok, err := VerifyPairingStartProof(fixture.PublicKey, fixture.Proof, canonical)
		if err != nil {
			t.Fatalf("unexpected error verifying proof: %v", err)
		}
		if !ok {
			t.Fatalf("expected valid proof verification for pairing-start")
		}
	})
}

func TestMethodRegistryLock(t *testing.T) {
	rootDir := findProtocolRootDir(t)
	registryPath := filepath.Join(rootDir, "methods", "registry.json")
	data, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatalf("failed to read registry.json: %v", err)
	}

	var reg struct {
		Version int `json:"version"`
		Methods []struct {
			Method string `json:"method"`
			Kind   string `json:"kind"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(data, &reg); err != nil {
		t.Fatalf("failed to unmarshal registry.json: %v", err)
	}

	seenInJSON := make(map[string]string)
	for _, m := range reg.Methods {
		seenInJSON[m.Method] = m.Kind
		if m.Kind == "read" {
			if !IsReadMethod(m.Method) {
				t.Errorf("read method %q in registry.json is not in Go ReadMethods", m.Method)
			}
		} else if m.Kind == "write" {
			if !IsWriteMethod(m.Method) {
				t.Errorf("write method %q in registry.json is not in Go WriteMethods", m.Method)
			}
		}
	}

	for m := range ReadMethods {
		kind, ok := seenInJSON[m]
		if !ok || kind != "read" {
			t.Errorf("Go ReadMethod %q not in registry.json as read", m)
		}
	}

	for m := range WriteMethods {
		kind, ok := seenInJSON[m]
		if !ok || kind != "write" {
			t.Errorf("Go WriteMethod %q not in registry.json as write", m)
		}
	}
}

func TestRegression_RpcResponse_UnknownKey(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid ok response",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_01","ok":true,"result":{"status":"ok"}}}`,
			wantErr: false,
		},
		{
			name:    "valid error response",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_02","ok":false,"error":{"code":"host_offline","message":"host offline","retryable":true}}}`,
			wantErr: false,
		},
		{
			name:    "unknown key in success payload",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_03","ok":true,"result":{"status":"ok"},"extraField":"illegal"}}`,
			wantErr: true,
		},
		{
			name:    "unknown key in error payload",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_04","ok":false,"error":{"code":"host_offline","message":"host offline","retryable":true},"unexpected":123}}`,
			wantErr: true,
		},
		{
			name:    "unknown key inside error object",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_5","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_05","ok":false,"error":{"code":"host_offline","message":"host offline","retryable":true,"forbiddenKey":true}}}`,
			wantErr: true,
		},
		{
			name:    "unknown key on envelope",
			json:    `{"v":1,"type":"rpc.response","id":"msg_resp_6","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_06","ok":true,"result":{}},"bogus":"extra"}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}
func TestRegression_Event_UnknownAndMissingFields(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid run.stream text",
			json:    `{"v":1,"type":"event","id":"msg_ev_1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"kind":"text","role":"assistant","content":"hello"}}}}`,
			wantErr: false,
		},
		{
			name:    "run.stream missing runId",
			json:    `{"v":1,"type":"event","id":"msg_ev_2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"item":{"kind":"text","role":"assistant","content":"hello"}}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream missing item",
			json:    `{"v":1,"type":"event","id":"msg_ev_3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01"}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream item missing kind",
			json:    `{"v":1,"type":"event","id":"msg_ev_4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"role":"assistant","content":"hello"}}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream item missing role",
			json:    `{"v":1,"type":"event","id":"msg_ev_5","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"kind":"text","content":"hello"}}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream item missing content",
			json:    `{"v":1,"type":"event","id":"msg_ev_6","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"kind":"text","role":"assistant"}}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream unknown field in data",
			json:    `{"v":1,"type":"event","id":"msg_ev_7","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"kind":"text","role":"assistant","content":"hi"},"bogus":"extra"}}}`,
			wantErr: true,
		},
		{
			name:    "run.stream item unknown field",
			json:    `{"v":1,"type":"event","id":"msg_ev_8","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"run.stream","data":{"runId":"run_01","item":{"kind":"text","role":"assistant","content":"hi","unexpected":1}}}}`,
			wantErr: true,
		},
		{
			name:    "valid terminal.output",
			json:    `{"v":1,"type":"event","id":"msg_ev_9","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"terminal.output","data":{"terminalId":"term_01","data":"ls\n","seq":1}}}`,
			wantErr: false,
		},
		{
			name:    "terminal.output missing terminalId",
			json:    `{"v":1,"type":"event","id":"msg_ev_10","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"terminal.output","data":{"data":"ls\n","seq":1}}}`,
			wantErr: true,
		},
		{
			name:    "terminal.output missing data",
			json:    `{"v":1,"type":"event","id":"msg_ev_11","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"terminal.output","data":{"terminalId":"term_01","seq":1}}}`,
			wantErr: true,
		},
		{
			name:    "terminal.output missing seq",
			json:    `{"v":1,"type":"event","id":"msg_ev_12","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"terminal.output","data":{"terminalId":"term_01","data":"ls\n"}}}`,
			wantErr: true,
		},
		{
			name:    "terminal.output unknown field in data",
			json:    `{"v":1,"type":"event","id":"msg_ev_13","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"terminal.output","data":{"terminalId":"term_01","data":"ls\n","seq":1,"extra":true}}}`,
			wantErr: true,
		},
		{
			name:    "event missing envelope seq",
			json:    `{"v":1,"type":"event","id":"msg_ev_14","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}}}`,
			wantErr: true,
		},
		{
			name:    "event missing envelope hostId",
			json:    `{"v":1,"type":"event","id":"msg_ev_15","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}}}`,
			wantErr: true,
		},
		{
			name:    "conversation.deleted missing conversationId",
			json:    `{"v":1,"type":"event","id":"msg_ev_16","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{}}}`,
			wantErr: true,
		},
		{
			name:    "conversation.deleted unknown field",
			json:    `{"v":1,"type":"event","id":"msg_ev_17","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01","extra":123}}}`,
			wantErr: true,
		},
		{
			name:    "unknown event name",
			json:    `{"v":1,"type":"event","id":"msg_ev_18","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"unregistered.event","data":{"foo":"bar"}}}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}

func TestRegression_Snapshot_NestedUnknownAndMissing(t *testing.T) {
	validSnapshotJSON := `{
		"v": 1,
		"type": "snapshot",
		"id": "msg_snap_001",
		"hostId": "host_01",
		"sentAt": "2026-09-01T10:00:00.000Z",
		"seq": 100,
		"payload": {
			"baseSeq": 100,
			"host": {
				"hostId": "host_01",
				"online": true,
				"appVersion": "0.9.10",
				"protocolVersion": 1,
				"remoteEnabled": true,
				"activeRunCount": 0,
				"pendingDecisionCount": 0,
				"activeTerminalCount": 0,
				"serverTime": "2026-09-01T10:00:00.000Z"
			},
			"projects": [
				{"projectId": "p1", "name": "Main Project", "updatedAt": "2026-09-01T10:00:00.000Z"}
			],
			"agents": [
				{"agentId": "a1", "name": "Coder", "available": true}
			],
			"conversations": [
				{"conversationId": "c1", "title": "Chat 1", "archived": false, "updatedAt": "2026-09-01T10:00:00.000Z"}
			]
		}
	}`

	t.Run("valid baseline snapshot", func(t *testing.T) {
		_, err := DecodeEnvelope([]byte(validSnapshotJSON))
		if err != nil {
			t.Fatalf("expected valid snapshot, got: %v", err)
		}
	})

	cases := []struct {
		name string
		json string
	}{
		{
			name: "snapshot missing baseSeq",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"}}}`,
		},
		{
			name: "snapshot missing host",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100}}`,
		},
		{
			name: "snapshot unknown key in payload",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"unknownField":123}}`,
		},
		{
			name: "snapshot host missing appVersion",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"}}}`,
		},
		{
			name: "snapshot host unknown field",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_5","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z","extraField":true}}}`,
		},
		{
			name: "snapshot project missing name",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_6","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"projects":[{"projectId":"p1","updatedAt":"2026-09-01T10:00:00.000Z"}]}}`,
		},
		{
			name: "snapshot project unknown field",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_7","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"projects":[{"projectId":"p1","name":"P1","updatedAt":"2026-09-01T10:00:00.000Z","extra":1}]}}`,
		},
		{
			name: "snapshot agent unknown field",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_8","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"agents":[{"agentId":"a1","name":"Agent 1","available":true,"bogus":"invalid"}]}}`,
		},
		{
			name: "snapshot conversation missing title",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_9","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"conversations":[{"conversationId":"c1","archived":false,"updatedAt":"2026-09-01T10:00:00.000Z"}]}}`,
		},
		{
			name: "snapshot activeRun missing conversationId",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_10","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"},"activeRuns":[{"runId":"r1","status":"running"}]}}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
		})
	}
}

func TestRegression_Snapshot_HostStatus_ServerTime(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name: "snapshot host with valid serverTime succeeds and preserves timestamp",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_st_1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"2026-09-01T10:00:00.000Z"}}}`,
			wantErr: false,
		},
		{
			name: "snapshot host without serverTime is rejected",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_st_2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0}}}`,
			wantErr: true,
		},
		{
			name: "snapshot host with null serverTime is rejected",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_st_3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":null}}}`,
			wantErr: true,
		},
		{
			name: "snapshot host with empty string serverTime is rejected",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_st_4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":""}}}`,
			wantErr: true,
		},
		{
			name: "snapshot host with invalid format serverTime is rejected",
			json: `{"v":1,"type":"snapshot","id":"msg_snap_st_5","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":100,"payload":{"baseSeq":100,"host":{"hostId":"host_01","online":true,"appVersion":"0.9.10","protocolVersion":1,"remoteEnabled":true,"activeRunCount":0,"pendingDecisionCount":0,"activeTerminalCount":0,"serverTime":"not-a-timestamp"}}}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
			if !tc.wantErr && env != nil {
				var payload SnapshotPayload
				if err := json.Unmarshal(env.Payload, &payload); err != nil {
					t.Fatalf("failed to unmarshal snapshot payload: %v", err)
				}
				if payload.Host.HostID != "host_01" {
					t.Fatalf("expected hostId host_01, got %s", payload.Host.HostID)
				}
				if payload.Host.ServerTime != "2026-09-01T10:00:00.000Z" {
					t.Fatalf("expected serverTime %q, got %q", "2026-09-01T10:00:00.000Z", payload.Host.ServerTime)
				}
			}
		})
	}

	t.Run("ValidateHostStatus directly rejects empty serverTime", func(t *testing.T) {
		h := HostStatus{
			HostID:               "host_01",
			Online:               true,
			AppVersion:           "0.9.10",
			ProtocolVersion:      1,
			RemoteEnabled:        true,
			ActiveRunCount:       0,
			PendingDecisionCount: 0,
			ActiveTerminalCount:  0,
			ServerTime:           "",
		}
		if err := ValidateHostStatus(h); err == nil {
			t.Fatal("expected ValidateHostStatus to reject empty serverTime")
		}
	})
}

func TestRegression_Resume_MissingAndInvalidFields(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid resume",
			json:    `{"v":1,"type":"resume","id":"msg_res_1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"resumeFrom":42}}`,
			wantErr: false,
		},
		{
			name:    "resume missing resumeFrom",
			json:    `{"v":1,"type":"resume","id":"msg_res_2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{}}`,
			wantErr: true,
		},
		{
			name:    "resume null resumeFrom",
			json:    `{"v":1,"type":"resume","id":"msg_res_3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"resumeFrom":null}}`,
			wantErr: true,
		},
		{
			name:    "resume unknown field in payload",
			json:    `{"v":1,"type":"resume","id":"msg_res_4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"resumeFrom":42,"extra":true}}`,
			wantErr: true,
		},
		{
			name:    "resume missing hostId on envelope",
			json:    `{"v":1,"type":"resume","id":"msg_res_5","sentAt":"2026-09-01T10:00:00.000Z","payload":{"resumeFrom":42}}`,
			wantErr: true,
		},
		{
			name:    "resume envelope contains seq",
			json:    `{"v":1,"type":"resume","id":"msg_res_6","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"resumeFrom":42}}`,
			wantErr: true,
		},
		{
			name:    "resume envelope contains expiresAt",
			json:    `{"v":1,"type":"resume","id":"msg_res_7","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z","payload":{"resumeFrom":42}}`,
			wantErr: true,
		},
		{
			name:    "resume negative resumeFrom",
			json:    `{"v":1,"type":"resume","id":"msg_res_8","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"resumeFrom":-1}}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}

func TestRegression_PingPong_EmptyNonce(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid ping with nonce",
			json:    `{"v":1,"type":"ping","id":"msg_ping_1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":"nonce_12345"}}`,
			wantErr: false,
		},
		{
			name:    "valid ping without nonce",
			json:    `{"v":1,"type":"ping","id":"msg_ping_2","sentAt":"2026-09-01T10:00:00.000Z","payload":{}}`,
			wantErr: false,
		},
		{
			name:    "ping with empty nonce (violates minLength 1)",
			json:    `{"v":1,"type":"ping","id":"msg_ping_3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":""}}`,
			wantErr: true,
		},
		{
			name:    "ping with null nonce",
			json:    `{"v":1,"type":"ping","id":"msg_ping_4","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":null}}`,
			wantErr: true,
		},
		{
			name:    "ping with unknown field",
			json:    `{"v":1,"type":"ping","id":"msg_ping_5","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":"abc","extra":1}}`,
			wantErr: true,
		},
		{
			name:    "valid pong with nonce",
			json:    `{"v":1,"type":"pong","id":"msg_pong_1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":"nonce_12345","serverTime":"2026-09-01T10:00:00.000Z"}}`,
			wantErr: false,
		},
		{
			name:    "valid pong without nonce",
			json:    `{"v":1,"type":"pong","id":"msg_pong_2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"serverTime":"2026-09-01T10:00:00.000Z"}}`,
			wantErr: false,
		},
		{
			name:    "pong with empty nonce (violates minLength 1)",
			json:    `{"v":1,"type":"pong","id":"msg_pong_3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":"","serverTime":"2026-09-01T10:00:00.000Z"}}`,
			wantErr: true,
		},
		{
			name:    "pong missing serverTime",
			json:    `{"v":1,"type":"pong","id":"msg_pong_4","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":"nonce_12345"}}`,
			wantErr: true,
		},
		{
			name:    "pong with null nonce",
			json:    `{"v":1,"type":"pong","id":"msg_pong_5","sentAt":"2026-09-01T10:00:00.000Z","payload":{"nonce":null,"serverTime":"2026-09-01T10:00:00.000Z"}}`,
			wantErr: true,
		},
		{
			name:    "pong with unknown field",
			json:    `{"v":1,"type":"pong","id":"msg_pong_6","sentAt":"2026-09-01T10:00:00.000Z","payload":{"serverTime":"2026-09-01T10:00:00.000Z","extra":1}}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}

func TestRegression_ServerDraining_MissingReconnectAfterMs(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid server.draining",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"shutdown","reconnectAfterMs":5000}}`,
			wantErr: false,
		},
		{
			name:    "server.draining missing reconnectAfterMs",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"shutdown"}}`,
			wantErr: true,
		},
		{
			name:    "server.draining missing reason",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reconnectAfterMs":5000}}`,
			wantErr: true,
		},
		{
			name:    "server.draining null reconnectAfterMs",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_4","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"shutdown","reconnectAfterMs":null}}`,
			wantErr: true,
		},
		{
			name:    "server.draining invalid reason",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_5","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"unknown_reason","reconnectAfterMs":5000}}`,
			wantErr: true,
		},
		{
			name:    "server.draining negative reconnectAfterMs",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_6","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"restart","reconnectAfterMs":-100}}`,
			wantErr: true,
		},
		{
			name:    "server.draining unknown field in payload",
			json:    `{"v":1,"type":"server.draining","id":"msg_drain_7","sentAt":"2026-09-01T10:00:00.000Z","payload":{"reason":"version","reconnectAfterMs":5000,"extra":123}}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}

func TestRegression_ExplicitEmptyAndNullFields(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		// Ping frame
		{
			name:    "ping with forbidden hostId empty string",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e1","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"hostId":""}`,
			wantErr: true,
		},
		{
			name:    "ping with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e2","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "ping with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e3","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "ping with forbidden seq zero",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e4","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"seq":0}`,
			wantErr: true,
		},
		{
			name:    "ping with null meta",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e5","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"meta":null}`,
			wantErr: true,
		},
		{
			name:    "ping with null hostId",
			json:    `{"v":1,"type":"ping","id":"msg_ping_e6","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"hostId":null}`,
			wantErr: true,
		},
		{
			name:    "ping with valid meta object",
			json:    `{"v":1,"type":"ping","id":"msg_ping_ok1","sentAt":"2026-09-01T10:00:00.000Z","payload":{},"meta":{"traceId":"t_01"}}`,
			wantErr: false,
		},

		// Challenge frame
		{
			name:    "challenge with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"challenge","id":"msg_ch_e1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","challenge":"c_1234567890123456789012345678901234567890123","issuedAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z"},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "challenge with forbidden hostId empty string",
			json:    `{"v":1,"type":"challenge","id":"msg_ch_e2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","challenge":"c_1234567890123456789012345678901234567890123","issuedAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z"},"hostId":""}`,
			wantErr: true,
		},
		{
			name:    "challenge with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"challenge","id":"msg_ch_e3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","challenge":"c_1234567890123456789012345678901234567890123","issuedAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z"},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "challenge with null meta",
			json:    `{"v":1,"type":"challenge","id":"msg_ch_e4","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","challenge":"c_1234567890123456789012345678901234567890123","issuedAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z"},"meta":null}`,
			wantErr: true,
		},

		// Auth.ok frame
		{
			name:    "auth.ok with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "auth.ok with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "auth.ok with forbidden seq zero",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}},"seq":0}`,
			wantErr: true,
		},
		{
			name:    "auth.ok with explicit empty hostId string",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e4","hostId":"","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}}}`,
			wantErr: true,
		},
		{
			name:    "auth.ok with null hostId",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e5","hostId":null,"sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}}}`,
			wantErr: true,
		},
		{
			name:    "auth.ok with null meta",
			json:    `{"v":1,"type":"auth.ok","id":"msg_aok_e6","sentAt":"2026-09-01T10:00:00.000Z","payload":{"connectionId":"conn_01","role":"admin","serverTime":"2026-09-01T10:00:00.000Z","limits":{"maxFrameBytes":262144,"maxChunkBytes":32768,"maxConcurrentRpcs":16,"rpcReadTimeoutMs":15000,"rpcWriteTimeoutMs":30000,"heartbeatIntervalMs":30000,"challengeTtlMs":60000}},"meta":null}`,
			wantErr: true,
		},

		// HostAuth frame
		{
			name:    "host.auth with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"host.auth","id":"msg_ha_e1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"hostId":"host_01","keyId":"k_01","publicKey":"1111111111111111111111111111111111111111111","signature":"11111111111111111111111111111111111111111111111111111111111111111111111111111111111111","clientVersion":"1.0.0","protocolVersion":1},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "host.auth with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"host.auth","id":"msg_ha_e2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"hostId":"host_01","keyId":"k_01","publicKey":"1111111111111111111111111111111111111111111","signature":"11111111111111111111111111111111111111111111111111111111111111111111111111111111111111","clientVersion":"1.0.0","protocolVersion":1},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "host.auth with null meta",
			json:    `{"v":1,"type":"host.auth","id":"msg_ha_e3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"hostId":"host_01","keyId":"k_01","publicKey":"1111111111111111111111111111111111111111111","signature":"11111111111111111111111111111111111111111111111111111111111111111111111111111111111111","clientVersion":"1.0.0","protocolVersion":1},"meta":null}`,
			wantErr: true,
		},

		// AdminAuth frame
		{
			name:    "admin.auth with forbidden hostId empty string",
			json:    `{"v":1,"type":"admin.auth","id":"msg_aa_e1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"accessToken":"token_12345678901234567890123456789012","clientVersion":"1.0.0","protocolVersion":1},"hostId":""}`,
			wantErr: true,
		},
		{
			name:    "admin.auth with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"admin.auth","id":"msg_aa_e2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"accessToken":"token_12345678901234567890123456789012","clientVersion":"1.0.0","protocolVersion":1},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "admin.auth with null meta",
			json:    `{"v":1,"type":"admin.auth","id":"msg_aa_e3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"accessToken":"token_12345678901234567890123456789012","clientVersion":"1.0.0","protocolVersion":1},"meta":null}`,
			wantErr: true,
		},

		// RpcRequest frame
		{
			name:    "rpc.request read method with empty expiresAt string",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","expiresAt":"","payload":{"method":"host.status","params":{}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request read method with empty idempotencyKey string",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","idempotencyKey":"","payload":{"method":"host.status","params":{}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request read method with null expiresAt",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","expiresAt":null,"payload":{"method":"host.status","params":{}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request read method with null idempotencyKey",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","idempotencyKey":null,"payload":{"method":"host.status","params":{}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request write method with empty expiresAt string",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e5","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","expiresAt":"","idempotencyKey":"idemp_1234567890123456789012","payload":{"method":"run.stop","params":{"runId":"run_01"}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request write method with empty idempotencyKey string",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e6","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","expiresAt":"2026-09-01T10:05:00.000Z","idempotencyKey":"","payload":{"method":"run.stop","params":{"runId":"run_01"}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request with forbidden seq zero",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e7","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":0,"payload":{"method":"host.status","params":{}}}`,
			wantErr: true,
		},
		{
			name:    "rpc.request with null meta",
			json:    `{"v":1,"type":"rpc.request","id":"msg_rpc_e8","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"method":"host.status","params":{}},"meta":null}`,
			wantErr: true,
		},

		// RpcResponse frame
		{
			name:    "rpc.response with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"rpc.response","id":"msg_rr_e1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_01","ok":true,"result":{}},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "rpc.response with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"rpc.response","id":"msg_rr_e2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_01","ok":true,"result":{}},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "rpc.response with null meta",
			json:    `{"v":1,"type":"rpc.response","id":"msg_rr_e3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","payload":{"requestId":"req_01","ok":true,"result":{}},"meta":null}`,
			wantErr: true,
		},

		// Event frame
		{
			name:    "event with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"event","id":"msg_ev_e1","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "event with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"event","id":"msg_ev_e2","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "event with null seq",
			json:    `{"v":1,"type":"event","id":"msg_ev_e3","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":null,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}}}`,
			wantErr: true,
		},
		{
			name:    "event with null meta",
			json:    `{"v":1,"type":"event","id":"msg_ev_e4","hostId":"host_01","sentAt":"2026-09-01T10:00:00.000Z","seq":1,"payload":{"name":"conversation.deleted","data":{"conversationId":"conv_01"}},"meta":null}`,
			wantErr: true,
		},

		// Error frame
		{
			name:    "error with forbidden expiresAt empty string",
			json:    `{"v":1,"type":"error","id":"msg_err_e1","sentAt":"2026-09-01T10:00:00.000Z","payload":{"code":"unauthorized","message":"auth required","retryable":false},"expiresAt":""}`,
			wantErr: true,
		},
		{
			name:    "error with forbidden idempotencyKey empty string",
			json:    `{"v":1,"type":"error","id":"msg_err_e2","sentAt":"2026-09-01T10:00:00.000Z","payload":{"code":"unauthorized","message":"auth required","retryable":false},"idempotencyKey":""}`,
			wantErr: true,
		},
		{
			name:    "error with forbidden seq zero",
			json:    `{"v":1,"type":"error","id":"msg_err_e3","sentAt":"2026-09-01T10:00:00.000Z","payload":{"code":"unauthorized","message":"auth required","retryable":false},"seq":0}`,
			wantErr: true,
		},
		{
			name:    "error with explicit empty hostId string",
			json:    `{"v":1,"type":"error","id":"msg_err_e4","hostId":"","sentAt":"2026-09-01T10:00:00.000Z","payload":{"code":"unauthorized","message":"auth required","retryable":false}}`,
			wantErr: true,
		},
		{
			name:    "error with null meta",
			json:    `{"v":1,"type":"error","id":"msg_err_e5","sentAt":"2026-09-01T10:00:00.000Z","payload":{"code":"unauthorized","message":"auth required","retryable":false},"meta":null}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.json))
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, but DecodeEnvelope succeeded", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected success for %s, got error: %v", tc.name, err)
			}
		})
	}
}
