package wsconn

import (
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
)

func TestWSConn_SendQueueAndBackpressure(t *testing.T) {
	logger := slog.Default()
	queueSize := 4

	c := NewWSConn(nil, Config{
		MaxSendQueueSize: queueSize,
		Logger:           logger,
	})

	dummyEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypePing,
		ID:      "msg_test_001",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{}`),
	}

	// Send up to queue size
	for i := 0; i < queueSize; i++ {
		if err := c.SendEnvelope(dummyEnv); err != nil {
			t.Fatalf("expected send %d to succeed, got %v", i, err)
		}
	}

	// Sending one more must trigger backpressure and fail
	err := c.SendEnvelope(dummyEnv)
	if err == nil || !errors.Is(err, ErrBackpressure) {
		t.Fatalf("expected ErrBackpressure on queue overflow, got %v", err)
	}

	// Connection context must now be canceled
	select {
	case <-c.Context().Done():
		// OK
	case <-time.After(100 * time.Millisecond):
		t.Fatal("expected connection context to be canceled on backpressure")
	}
}

func TestWSConn_IDGeneration(t *testing.T) {
	id1 := GenerateConnectionID()
	id2 := GenerateConnectionID()
	if id1 == id2 {
		t.Fatalf("expected unique connection IDs, got %s and %s", id1, id2)
	}
	if len(id1) < 10 {
		t.Fatalf("connection ID too short: %s", id1)
	}
}

func TestWSConn_StartHeartbeat_EdgeCases(t *testing.T) {
	logger := slog.Default()

	// 1. Nil websocket conn
	c := NewWSConn(nil, Config{Logger: logger})
	c.StartHeartbeat(10*time.Millisecond, 5*time.Millisecond) // Should safely do nothing
	c.StartHeartbeat(0, 0)                                    // Invalid intervals

	// 2. Closed connection
	c2 := NewWSConn(nil, Config{Logger: logger})
	c2.Close(1000, "normal")
	c2.StartHeartbeat(10*time.Millisecond, 5*time.Millisecond) // Should not start on closed
}
