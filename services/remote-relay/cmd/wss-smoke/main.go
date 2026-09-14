package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/safeenv"
)

var highEntropyTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,512}$`)

type smokeConfig struct {
	baseURL         string
	adminToken      string
	hostToken       string
	hostID          string
	payloadSentinel string
	eventCount      int
	timeout         time.Duration
	allowLoopbackWS bool
	envFile         string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "relay smoke failed:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := smokeConfig{}
	flag.StringVar(&cfg.baseURL, "base-url", firstNonEmpty(os.Getenv("RELAY_PUBLIC_BASE_URL"), os.Getenv("PUBLIC_BASE_URL")), "public HTTPS/WSS or loopback relay base URL")
	flag.StringVar(&cfg.hostID, "host-id", firstNonEmpty(os.Getenv("SMOKE_HOST_ID"), os.Getenv("DEV_AUTH_HOST_ID")), "test host ID")
	flag.IntVar(&cfg.eventCount, "events", 1000, "ordered event count")
	flag.DurationVar(&cfg.timeout, "timeout", 60*time.Second, "overall smoke timeout")
	flag.BoolVar(&cfg.allowLoopbackWS, "allow-loopback-ws", parseBoolEnv(os.Getenv("ALLOW_LOOPBACK_WS")), "allow unencrypted ws:// connection strictly to IP literal loopback addresses (127.0.0.1, ::1) without following redirects")
	flag.StringVar(&cfg.envFile, "env-file", os.Getenv("RELAY_ENV_FILE"), "optional path to 0600 environment file to load tokens securely without argv exposure")
	flag.Parse()

	if cfg.envFile != "" {
		if err := loadTokensFromEnvFile(cfg.envFile, &cfg); err != nil {
			return fmt.Errorf("load env file: %w", err)
		}
	}

	if cfg.adminToken == "" {
		cfg.adminToken = firstNonEmpty(os.Getenv("SMOKE_ADMIN_TOKEN"), os.Getenv("DEV_AUTH_ADMIN_TOKEN"))
	}
	if cfg.hostToken == "" {
		cfg.hostToken = firstNonEmpty(os.Getenv("SMOKE_HOST_TOKEN"), os.Getenv("DEV_AUTH_HOST_TOKEN"))
	}
	if cfg.hostID == "" {
		cfg.hostID = firstNonEmpty(os.Getenv("SMOKE_HOST_ID"), os.Getenv("DEV_AUTH_HOST_ID"), "host_dev")
	}
	if cfg.payloadSentinel == "" {
		cfg.payloadSentinel = firstNonEmpty(os.Getenv("SMOKE_PAYLOAD_SENTINEL"), "m2-smoke-payload")
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.timeout)
	defer cancel()
	if err := runSmoke(ctx, cfg, http.DefaultClient); err != nil {
		return err
	}

	fmt.Printf("relay smoke passed: health=ok ready=ready rpc=1 events=%d\n", cfg.eventCount)
	return nil
}

func runSmoke(ctx context.Context, cfg smokeConfig, httpClient *http.Client) error {
	if err := validateSmokeConfig(cfg); err != nil {
		return err
	}
	wsBase, httpBase, err := parseBaseURLs(cfg.baseURL, cfg.allowLoopbackWS)
	if err != nil {
		return err
	}

	client := createHTTPClient(httpClient, cfg.timeout)

	if err := checkHealthAndReady(ctx, client, httpBase); err != nil {
		return fmt.Errorf("health/ready verification failed: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}

	host, err := dialAuthenticated(ctx, client, wsBase, "/v1/ws/host", cfg.hostToken, cfg.hostID, protocol.RoleHost)
	if err != nil {
		return fmt.Errorf("host authentication: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}
	defer host.Close(websocket.StatusNormalClosure, "smoke_complete")

	admin, err := dialAuthenticated(ctx, client, wsBase, "/v1/ws/admin", cfg.adminToken, "", protocol.RoleAdmin)
	if err != nil {
		return fmt.Errorf("admin authentication: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}
	defer admin.Close(websocket.StatusNormalClosure, "smoke_complete")

	requestID := "m2_smoke_rpc_1"
	requestMethod := "conversation.list"
	requestParams := json.RawMessage(`{}`)
	requestPayload, err := json.Marshal(protocol.RpcRequestPayload{
		Method: requestMethod,
		Params: requestParams,
	})
	if err != nil {
		return sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
	}
	request := &protocol.Envelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      requestID,
		HostID:  cfg.hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: requestPayload,
	}
	if err := writeEnvelope(ctx, admin, request); err != nil {
		return fmt.Errorf("admin rpc.request: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}

	forwarded, err := readEnvelope(ctx, host)
	if err != nil {
		return fmt.Errorf("host receive rpc.request: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}
	if err := verifyRPCRequest(forwarded, requestID, cfg.hostID, requestMethod, requestParams); err != nil {
		return fmt.Errorf("host verify rpc.request: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}

	responseID := "m2_smoke_response_1"
	expectedResult := json.RawMessage(`{"items":[],"nextCursor":null}`)
	responsePayload, err := json.Marshal(protocol.RpcResponsePayload{
		RequestID: requestID,
		Ok:        true,
		Result:    expectedResult,
	})
	if err != nil {
		return sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
	}
	response := &protocol.Envelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      responseID,
		HostID:  cfg.hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: responsePayload,
	}
	if err := writeEnvelope(ctx, host, response); err != nil {
		return fmt.Errorf("host rpc.response: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}

	routedResponse, err := readEnvelope(ctx, admin)
	if err != nil {
		return fmt.Errorf("admin receive rpc.response: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}
	if err := verifyRPCResponse(routedResponse, responseID, cfg.hostID, requestID, expectedResult); err != nil {
		return fmt.Errorf("admin verify rpc.response: %w", sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken))
	}

	if err := verifyOrderedEvents(ctx, host, admin, cfg); err != nil {
		return sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
	}

	return nil
}

func verifyRPCRequest(env *protocol.Envelope, expectedID, expectedHostID, expectedMethod string, expectedParams json.RawMessage) error {
	if env == nil {
		return errors.New("received nil rpc.request envelope")
	}
	if env.V != protocol.ProtocolVersion {
		return fmt.Errorf("mismatched protocol version %d (expected %d)", env.V, protocol.ProtocolVersion)
	}
	if env.Type != protocol.FrameTypeRpcRequest {
		return fmt.Errorf("expected frame type %s, got %s", protocol.FrameTypeRpcRequest, env.Type)
	}
	if env.ID != expectedID {
		return fmt.Errorf("mismatched rpc.request id %q (expected %q)", env.ID, expectedID)
	}
	if env.HostID != expectedHostID {
		return fmt.Errorf("mismatched rpc.request hostId %q (expected %q)", env.HostID, expectedHostID)
	}
	if err := protocol.ValidateTimestamp(env.SentAt); err != nil {
		return fmt.Errorf("invalid rpc.request sentAt: %w", err)
	}
	var reqPayload protocol.RpcRequestPayload
	if err := json.Unmarshal(env.Payload, &reqPayload); err != nil {
		return fmt.Errorf("decode rpc.request payload: %w", err)
	}
	if reqPayload.Method != expectedMethod {
		return fmt.Errorf("mismatched rpc.request method %q (expected %q)", reqPayload.Method, expectedMethod)
	}
	if len(expectedParams) > 0 {
		var actualMap, expectedMap map[string]interface{}
		if err := json.Unmarshal(reqPayload.Params, &actualMap); err != nil {
			return fmt.Errorf("decode rpc.request params: %w", err)
		}
		if err := json.Unmarshal(expectedParams, &expectedMap); err != nil {
			return fmt.Errorf("decode expected rpc.request params: %w", err)
		}
		if !reflect.DeepEqual(actualMap, expectedMap) {
			return errors.New("mismatched rpc.request params")
		}
	}
	return nil
}

func verifyRPCResponse(env *protocol.Envelope, expectedEnvelopeID, expectedHostID, expectedRequestID string, expectedResult json.RawMessage) error {
	if env == nil {
		return errors.New("received nil rpc.response envelope")
	}
	if env.V != protocol.ProtocolVersion {
		return fmt.Errorf("mismatched protocol version %d (expected %d)", env.V, protocol.ProtocolVersion)
	}
	if env.Type != protocol.FrameTypeRpcResponse {
		return fmt.Errorf("expected frame type %s, got %s", protocol.FrameTypeRpcResponse, env.Type)
	}
	if env.ID != expectedEnvelopeID {
		return fmt.Errorf("mismatched rpc.response envelope id %q (expected %q)", env.ID, expectedEnvelopeID)
	}
	if env.HostID != expectedHostID {
		return fmt.Errorf("mismatched rpc.response hostId %q (expected %q)", env.HostID, expectedHostID)
	}
	if err := protocol.ValidateTimestamp(env.SentAt); err != nil {
		return fmt.Errorf("invalid rpc.response sentAt: %w", err)
	}
	var respPayload protocol.RpcResponsePayload
	if err := json.Unmarshal(env.Payload, &respPayload); err != nil {
		return fmt.Errorf("decode rpc.response payload: %w", err)
	}
	if respPayload.RequestID != expectedRequestID {
		return fmt.Errorf("mismatched rpc.response requestId %q (expected %q)", respPayload.RequestID, expectedRequestID)
	}
	if !respPayload.Ok {
		return errors.New("rpc.response indicated failure (ok=false)")
	}
	if respPayload.Error != nil {
		return errors.New("rpc.response contained unexpected error payload")
	}
	if len(expectedResult) > 0 {
		var actualMap, expectedMap map[string]interface{}
		if err := json.Unmarshal(respPayload.Result, &actualMap); err != nil {
			return fmt.Errorf("decode rpc.response result: %w", err)
		}
		if err := json.Unmarshal(expectedResult, &expectedMap); err != nil {
			return fmt.Errorf("decode expected rpc.response result: %w", err)
		}
		if !reflect.DeepEqual(actualMap, expectedMap) {
			return errors.New("mismatched rpc.response result")
		}
	}
	return nil
}

func verifyEventEnvelopeAndSentinel(env *protocol.Envelope, expectedSeq int64, expectedHostID, expectedSentinel string) error {
	if env == nil {
		return errors.New("received nil event envelope")
	}
	if env.V != protocol.ProtocolVersion {
		return fmt.Errorf("event %d mismatched protocol version %d (expected %d)", expectedSeq, env.V, protocol.ProtocolVersion)
	}
	if env.Type != protocol.FrameTypeEvent {
		return fmt.Errorf("event %d expected frame type %s, got %s", expectedSeq, protocol.FrameTypeEvent, env.Type)
	}
	expectedID := fmt.Sprintf("m2_smoke_event_%06d", expectedSeq)
	if env.ID != expectedID {
		return fmt.Errorf("event %d mismatched envelope id %q (expected %q)", expectedSeq, env.ID, expectedID)
	}
	if env.HostID != expectedHostID {
		return fmt.Errorf("event %d mismatched hostId %q (expected %q)", expectedSeq, env.HostID, expectedHostID)
	}
	if env.Seq == nil {
		return fmt.Errorf("event %d missing seq", expectedSeq)
	}
	if *env.Seq != expectedSeq {
		return fmt.Errorf("event sequence mismatch: got %d (expected %d)", *env.Seq, expectedSeq)
	}
	if err := protocol.ValidateTimestamp(env.SentAt); err != nil {
		return fmt.Errorf("event %d invalid sentAt: %w", expectedSeq, err)
	}

	var eventPayload protocol.EventPayload
	if err := json.Unmarshal(env.Payload, &eventPayload); err != nil {
		return fmt.Errorf("event %d decode payload: %w", expectedSeq, err)
	}
	if eventPayload.Name != "run.stream" {
		return fmt.Errorf("event %d expected event name run.stream, got %q", expectedSeq, eventPayload.Name)
	}

	var streamData struct {
		RunID string `json:"runId"`
		Item  struct {
			Kind    string `json:"kind"`
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"item"`
	}
	if err := json.Unmarshal(eventPayload.Data, &streamData); err != nil {
		return fmt.Errorf("event %d decode stream data: %w", expectedSeq, err)
	}
	if streamData.RunID != "m2_smoke_run" {
		return fmt.Errorf("event %d mismatched runId %q", expectedSeq, streamData.RunID)
	}
	if streamData.Item.Kind != "text" {
		return fmt.Errorf("event %d mismatched stream item kind %q", expectedSeq, streamData.Item.Kind)
	}
	if streamData.Item.Role != "assistant" {
		return fmt.Errorf("event %d mismatched stream item role %q", expectedSeq, streamData.Item.Role)
	}
	if streamData.Item.Content == "" {
		return fmt.Errorf("event %d payload sentinel missing", expectedSeq)
	}
	if streamData.Item.Content != expectedSentinel {
		return fmt.Errorf("event %d payload sentinel tampered or mismatched", expectedSeq)
	}
	return nil
}

