package router

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/registry"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/wsconn"
)

func setupTestRouter(t *testing.T) (*Router, *registry.Registry) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.RPCTimeout = 200 * time.Millisecond
	logger := slog.Default()
	auditLogger := audit.NewLogger(logger)
	reg := registry.New(logger, auditLogger)
	rtr := New(cfg, reg, logger, auditLogger)
	return rtr, reg
}

func TestRouter_HandleAdminPing(t *testing.T) {
	rtr, _ := setupTestRouter(t)
	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	pingEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypePing,
		ID:      "ping_001",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"nonce":"nonce123"}`),
	}

	err := rtr.HandleAdminFrame(adminConn, pingEnv)
	if err != nil {
		t.Fatalf("expected ping handling to succeed, got %v", err)
	}
}

func TestRouter_AdminRpcRequest_TargetHostOffline(t *testing.T) {
	rtr, _ := setupTestRouter(t)
	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	rpcEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      "req_test_001",
		HostID:  "host_offline_id",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	err := rtr.HandleAdminFrame(adminConn, rpcEnv)
	if err != nil {
		t.Fatalf("expected handler to complete, got %v", err)
	}

	// Should not have registered in pending
	rtr.pendingMu.Lock()
	_, found := rtr.pending["req_test_001"]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected no pending RPC for offline host")
	}
}

func TestRouter_AdminRpcRequest_Expired(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_online_id"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	expiredTime := time.Now().Add(-5 * time.Second).UTC().Format(time.RFC3339Nano)
	rpcEnv := &protocol.Envelope{
		V:              1,
		Type:           protocol.FrameTypeRpcRequest,
		ID:             "req_test_expired",
		HostID:         hostID,
		SentAt:         time.Now().UTC().Format(time.RFC3339Nano),
		ExpiresAt:      expiredTime,
		IdempotencyKey: "idempotency_key_test_12345678",
		Payload:        json.RawMessage(`{"method":"conversation.create","params":{}}`),
	}

	err := rtr.HandleAdminFrame(adminConn, rpcEnv)
	if err != nil {
		t.Fatalf("expected handler to complete, got %v", err)
	}

	rtr.pendingMu.Lock()
	_, found := rtr.pending["req_test_expired"]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected expired RPC not to be registered in pending")
	}
}

func TestRouter_AdminRpcRequest_SuccessAndResponse(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_active_01"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	reqID := "req_roundtrip_001"
	rpcReqEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	err := rtr.HandleAdminFrame(adminConn, rpcReqEnv)
	if err != nil {
		t.Fatalf("expected handleAdminRpcRequest to succeed, got %v", err)
	}

	rtr.pendingMu.Lock()
	pRPC, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if !found || pRPC == nil {
		t.Fatal("expected pending RPC to be registered")
	}

	// Host sends back rpc.response
	rpcRespEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      "msg_resp_001",
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"requestId":"req_roundtrip_001","ok":true,"result":{"conversations":[]}}`),
	}

	err = rtr.HandleHostFrame(hostConn, rpcRespEnv)
	if err != nil {
		t.Fatalf("expected HandleHostFrame to succeed, got %v", err)
	}

	rtr.pendingMu.Lock()
	_, found = rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected pending RPC to be deleted after response")
	}
}

func TestRouter_RPCTimeout(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	rtr.cfg.RPCTimeout = 50 * time.Millisecond

	hostID := "host_timeout_01"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	reqID := "req_will_timeout_001"
	rpcReqEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	_ = rtr.HandleAdminFrame(adminConn, rpcReqEnv)

	// Wait for timeout
	time.Sleep(120 * time.Millisecond)

	rtr.pendingMu.Lock()
	_, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected pending RPC to be cleaned up after timeout")
	}
}

func TestRouter_OnHostDisconnect_CleansPending(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_disconnect_01"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	reqID := "req_host_disc_001"
	rpcReqEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	_ = rtr.HandleAdminFrame(adminConn, rpcReqEnv)

	// Disconnect host
	rtr.OnHostDisconnect(hostID, hostConn)

	rtr.pendingMu.Lock()
	_, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected pending RPC to be cleaned up on host disconnect")
	}
}

func TestRouter_OnAdminDisconnect_CleansPending(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_admin_disc_01"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	reqID := "req_admin_disc_001"
	rpcReqEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	_ = rtr.HandleAdminFrame(adminConn, rpcReqEnv)

	// Disconnect admin
	rtr.OnAdminDisconnect(adminConn)

	rtr.pendingMu.Lock()
	_, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected pending RPC to be cleaned up on admin disconnect")
	}
}

