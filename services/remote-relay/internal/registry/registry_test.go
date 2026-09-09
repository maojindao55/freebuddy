package registry

import (
	"log/slog"
	"sync"
	"testing"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/wsconn"
)

func TestRegistry_HostLifecycleAndReplacement(t *testing.T) {
	logger := slog.Default()
	auditLog := audit.NewLogger(logger)
	reg := New(logger, auditLog)

	hostID := "host_test_001"

	// Mock connections
	c1 := wsconn.NewWSConn(nil, wsconn.Config{})
	c1.SetRole("host")
	c1.SetHostID(hostID)

	c2 := wsconn.NewWSConn(nil, wsconn.Config{})
	c2.SetRole("host")
	c2.SetHostID(hostID)

	// 1. Initial registration
	old := reg.RegisterHost(hostID, c1)
	if old != nil {
		t.Fatalf("expected nil old connection on first register, got %v", old)
	}
	if !reg.IsHostOnline(hostID) {
		t.Fatalf("expected host %s to be online", hostID)
	}
	retrieved, ok := reg.GetHost(hostID)
	if !ok || retrieved != c1 {
		t.Fatalf("expected retrieved host connection to match c1")
	}

	// 2. Replacement
	old = reg.RegisterHost(hostID, c2)
	if old != c1 {
		t.Fatalf("expected old connection to be c1, got %v", old)
	}
	retrieved, ok = reg.GetHost(hostID)
	if !ok || retrieved != c2 {
		t.Fatalf("expected retrieved host connection to match c2")
	}

	// 3. Stale unregister of c1 should NOT remove c2
	unreg := reg.UnregisterHost(hostID, c1)
	if unreg {
		t.Fatalf("expected unregister of old c1 to return false")
	}
	if !reg.IsHostOnline(hostID) {
		t.Fatalf("expected host %s to still be online with c2", hostID)
	}

	// 4. Proper unregister of c2
	unreg = reg.UnregisterHost(hostID, c2)
	if !unreg {
		t.Fatalf("expected unregister of c2 to return true")
	}
	if reg.IsHostOnline(hostID) {
		t.Fatalf("expected host %s to be offline after unregister", hostID)
	}
}

func TestRegistry_AdminLifecycle(t *testing.T) {
	logger := slog.Default()
	reg := New(logger, nil)

	c1 := wsconn.NewWSConn(nil, wsconn.Config{})
	c2 := wsconn.NewWSConn(nil, wsconn.Config{})

	reg.RegisterAdmin(c1)
	reg.RegisterAdmin(c2)

	admins := reg.GetAdmins()
	if len(admins) != 2 {
		t.Fatalf("expected 2 admins, got %d", len(admins))
	}

	reg.UnregisterAdmin(c1)
	admins = reg.GetAdmins()
	if len(admins) != 1 || admins[0] != c2 {
		t.Fatalf("expected 1 admin (c2), got %d", len(admins))
	}
}

func TestRegistry_ConcurrentAccess(t *testing.T) {
	logger := slog.Default()
	reg := New(logger, nil)

	var wg sync.WaitGroup
	const numGoroutines = 50

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			conn := wsconn.NewWSConn(nil, wsconn.Config{})
			hostID := "host_concurrent"

			old := reg.RegisterHost(hostID, conn)
			_ = old

			_ = reg.IsHostOnline(hostID)
			_, _ = reg.GetHost(hostID)

			reg.RegisterAdmin(conn)
			_ = reg.GetAdmins()

			reg.UnregisterAdmin(conn)
			reg.UnregisterHost(hostID, conn)
		}(i)
	}

	wg.Wait()
}