func sanitizeError(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(msg, secret) {
			msg = strings.ReplaceAll(msg, secret, "[REDACTED]")
		}
	}
	return errors.New(msg)
}

func validateSmokeConfig(cfg smokeConfig) error {
	if strings.TrimSpace(cfg.baseURL) == "" {
		return errors.New("-base-url, RELAY_PUBLIC_BASE_URL, or PUBLIC_BASE_URL is required")
	}
	if !highEntropyTokenPattern.MatchString(cfg.adminToken) {
		return errors.New("admin token must be a base64url value of at least 32 random bytes")
	}
	if !highEntropyTokenPattern.MatchString(cfg.hostToken) {
		return errors.New("host token must be a base64url value of at least 32 random bytes")
	}
	if err := protocol.ValidateRemoteID(cfg.hostID); err != nil {
		return fmt.Errorf("invalid host ID: %w", err)
	}
	if cfg.eventCount < 1 || cfg.eventCount > 10000 {
		return errors.New("events must be between 1 and 10000")
	}
	if cfg.timeout <= 0 {
		return errors.New("timeout must be positive")
	}
	if len([]byte(cfg.payloadSentinel)) > int(protocol.MaxAllowedChunkBytes) {
		return errors.New("payload sentinel exceeds protocol chunk limit")
	}
	return nil
}