func TestRouter_HandleHostFrame_SpoofedHostID(t *testing.T) {
	rtr, _ := setupTestRouter(t)
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID("host_real_01")

	spoofedEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypePing,
		ID:      "msg_spoof_001",
		HostID:  "host_fake_01",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{}`),
	}

	err := rtr.HandleHostFrame(hostConn, spoofedEnv)
	if err == nil {
		t.Fatal("expected error on spoofed hostId")
	}
}

func TestRouter_HandleHostEvent_Broadcast(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_event_src"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	admin1 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin1.SetRole(protocol.RoleAdmin)
	admin2 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin2.SetRole(protocol.RoleAdmin)

	reg.RegisterAdmin(admin1)
	reg.RegisterAdmin(admin2)

	seq := int64(1)
	eventEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      "ev_001",
		HostID:  hostID,
		Seq:     &seq,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"name":"message.created","data":{"messageId":"m1"}}`),
	}

	err := rtr.HandleHostFrame(hostConn, eventEnv)
	if err != nil {
		t.Fatalf("expected host event handling to succeed, got %v", err)
	}
}

func TestRouter_HandleAdminUnexpectedFrame(t *testing.T) {
	rtr, _ := setupTestRouter(t)
	adminConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	adminConn.SetRole(protocol.RoleAdmin)

	seq := int64(1)
	illegalEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      "ev_from_admin",
		HostID:  "host_01",
		Seq:     &seq,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"name":"message.created","data":{}}`),
	}

	err := rtr.HandleAdminFrame(adminConn, illegalEnv)
	if err == nil {
		t.Fatal("expected error when admin sends event frame")
	}
}

func TestRouter_AdminRpcRequest_DuplicateActiveID_Rejected(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_active_01"
	hostConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	hostConn.SetRole(protocol.RoleHost)
	hostConn.SetHostID(hostID)
	reg.RegisterHost(hostID, hostConn)

	admin1 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin1.SetRole(protocol.RoleAdmin)
	admin2 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin2.SetRole(protocol.RoleAdmin)

	reqID := "req_dup_unit_001"
	req1 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	err := rtr.HandleAdminFrame(admin1, req1)
	if err != nil {
		t.Fatalf("first rpc request should succeed, got %v", err)
	}

	// Second request with same reqID from another admin
	req2 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.get","params":{}}`),
	}
	err = rtr.HandleAdminFrame(admin2, req2)
	if err != nil {
		t.Fatalf("handler should complete without crashing, got %v", err)
	}

	// First pending RPC should still be intact and point to admin1
	rtr.pendingMu.Lock()
	pRPC, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if !found || pRPC.AdminConn != admin1 {
		t.Fatalf("expected original pending RPC to remain bound to admin1")
	}
}

func TestRouter_HandleHostFrame_StaleConnectionDiscarded(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_replaced_01"

	oldConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	oldConn.SetRole(protocol.RoleHost)
	oldConn.SetHostID(hostID)
	reg.RegisterHost(hostID, oldConn)

	newConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	newConn.SetRole(protocol.RoleHost)
	newConn.SetHostID(hostID)
	reg.RegisterHost(hostID, newConn)

	// oldConn attempts to send an event
	seq := int64(10)
	staleEvent := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      "ev_stale",
		HostID:  hostID,
		Seq:     &seq,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"name":"test","data":{}}`),
	}

	err := rtr.HandleHostFrame(oldConn, staleEvent)
	if err != nil {
		t.Fatalf("expected stale frame to be discarded cleanly, got %v", err)
	}
}

func TestRouter_HostReplacement_OldDisconnectDoesNotCleanNewHostPending(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_swap_01"

	host1 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	host1.SetRole(protocol.RoleHost)
	host1.SetHostID(hostID)
	reg.RegisterHost(hostID, host1)

	// Host 2 connects and replaces Host 1
	host2 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	host2.SetRole(protocol.RoleHost)
	host2.SetHostID(hostID)
	reg.RegisterHost(hostID, host2)

	// Admin sends RPC to Host 2
	admin := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin.SetRole(protocol.RoleAdmin)

	reqID := "req_for_host2"
	req := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	_ = rtr.HandleAdminFrame(admin, req)

	// Host 1 terminates and cleans up
	rtr.OnHostDisconnect(hostID, host1)

	// The pending RPC for host 2 MUST still exist!
	rtr.pendingMu.Lock()
	pRPC, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if !found || pRPC.HostConn != host2 {
		t.Fatalf("pending RPC on host2 must not be cleaned up by host1 exit")
	}

	// Host 2 responds successfully
	resp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      "resp_001",
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{}}`, reqID)),
	}
	err := rtr.HandleHostFrame(host2, resp)
	if err != nil {
		t.Fatalf("expected host2 response to succeed, got %v", err)
	}

	// Now pending map is clean
	rtr.pendingMu.Lock()
	_, found = rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if found {
		t.Fatal("expected pending RPC to be deleted after host2 response")
	}
}