func parseBaseURLs(raw string, allowLoopbackWS bool) (*url.URL, *url.URL, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return nil, nil, errors.New("base URL must not be empty")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, nil, fmt.Errorf("parse base URL: %w", err)
	}
	if parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, nil, errors.New("base URL must contain only scheme, host, and optional path")
	}

	wsBase := *parsed
	httpBase := *parsed

	switch parsed.Scheme {
	case "https":
		wsBase.Scheme = "wss"
		httpBase.Scheme = "https"
	case "wss":
		wsBase.Scheme = "wss"
		httpBase.Scheme = "https"
	case "http", "ws":
		if !allowLoopbackWS {
			return nil, nil, errors.New("external smoke requires an https:// or wss:// base URL (unencrypted ws:// is only permitted for loopback IP literals with --allow-loopback-ws)")
		}
		hostname := parsed.Hostname()
		ip := net.ParseIP(hostname)
		if ip == nil {
			return nil, nil, fmt.Errorf("--allow-loopback-ws requires an IP literal host, got %q (hostnames like 'localhost' are rejected)", hostname)
		}
		if !ip.IsLoopback() {
			return nil, nil, fmt.Errorf("--allow-loopback-ws only permits loopback IP literals (e.g. 127.0.0.1 or ::1), got %s", ip.String())
		}
		wsBase.Scheme = "ws"
		httpBase.Scheme = "http"
	default:
		return nil, nil, fmt.Errorf("unsupported URL scheme %q", parsed.Scheme)
	}

	return &wsBase, &httpBase, nil
}

func websocketBaseURL(raw string) (*url.URL, error) {
	wsBase, _, err := parseBaseURLs(raw, false)
	return wsBase, err
}

func createHTTPClient(baseClient *http.Client, timeout time.Duration) *http.Client {
	var client http.Client
	if baseClient != nil {
		client = *baseClient
	}
	if client.Timeout <= 0 {
		client.Timeout = timeout
	}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return fmt.Errorf("redirects are forbidden in smoke verification: redirect to %s blocked", req.URL.String())
	}
	return &client
}

func checkHealthAndReady(ctx context.Context, client *http.Client, httpBase *url.URL) error {
	healthEndpoint := *httpBase
	healthEndpoint.Path = strings.TrimRight(httpBase.Path, "/") + "/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthEndpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("build healthz request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("probe healthz: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned status %d (expected 200)", resp.StatusCode)
	}
	var healthData struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&healthData); err != nil {
		return fmt.Errorf("decode healthz response: %w", err)
	}
	if healthData.Status != "ok" {
		return fmt.Errorf("healthz status %q (expected \"ok\")", healthData.Status)
	}

	readyEndpoint := *httpBase
	readyEndpoint.Path = strings.TrimRight(httpBase.Path, "/") + "/readyz"
	reqReady, err := http.NewRequestWithContext(ctx, http.MethodGet, readyEndpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("build readyz request: %w", err)
	}
	respReady, err := client.Do(reqReady)
	if err != nil {
		return fmt.Errorf("probe readyz: %w", err)
	}
	defer respReady.Body.Close()
	if respReady.StatusCode != http.StatusOK {
		return fmt.Errorf("readyz returned status %d (expected 200)", respReady.StatusCode)
	}
	var readyData struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(respReady.Body).Decode(&readyData); err != nil {
		return fmt.Errorf("decode readyz response: %w", err)
	}
	if readyData.Status != "ready" {
		return fmt.Errorf("readyz status %q (expected \"ready\")", readyData.Status)
	}
	return nil
}