func TestRouter_HandleHostFrame_StaleConnectionAllFrameTypesDiscarded(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_stale_all_01"

	admin := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin.SetRole(protocol.RoleAdmin)
	reg.RegisterAdmin(admin)

	oldConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	oldConn.SetRole(protocol.RoleHost)
	oldConn.SetHostID(hostID)
	reg.RegisterHost(hostID, oldConn)

	newConn := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	newConn.SetRole(protocol.RoleHost)
	newConn.SetHostID(hostID)
	reg.RegisterHost(hostID, newConn)

	// Admin sends RPC targeted to active host (newConn)
	reqID := "req_for_new_host"
	req := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	_ = rtr.HandleAdminFrame(admin, req)

	// 1. oldConn sends rpc.response -> must be discarded and NOT satisfy reqID
	staleResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      "resp_stale",
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"stale":true}}`, reqID)),
	}
	err := rtr.HandleHostFrame(oldConn, staleResp)
	if err != nil {
		t.Fatalf("expected stale rpc.response to be discarded without error, got %v", err)
	}
	rtr.pendingMu.Lock()
	pRPC, found := rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if !found || pRPC.HostConn != newConn {
		t.Fatal("pending RPC on new host must not be modified or removed by stale rpc.response")
	}

	// 2. oldConn sends event -> must be discarded
	seq := int64(1)
	staleEvent := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      "ev_stale",
		HostID:  hostID,
		Seq:     &seq,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"name":"test.event","data":{}}`),
	}
	err = rtr.HandleHostFrame(oldConn, staleEvent)
	if err != nil {
		t.Fatalf("expected stale event to be discarded without error, got %v", err)
	}

	// 3. oldConn sends snapshot -> must be discarded
	staleSnapshot := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeSnapshot,
		ID:      "snap_stale",
		HostID:  hostID,
		Seq:     &seq,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"snapshotId":"s1"}`),
	}
	err = rtr.HandleHostFrame(oldConn, staleSnapshot)
	if err != nil {
		t.Fatalf("expected stale snapshot to be discarded without error, got %v", err)
	}

	// 4. oldConn sends error -> must be discarded and NOT cancel pending RPC
	staleErr := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeError,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"code":"internal_error","message":"stale error","retryable":false}`),
	}
	err = rtr.HandleHostFrame(oldConn, staleErr)
	if err != nil {
		t.Fatalf("expected stale error to be discarded without error, got %v", err)
	}
	rtr.pendingMu.Lock()
	_, found = rtr.pending[reqID]
	rtr.pendingMu.Unlock()
	if !found {
		t.Fatal("pending RPC on new host must not be cancelled by stale error frame")
	}
}

func TestRouter_HostReplacement_OldDisconnectCleansOldPendingAndKeepsNewPending(t *testing.T) {
	rtr, reg := setupTestRouter(t)
	hostID := "host_swap_02"

	host1 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	host1.SetRole(protocol.RoleHost)
	host1.SetHostID(hostID)
	reg.RegisterHost(hostID, host1)

	admin := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	admin.SetRole(protocol.RoleAdmin)
	reg.RegisterAdmin(admin)

	// Admin sends reqOld targeted to host1
	reqOldID := "req_for_host1"
	reqOld := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqOldID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	_ = rtr.HandleAdminFrame(admin, reqOld)

	// Host 2 connects and replaces Host 1
	host2 := wsconn.NewWSConn(nil, wsconn.Config{MaxSendQueueSize: 10})
	host2.SetRole(protocol.RoleHost)
	host2.SetHostID(hostID)
	reg.RegisterHost(hostID, host2)

	// Admin sends reqNew targeted to host2
	reqNewID := "req_for_host2"
	reqNew := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqNewID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.get","params":{"id":"c1"}}`),
	}
	_ = rtr.HandleAdminFrame(admin, reqNew)

	// Host 1 terminates and cleans up
	rtr.OnHostDisconnect(hostID, host1)

	// reqOld MUST be cleaned up from pending
	rtr.pendingMu.Lock()
	_, oldFound := rtr.pending[reqOldID]
	pRPCNew, newFound := rtr.pending[reqNewID]
	rtr.pendingMu.Unlock()

	if oldFound {
		t.Fatalf("reqOld targeting host1 should have been cleaned up on host1 disconnect")
	}
	if !newFound || pRPCNew.HostConn != host2 {
		t.Fatalf("reqNew targeting host2 must remain active in pending")
	}

	// Host 2 responds successfully for reqNew
	respNew := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      "resp_new_01",
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"done":true}}`, reqNewID)),
	}
	err := rtr.HandleHostFrame(host2, respNew)
	if err != nil {
		t.Fatalf("expected host2 response to succeed, got %v", err)
	}

	// Pending map should now be completely clean
	rtr.pendingMu.Lock()
	_, finalFound := rtr.pending[reqNewID]
	rtr.pendingMu.Unlock()
	if finalFound {
		t.Fatal("expected pending RPC reqNew to be deleted after host2 response")
	}
}