func dialAuthenticated(ctx context.Context, httpClient *http.Client, base *url.URL, path, token, hostID, role string) (*websocket.Conn, error) {
	endpoint := *base
	endpoint.Path = strings.TrimRight(base.Path, "/") + path
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token)
	if hostID != "" {
		headers.Set("X-Host-Id", hostID)
	}
	conn, _, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{HTTPClient: httpClient, HTTPHeader: headers})
	if err != nil {
		return nil, err
	}
	authOK, err := readEnvelope(ctx, conn)
	if err != nil {
		conn.CloseNow()
		return nil, err
	}
	if authOK.Type != protocol.FrameTypeAuthOk {
		conn.CloseNow()
		return nil, fmt.Errorf("expected auth.ok, got %s", authOK.Type)
	}
	var payload protocol.AuthOkPayload
	if err := json.Unmarshal(authOK.Payload, &payload); err != nil {
		conn.CloseNow()
		return nil, err
	}
	if payload.Role != role || (hostID != "" && payload.HostID != hostID) {
		conn.CloseNow()
		return nil, errors.New("auth.ok identity mismatch")
	}
	return conn, nil
}

func verifyOrderedEvents(ctx context.Context, host, admin *websocket.Conn, cfg smokeConfig) error {
	readErrors := make(chan error, 1)
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		for expected := 1; expected <= cfg.eventCount; expected++ {
			envelope, err := readEnvelope(ctx, admin)
			if err != nil {
				readErrors <- sanitizeError(fmt.Errorf("admin receive event %d: %w", expected, err), cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
				return
			}
			if err := verifyEventEnvelopeAndSentinel(envelope, int64(expected), cfg.hostID, cfg.payloadSentinel); err != nil {
				readErrors <- sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
				return
			}
		}
	}()

	for sequence := 1; sequence <= cfg.eventCount; sequence++ {
		seq := int64(sequence)
		payload, err := json.Marshal(protocol.EventPayload{
			Name: "run.stream",
			Data: json.RawMessage(fmt.Sprintf(`{"runId":"m2_smoke_run","item":{"kind":"text","role":"assistant","content":%q}}`, cfg.payloadSentinel)),
		})
		if err != nil {
			return sanitizeError(err, cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
		}
		envelope := &protocol.Envelope{
			V:       protocol.ProtocolVersion,
			Type:    protocol.FrameTypeEvent,
			ID:      fmt.Sprintf("m2_smoke_event_%06d", sequence),
			HostID:  cfg.hostID,
			SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
			Seq:     &seq,
			Payload: payload,
		}
		if err := writeEnvelope(ctx, host, envelope); err != nil {
			return sanitizeError(fmt.Errorf("host send event %d: %w", sequence, err), cfg.payloadSentinel, cfg.adminToken, cfg.hostToken)
		}
	}

	wait.Wait()
	select {
	case err := <-readErrors:
		return err
	default:
		return nil
	}
}

func writeEnvelope(ctx context.Context, conn *websocket.Conn, envelope *protocol.Envelope) error {
	if err := protocol.ValidateEnvelope(envelope); err != nil {
		return err
	}
	encoded, err := protocol.EncodeEnvelope(envelope)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, encoded)
}

func readEnvelope(ctx context.Context, conn *websocket.Conn) (*protocol.Envelope, error) {
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("received non-text WebSocket frame")
	}
	return protocol.DecodeEnvelope(data)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func loadTokensFromEnvFile(path string, cfg *smokeConfig) error {
	parsed, err := safeenv.OpenAndValidateEnvFile(path)
	if err != nil {
		return err
	}

	for k, v := range parsed {
		switch k {
		case "SMOKE_ADMIN_TOKEN", "DEV_AUTH_ADMIN_TOKEN", "DEV_ADMIN_TOKEN":
			if cfg.adminToken == "" {
				cfg.adminToken = v
			}
		case "SMOKE_HOST_TOKEN", "DEV_AUTH_HOST_TOKEN", "DEV_HOST_TOKEN":
			if cfg.hostToken == "" {
				cfg.hostToken = v
			}
		case "SMOKE_HOST_ID", "DEV_AUTH_HOST_ID", "DEV_HOST_ID":
			if cfg.hostID == "" {
				cfg.hostID = v
			}
		case "SMOKE_PAYLOAD_SENTINEL":
			if cfg.payloadSentinel == "" {
				cfg.payloadSentinel = v
			}
		case "RELAY_PUBLIC_BASE_URL", "PUBLIC_BASE_URL":
			if cfg.baseURL == "" {
				cfg.baseURL = v
			}
		}
	}
	return nil
}

func parseBoolEnv(val string) bool {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "1", "t", "true", "yes", "on":
		return true
	default:
		return false
	}
}
