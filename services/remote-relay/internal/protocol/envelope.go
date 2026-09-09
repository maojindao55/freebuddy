package protocol

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

var (
	remoteIDRegex         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	idempotencyKeyRegex   = regexp.MustCompile(`^[A-Za-z0-9_-]{22,128}$`)
	timestampRegex        = regexp.MustCompile(`^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$`)
	challengeRegex        = regexp.MustCompile(`^[A-Za-z0-9_-]{43,86}$`)
	ed25519PublicKeyRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	ed25519SignatureRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{86}$`)
	opaqueTokenRegex      = regexp.MustCompile(`^[A-Za-z0-9._~-]{32,512}$`)
)

// ValidateRemoteID validates standard remote ID strings.
func ValidateRemoteID(id string) error {
	if len(id) < 1 || len(id) > 128 {
		return fmt.Errorf("remoteId length %d out of bounds (1-128)", len(id))
	}
	if !remoteIDRegex.MatchString(id) {
		return fmt.Errorf("invalid remoteId format %q", id)
	}
	return nil
}

// ValidateIdempotencyKey validates idempotency key format and length.
func ValidateIdempotencyKey(key string) error {
	if len(key) < 22 || len(key) > 128 {
		return fmt.Errorf("idempotencyKey length %d out of bounds (22-128)", len(key))
	}
	if !idempotencyKeyRegex.MatchString(key) {
		return fmt.Errorf("invalid idempotencyKey format %q", key)
	}
	return nil
}

// ValidateTimestamp validates strictly UTC RFC3339 timestamps ending in 'Z'.
func ValidateTimestamp(ts string) error {
	if len(ts) < 20 || len(ts) > 40 {
		return fmt.Errorf("timestamp length %d out of bounds (20-40)", len(ts))
	}
	if !timestampRegex.MatchString(ts) {
		return fmt.Errorf("timestamp %q must be UTC RFC3339 ending in 'Z'", ts)
	}
	if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
		return fmt.Errorf("invalid timestamp date/time %q: %w", ts, err)
	}
	return nil
}

// ValidateSeq validates event cursor bounds (0 <= seq <= MaxSeq).
func ValidateSeq(seq int64) error {
	if seq < 0 || seq > MaxSeq {
		return fmt.Errorf("seq %d out of bounds [0, %d]", seq, MaxSeq)
	}
	return nil
}

// ValidateOpaqueToken validates high-entropy opaque tokens (32..512 chars).
func ValidateOpaqueToken(token string) error {
	if len(token) < 32 || len(token) > 512 {
		return fmt.Errorf("token length %d out of bounds (32-512)", len(token))
	}
	if !opaqueTokenRegex.MatchString(token) {
		return fmt.Errorf("token does not match OpaqueToken character set")
	}
	return nil
}

// ValidateConnectionLimits validates that connection limits conform to protocol v1 schema.
func ValidateConnectionLimits(limits ConnectionLimits) error {
	if limits.MaxFrameBytes != MaxAllowedFrameBytes {
		return fmt.Errorf("maxFrameBytes %d must equal %d", limits.MaxFrameBytes, MaxAllowedFrameBytes)
	}
	if limits.MaxChunkBytes != MaxAllowedChunkBytes {
		return fmt.Errorf("maxChunkBytes %d must equal %d", limits.MaxChunkBytes, MaxAllowedChunkBytes)
	}
	if limits.MaxConcurrentRPCs < 1 || limits.MaxConcurrentRPCs > 64 {
		return fmt.Errorf("maxConcurrentRpcs %d out of bounds [1, 64]", limits.MaxConcurrentRPCs)
	}
	if limits.RPCReadTimeoutMs < 1000 || limits.RPCReadTimeoutMs > 60000 {
		return fmt.Errorf("rpcReadTimeoutMs %d out of bounds [1000, 60000]", limits.RPCReadTimeoutMs)
	}
	if limits.RPCWriteTimeoutMs < 1000 || limits.RPCWriteTimeoutMs > 120000 {
		return fmt.Errorf("rpcWriteTimeoutMs %d out of bounds [1000, 120000]", limits.RPCWriteTimeoutMs)
	}
	if limits.HeartbeatIntervalMs < 5000 || limits.HeartbeatIntervalMs > 120000 {
		return fmt.Errorf("heartbeatIntervalMs %d out of bounds [5000, 120000]", limits.HeartbeatIntervalMs)
	}
	if limits.ChallengeTTLMs < 1000 || limits.ChallengeTTLMs > 300000 {
		return fmt.Errorf("challengeTtlMs %d out of bounds [1000, 300000]", limits.ChallengeTTLMs)
	}
	return nil
}

// ValidateStructuredError validates StructuredError fields and constraints.
func ValidateStructuredError(err StructuredError) error {
	if !IsValidErrorCode(err.Code) {
		return fmt.Errorf("invalid error code %q", err.Code)
	}
	if len(err.Message) < 1 || len(err.Message) > 512 {
		return fmt.Errorf("error message length %d out of bounds (1-512)", len(err.Message))
	}
	if err.Details != nil {
		if len(err.Details) > 16 {
			return fmt.Errorf("error details exceeds 16 properties (got %d)", len(err.Details))
		}
		for k, v := range err.Details {
			if len(k) < 1 || len(k) > 64 {
				return fmt.Errorf("invalid details key length %q", k)
			}
			switch v.(type) {
			case string, float64, bool, nil:
				// Primitive allowed types
			default:
				return fmt.Errorf("details property %q has non-primitive type %T", k, v)
			}
		}
	}
	return nil
}

// ValidateHostStatus validates host runtime status fields.
func ValidateHostStatus(h HostStatus) error {
	if err := ValidateRemoteID(h.HostID); err != nil {
		return fmt.Errorf("invalid hostId: %w", err)
	}
	if h.DisplayName != "" && (len(h.DisplayName) < 1 || len(h.DisplayName) > 120) {
		return fmt.Errorf("displayName length %d out of bounds (1-120)", len(h.DisplayName))
	}
	if len(h.AppVersion) < 1 || len(h.AppVersion) > 64 {
		return fmt.Errorf("appVersion length %d out of bounds (1-64)", len(h.AppVersion))
	}
	if h.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("protocolVersion %d must be %d", h.ProtocolVersion, ProtocolVersion)
	}
	if h.ActiveRunCount < 0 || h.ActiveRunCount > 10000 {
		return fmt.Errorf("activeRunCount %d out of bounds [0, 10000]", h.ActiveRunCount)
	}
	if h.PendingDecisionCount < 0 || h.PendingDecisionCount > 10000 {
		return fmt.Errorf("pendingDecisionCount %d out of bounds [0, 10000]", h.PendingDecisionCount)
	}
	if h.ActiveTerminalCount < 0 || h.ActiveTerminalCount > 1000 {
		return fmt.Errorf("activeTerminalCount %d out of bounds [0, 1000]", h.ActiveTerminalCount)
	}
	if err := ValidateTimestamp(h.ServerTime); err != nil {
		return fmt.Errorf("invalid serverTime: %w", err)
	}
	return nil
}

// ValidateProjectSummary validates ProjectSummary fields and constraints.
func ValidateProjectSummary(p ProjectSummary) error {
	if err := ValidateRemoteID(p.ProjectID); err != nil {
		return fmt.Errorf("invalid project summary projectId: %w", err)
	}
	if len(p.Name) < 1 || len(p.Name) > 120 {
		return fmt.Errorf("project summary name length %d out of bounds (1-120)", len(p.Name))
	}
	if err := ValidateTimestamp(p.UpdatedAt); err != nil {
		return fmt.Errorf("invalid project summary updatedAt: %w", err)
	}
	return nil
}

// ValidateAgentSummary validates AgentSummary fields and constraints.
func ValidateAgentSummary(a AgentSummary) error {
	if err := ValidateRemoteID(a.AgentID); err != nil {
		return fmt.Errorf("invalid agent summary agentId: %w", err)
	}
	if len(a.Name) < 1 || len(a.Name) > 120 {
		return fmt.Errorf("agent summary name length %d out of bounds (1-120)", len(a.Name))
	}
	if a.Kind != "" && (len(a.Kind) < 1 || len(a.Kind) > 64) {
		return fmt.Errorf("agent summary kind length %d out of bounds (1-64)", len(a.Kind))
	}
	return nil
}

// ValidateConversationSummary validates ConversationSummary fields and constraints.
func ValidateConversationSummary(c ConversationSummary) error {
	if err := ValidateRemoteID(c.ConversationID); err != nil {
		return fmt.Errorf("invalid conversation summary conversationId: %w", err)
	}
	if c.ProjectID != "" {
		if err := ValidateRemoteID(c.ProjectID); err != nil {
			return fmt.Errorf("invalid conversation summary projectId: %w", err)
		}
	}
	if len(c.Title) < 1 || len(c.Title) > 200 {
		return fmt.Errorf("conversation summary title length %d out of bounds (1-200)", len(c.Title))
	}
	if err := ValidateTimestamp(c.UpdatedAt); err != nil {
		return fmt.Errorf("invalid conversation summary updatedAt: %w", err)
	}
	if c.LastMessageAt != "" {
		if err := ValidateTimestamp(c.LastMessageAt); err != nil {
			return fmt.Errorf("invalid conversation summary lastMessageAt: %w", err)
		}
	}
	return nil
}

// ValidateMessageSummary validates MessageSummary fields and constraints.
func ValidateMessageSummary(m MessageSummary) error {
	if err := ValidateRemoteID(m.MessageID); err != nil {
		return fmt.Errorf("invalid message summary messageId: %w", err)
	}
	if err := ValidateRemoteID(m.ConversationID); err != nil {
		return fmt.Errorf("invalid message summary conversationId: %w", err)
	}
	if !IsValidRole(m.Role) {
		return fmt.Errorf("invalid message summary role %q", m.Role)
	}
	if int64(len([]byte(m.Content))) > MaxAllowedChunkBytes {
		return fmt.Errorf("message summary content byte length %d exceeds max %d", len([]byte(m.Content)), MaxAllowedChunkBytes)
	}
	if err := ValidateTimestamp(m.CreatedAt); err != nil {
		return fmt.Errorf("invalid message summary createdAt: %w", err)
	}
	if m.RunID != "" {
		if err := ValidateRemoteID(m.RunID); err != nil {
			return fmt.Errorf("invalid message summary runId: %w", err)
		}
	}
	return nil
}

// ValidateTaskSummary validates TaskSummary fields and constraints.
func ValidateTaskSummary(t TaskSummary) error {
	if err := ValidateRemoteID(t.TaskID); err != nil {
		return fmt.Errorf("invalid task summary taskId: %w", err)
	}
	if len(t.Title) < 1 || len(t.Title) > 200 {
		return fmt.Errorf("task summary title length %d out of bounds (1-200)", len(t.Title))
	}
	if !IsValidTaskStatus(t.Status) {
		return fmt.Errorf("invalid task summary status %q", t.Status)
	}
	if t.ProjectID != "" {
		if err := ValidateRemoteID(t.ProjectID); err != nil {
			return fmt.Errorf("invalid task summary projectId: %w", err)
		}
	}
	if t.ConversationID != "" {
		if err := ValidateRemoteID(t.ConversationID); err != nil {
			return fmt.Errorf("invalid task summary conversationId: %w", err)
		}
	}
	if err := ValidateTimestamp(t.UpdatedAt); err != nil {
		return fmt.Errorf("invalid task summary updatedAt: %w", err)
	}
	return nil
}

// ValidateTaskLogItem validates TaskLogItem fields and constraints.
func ValidateTaskLogItem(item TaskLogItem) error {
	if err := ValidateSeq(item.Seq); err != nil {
		return fmt.Errorf("invalid task log item seq: %w", err)
	}
	if int64(len([]byte(item.Text))) > MaxAllowedChunkBytes {
		return fmt.Errorf("task log item text byte length %d exceeds max %d", len([]byte(item.Text)), MaxAllowedChunkBytes)
	}
	if err := ValidateTimestamp(item.CreatedAt); err != nil {
		return fmt.Errorf("invalid task log item createdAt: %w", err)
	}
	return nil
}

// ValidateRunSummary validates RunSummary fields and constraints.
func ValidateRunSummary(r RunSummary) error {
	if err := ValidateRemoteID(r.RunID); err != nil {
		return fmt.Errorf("invalid run summary runId: %w", err)
	}
	if err := ValidateRemoteID(r.ConversationID); err != nil {
		return fmt.Errorf("invalid run summary conversationId: %w", err)
	}
	if r.AgentID != "" {
		if err := ValidateRemoteID(r.AgentID); err != nil {
			return fmt.Errorf("invalid run summary agentId: %w", err)
		}
	}
	if !IsValidRunStatus(r.Status) {
		return fmt.Errorf("invalid run summary status %q", r.Status)
	}
	if r.StartedAt != "" {
		if err := ValidateTimestamp(r.StartedAt); err != nil {
			return fmt.Errorf("invalid run summary startedAt: %w", err)
		}
	}
	return nil
}

// ValidateDecisionSummary validates DecisionSummary fields and constraints.
func ValidateDecisionSummary(d DecisionSummary) error {
	if err := ValidateRemoteID(d.DecisionID); err != nil {
		return fmt.Errorf("invalid decision summary decisionId: %w", err)
	}
	if d.Kind != "permission" && d.Kind != "authentication" {
		return fmt.Errorf("invalid decision summary kind %q (expected permission or authentication)", d.Kind)
	}
	if err := ValidateRemoteID(d.RunID); err != nil {
		return fmt.Errorf("invalid decision summary runId: %w", err)
	}
	if err := ValidateRemoteID(d.ConversationID); err != nil {
		return fmt.Errorf("invalid decision summary conversationId: %w", err)
	}
	if len(d.Summary) < 1 || len(d.Summary) > 512 {
		return fmt.Errorf("decision summary summary length %d out of bounds (1-512)", len(d.Summary))
	}
	if d.Tool != "" && (len(d.Tool) < 1 || len(d.Tool) > 128) {
		return fmt.Errorf("decision summary tool length %d out of bounds (1-128)", len(d.Tool))
	}
	return nil
}

// ValidateWorkflowSummary validates WorkflowSummary fields and constraints.
func ValidateWorkflowSummary(w WorkflowSummary) error {
	if err := ValidateRemoteID(w.WorkflowID); err != nil {
		return fmt.Errorf("invalid workflow summary workflowId: %w", err)
	}
	if len(w.Name) < 1 || len(w.Name) > 120 {
		return fmt.Errorf("workflow summary name length %d out of bounds (1-120)", len(w.Name))
	}
	if !IsValidWorkflowStatus(w.Status) {
		return fmt.Errorf("invalid workflow summary status %q", w.Status)
	}
	if err := ValidateTimestamp(w.UpdatedAt); err != nil {
		return fmt.Errorf("invalid workflow summary updatedAt: %w", err)
	}
	return nil
}

// ValidateDelegationSummary validates DelegationSummary fields and constraints.
func ValidateDelegationSummary(d DelegationSummary) error {
	if err := ValidateRemoteID(d.DelegationID); err != nil {
		return fmt.Errorf("invalid delegation summary delegationId: %w", err)
	}
	if d.TeamID != "" {
		if err := ValidateRemoteID(d.TeamID); err != nil {
			return fmt.Errorf("invalid delegation summary teamId: %w", err)
		}
	}
	if len(d.Name) < 1 || len(d.Name) > 120 {
		return fmt.Errorf("delegation summary name length %d out of bounds (1-120)", len(d.Name))
	}
	if !IsValidDelegationStatus(d.Status) {
		return fmt.Errorf("invalid delegation summary status %q", d.Status)
	}
	if err := ValidateTimestamp(d.UpdatedAt); err != nil {
		return fmt.Errorf("invalid delegation summary updatedAt: %w", err)
	}
	return nil
}

// ValidateTerminalSummary validates TerminalSummary fields and constraints.
func ValidateTerminalSummary(t TerminalSummary) error {
	if err := ValidateRemoteID(t.TerminalID); err != nil {
		return fmt.Errorf("invalid terminal summary terminalId: %w", err)
	}
	if err := ValidateRemoteID(t.ProjectID); err != nil {
		return fmt.Errorf("invalid terminal summary projectId: %w", err)
	}
	if t.Cols < 20 || t.Cols > 300 {
		return fmt.Errorf("terminal summary cols %d out of bounds [20, 300]", t.Cols)
	}
	if t.Rows < 5 || t.Rows > 100 {
		return fmt.Errorf("terminal summary rows %d out of bounds [5, 100]", t.Rows)
	}
	if t.CreatedAt != "" {
		if err := ValidateTimestamp(t.CreatedAt); err != nil {
			return fmt.Errorf("invalid terminal summary createdAt: %w", err)
		}
	}
	return nil
}

func unmarshalStructuredError(data []byte) (*StructuredError, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"code", "message", "retryable"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("structured error missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("structured error field %q must not be null", req)
		}
	}
	if rawDetails, ok := raw["details"]; ok && string(rawDetails) == "null" {
		return nil, errors.New("structured error details must not be null")
	}
	for k := range raw {
		if k != "code" && k != "message" && k != "retryable" && k != "details" {
			return nil, fmt.Errorf("unknown field %q in structured error", k)
		}
	}
	var sErr StructuredError
	if err := unmarshalStrict(data, &sErr); err != nil {
		return nil, err
	}
	if err := ValidateStructuredError(sErr); err != nil {
		return nil, err
	}
	return &sErr, nil
}

func unmarshalHostStatus(data []byte) (*HostStatus, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	required := []string{"hostId", "online", "appVersion", "protocolVersion", "remoteEnabled", "activeRunCount", "pendingDecisionCount", "activeTerminalCount", "serverTime"}
	for _, req := range required {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("host status missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("host status field %q must not be null", req)
		}
	}
	if rawDisplayName, ok := raw["displayName"]; ok && string(rawDisplayName) == "null" {
		return nil, errors.New("host status displayName must not be null")
	}
	for k := range raw {
		switch k {
		case "hostId", "displayName", "online", "appVersion", "protocolVersion", "remoteEnabled", "activeRunCount", "pendingDecisionCount", "activeTerminalCount", "serverTime":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in host status", k)
		}
	}
	var h HostStatus
	if err := unmarshalStrict(data, &h); err != nil {
		return nil, err
	}
	if err := ValidateHostStatus(h); err != nil {
		return nil, err
	}
	return &h, nil
}

func unmarshalProjectSummary(data []byte) (*ProjectSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"projectId", "name", "updatedAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("project summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("project summary field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "projectId" && k != "name" && k != "updatedAt" {
			return nil, fmt.Errorf("unknown field %q in project summary", k)
		}
	}
	var p ProjectSummary
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateProjectSummary(p); err != nil {
		return nil, err
	}
	return &p, nil
}

func unmarshalAgentSummary(data []byte) (*AgentSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"agentId", "name", "available"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("agent summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("agent summary field %q must not be null", req)
		}
	}
	if rawKind, ok := raw["kind"]; ok && string(rawKind) == "null" {
		return nil, errors.New("agent summary kind must not be null")
	}
	for k := range raw {
		if k != "agentId" && k != "name" && k != "kind" && k != "available" {
			return nil, fmt.Errorf("unknown field %q in agent summary", k)
		}
	}
	var a AgentSummary
	if err := unmarshalStrict(data, &a); err != nil {
		return nil, err
	}
	if err := ValidateAgentSummary(a); err != nil {
		return nil, err
	}
	return &a, nil
}

func unmarshalConversationSummary(data []byte) (*ConversationSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"conversationId", "title", "archived", "updatedAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("conversation summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("conversation summary field %q must not be null", req)
		}
	}
	if rawProjID, ok := raw["projectId"]; ok && string(rawProjID) == "null" {
		return nil, errors.New("conversation summary projectId must not be null")
	}
	if rawLastMsg, ok := raw["lastMessageAt"]; ok && string(rawLastMsg) == "null" {
		return nil, errors.New("conversation summary lastMessageAt must not be null")
	}
	for k := range raw {
		switch k {
		case "conversationId", "projectId", "title", "archived", "updatedAt", "lastMessageAt":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in conversation summary", k)
		}
	}
	var c ConversationSummary
	if err := unmarshalStrict(data, &c); err != nil {
		return nil, err
	}
	if err := ValidateConversationSummary(c); err != nil {
		return nil, err
	}
	return &c, nil
}

func unmarshalMessageSummary(data []byte) (*MessageSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"messageId", "conversationId", "role", "content", "createdAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("message summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("message summary field %q must not be null", req)
		}
	}
	if rawTruncated, ok := raw["truncated"]; ok && string(rawTruncated) == "null" {
		return nil, errors.New("message summary truncated must not be null")
	}
	if rawRunID, ok := raw["runId"]; ok && string(rawRunID) == "null" {
		return nil, errors.New("message summary runId must not be null")
	}
	for k := range raw {
		switch k {
		case "messageId", "conversationId", "role", "content", "truncated", "createdAt", "runId":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in message summary", k)
		}
	}
	var m MessageSummary
	if err := unmarshalStrict(data, &m); err != nil {
		return nil, err
	}
	if err := ValidateMessageSummary(m); err != nil {
		return nil, err
	}
	return &m, nil
}

func unmarshalTaskSummary(data []byte) (*TaskSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"taskId", "title", "status", "updatedAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("task summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("task summary field %q must not be null", req)
		}
	}
	if rawProjID, ok := raw["projectId"]; ok && string(rawProjID) == "null" {
		return nil, errors.New("task summary projectId must not be null")
	}
	if rawConvID, ok := raw["conversationId"]; ok && string(rawConvID) == "null" {
		return nil, errors.New("task summary conversationId must not be null")
	}
	for k := range raw {
		switch k {
		case "taskId", "title", "status", "projectId", "conversationId", "updatedAt":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in task summary", k)
		}
	}
	var t TaskSummary
	if err := unmarshalStrict(data, &t); err != nil {
		return nil, err
	}
	if err := ValidateTaskSummary(t); err != nil {
		return nil, err
	}
	return &t, nil
}

func unmarshalTaskLogItem(data []byte) (*TaskLogItem, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"seq", "text", "createdAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("task log item missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("task log item field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "seq" && k != "text" && k != "createdAt" {
			return nil, fmt.Errorf("unknown field %q in task log item", k)
		}
	}
	var item TaskLogItem
	if err := unmarshalStrict(data, &item); err != nil {
		return nil, err
	}
	if err := ValidateTaskLogItem(item); err != nil {
		return nil, err
	}
	return &item, nil
}

func unmarshalRunSummary(data []byte) (*RunSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"runId", "conversationId", "status"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("run summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("run summary field %q must not be null", req)
		}
	}
	if rawAgentID, ok := raw["agentId"]; ok && string(rawAgentID) == "null" {
		return nil, errors.New("run summary agentId must not be null")
	}
	if rawStartedAt, ok := raw["startedAt"]; ok && string(rawStartedAt) == "null" {
		return nil, errors.New("run summary startedAt must not be null")
	}
	for k := range raw {
		switch k {
		case "runId", "conversationId", "agentId", "status", "startedAt":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in run summary", k)
		}
	}
	var r RunSummary
	if err := unmarshalStrict(data, &r); err != nil {
		return nil, err
	}
	if err := ValidateRunSummary(r); err != nil {
		return nil, err
	}
	return &r, nil
}

func unmarshalDecisionSummary(data []byte) (*DecisionSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"decisionId", "kind", "runId", "conversationId", "summary"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("decision summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("decision summary field %q must not be null", req)
		}
	}
	if rawTool, ok := raw["tool"]; ok && string(rawTool) == "null" {
		return nil, errors.New("decision summary tool must not be null")
	}
	for k := range raw {
		switch k {
		case "decisionId", "kind", "runId", "conversationId", "summary", "tool":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in decision summary", k)
		}
	}
	var d DecisionSummary
	if err := unmarshalStrict(data, &d); err != nil {
		return nil, err
	}
	if err := ValidateDecisionSummary(d); err != nil {
		return nil, err
	}
	return &d, nil
}

func unmarshalWorkflowSummary(data []byte) (*WorkflowSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"workflowId", "name", "status", "updatedAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("workflow summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("workflow summary field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "workflowId" && k != "name" && k != "status" && k != "updatedAt" {
			return nil, fmt.Errorf("unknown field %q in workflow summary", k)
		}
	}
	var w WorkflowSummary
	if err := unmarshalStrict(data, &w); err != nil {
		return nil, err
	}
	if err := ValidateWorkflowSummary(w); err != nil {
		return nil, err
	}
	return &w, nil
}

func unmarshalDelegationSummary(data []byte) (*DelegationSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"delegationId", "name", "status", "updatedAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("delegation summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("delegation summary field %q must not be null", req)
		}
	}
	if rawTeamID, ok := raw["teamId"]; ok && string(rawTeamID) == "null" {
		return nil, errors.New("delegation summary teamId must not be null")
	}
	for k := range raw {
		switch k {
		case "delegationId", "teamId", "name", "status", "updatedAt":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in delegation summary", k)
		}
	}
	var d DelegationSummary
	if err := unmarshalStrict(data, &d); err != nil {
		return nil, err
	}
	if err := ValidateDelegationSummary(d); err != nil {
		return nil, err
	}
	return &d, nil
}

func unmarshalTerminalSummary(data []byte) (*TerminalSummary, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"terminalId", "projectId", "cols", "rows"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("terminal summary missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("terminal summary field %q must not be null", req)
		}
	}
	if rawCreatedAt, ok := raw["createdAt"]; ok && string(rawCreatedAt) == "null" {
		return nil, errors.New("terminal summary createdAt must not be null")
	}
	for k := range raw {
		switch k {
		case "terminalId", "projectId", "cols", "rows", "createdAt":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in terminal summary", k)
		}
	}
	var t TerminalSummary
	if err := unmarshalStrict(data, &t); err != nil {
		return nil, err
	}
	if err := ValidateTerminalSummary(t); err != nil {
		return nil, err
	}
	return &t, nil
}

func unmarshalSnapshotPayload(data []byte) (*SnapshotPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	if _, ok := raw["baseSeq"]; !ok {
		return nil, errors.New("snapshot payload missing required field 'baseSeq'")
	}
	if string(raw["baseSeq"]) == "null" {
		return nil, errors.New("snapshot payload baseSeq must not be null")
	}
	rawHost, ok := raw["host"]
	if !ok {
		return nil, errors.New("snapshot payload missing required field 'host'")
	}
	if string(rawHost) == "null" {
		return nil, errors.New("snapshot payload host must not be null")
	}
	for k := range raw {
		switch k {
		case "baseSeq", "host", "projects", "agents", "conversations",
			"activeRuns", "pendingDecisions", "activeWorkflows", "activeDelegations",
			"activeTasks", "activeTerminals":
			// allowed
		default:
			return nil, fmt.Errorf("unknown field %q in snapshot payload", k)
		}
	}

	var p SnapshotPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateSeq(p.BaseSeq); err != nil {
		return nil, fmt.Errorf("invalid snapshot baseSeq: %w", err)
	}
	if _, err := unmarshalHostStatus(rawHost); err != nil {
		return nil, fmt.Errorf("invalid snapshot host status: %w", err)
	}

	if rawProjects, ok := raw["projects"]; ok {
		if string(rawProjects) == "null" {
			return nil, errors.New("projects array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawProjects, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid projects array: %w", err)
		}
		if len(rawItems) > 100 {
			return nil, fmt.Errorf("projects array length %d exceeds limit of 100", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalProjectSummary(item); err != nil {
				return nil, fmt.Errorf("invalid project summary at index %d: %w", i, err)
			}
		}
	}
	if rawAgents, ok := raw["agents"]; ok {
		if string(rawAgents) == "null" {
			return nil, errors.New("agents array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawAgents, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid agents array: %w", err)
		}
		if len(rawItems) > 100 {
			return nil, fmt.Errorf("agents array length %d exceeds limit of 100", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalAgentSummary(item); err != nil {
				return nil, fmt.Errorf("invalid agent summary at index %d: %w", i, err)
			}
		}
	}
	if rawConversations, ok := raw["conversations"]; ok {
		if string(rawConversations) == "null" {
			return nil, errors.New("conversations array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawConversations, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid conversations array: %w", err)
		}
		if len(rawItems) > 100 {
			return nil, fmt.Errorf("conversations array length %d exceeds limit of 100", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalConversationSummary(item); err != nil {
				return nil, fmt.Errorf("invalid conversation summary at index %d: %w", i, err)
			}
		}
	}
	if rawRuns, ok := raw["activeRuns"]; ok {
		if string(rawRuns) == "null" {
			return nil, errors.New("activeRuns array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawRuns, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid activeRuns array: %w", err)
		}
		if len(rawItems) > 50 {
			return nil, fmt.Errorf("activeRuns array length %d exceeds limit of 50", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalRunSummary(item); err != nil {
				return nil, fmt.Errorf("invalid run summary at index %d: %w", i, err)
			}
		}
	}
	if rawDecisions, ok := raw["pendingDecisions"]; ok {
		if string(rawDecisions) == "null" {
			return nil, errors.New("pendingDecisions array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawDecisions, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid pendingDecisions array: %w", err)
		}
		if len(rawItems) > 50 {
			return nil, fmt.Errorf("pendingDecisions array length %d exceeds limit of 50", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalDecisionSummary(item); err != nil {
				return nil, fmt.Errorf("invalid decision summary at index %d: %w", i, err)
			}
		}
	}
	if rawWorkflows, ok := raw["activeWorkflows"]; ok {
		if string(rawWorkflows) == "null" {
			return nil, errors.New("activeWorkflows array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawWorkflows, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid activeWorkflows array: %w", err)
		}
		if len(rawItems) > 50 {
			return nil, fmt.Errorf("activeWorkflows array length %d exceeds limit of 50", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalWorkflowSummary(item); err != nil {
				return nil, fmt.Errorf("invalid workflow summary at index %d: %w", i, err)
			}
		}
	}
	if rawDelegations, ok := raw["activeDelegations"]; ok {
		if string(rawDelegations) == "null" {
			return nil, errors.New("activeDelegations array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawDelegations, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid activeDelegations array: %w", err)
		}
		if len(rawItems) > 50 {
			return nil, fmt.Errorf("activeDelegations array length %d exceeds limit of 50", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalDelegationSummary(item); err != nil {
				return nil, fmt.Errorf("invalid delegation summary at index %d: %w", i, err)
			}
		}
	}
	if rawTasks, ok := raw["activeTasks"]; ok {
		if string(rawTasks) == "null" {
			return nil, errors.New("activeTasks array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawTasks, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid activeTasks array: %w", err)
		}
		if len(rawItems) > 50 {
			return nil, fmt.Errorf("activeTasks array length %d exceeds limit of 50", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalTaskSummary(item); err != nil {
				return nil, fmt.Errorf("invalid task summary at index %d: %w", i, err)
			}
		}
	}
	if rawTerminals, ok := raw["activeTerminals"]; ok {
		if string(rawTerminals) == "null" {
			return nil, errors.New("activeTerminals array must not be null")
		}
		var rawItems []json.RawMessage
		if err := json.Unmarshal(rawTerminals, &rawItems); err != nil {
			return nil, fmt.Errorf("invalid activeTerminals array: %w", err)
		}
		if len(rawItems) > 20 {
			return nil, fmt.Errorf("activeTerminals array length %d exceeds limit of 20", len(rawItems))
		}
		for i, item := range rawItems {
			if _, err := unmarshalTerminalSummary(item); err != nil {
				return nil, fmt.Errorf("invalid terminal summary at index %d: %w", i, err)
			}
		}
	}

	return &p, nil
}

func unmarshalEventPayload(data []byte) (*EventPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"name", "data"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("event payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("event payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "name" && k != "data" {
			return nil, fmt.Errorf("unknown field %q in event payload", k)
		}
	}
	var p EventPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if !IsValidEvent(p.Name) {
		return nil, fmt.Errorf("event %q is not registered in remote protocol v1", p.Name)
	}
	if len(p.Data) == 0 {
		return nil, errors.New("event payload data must not be empty")
	}
	if err := ValidateEventData(p.Name, p.Data); err != nil {
		return nil, fmt.Errorf("invalid event %s data: %w", p.Name, err)
	}
	return &p, nil
}

func unmarshalResumePayload(data []byte) (*ResumePayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	rawResumeFrom, ok := raw["resumeFrom"]
	if !ok {
		return nil, errors.New("resume payload missing required field 'resumeFrom'")
	}
	if string(rawResumeFrom) == "null" {
		return nil, errors.New("resume payload resumeFrom must not be null")
	}
	for k := range raw {
		if k != "resumeFrom" {
			return nil, fmt.Errorf("unknown field %q in resume payload", k)
		}
	}
	var p ResumePayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateSeq(p.ResumeFrom); err != nil {
		return nil, fmt.Errorf("invalid resumeFrom: %w", err)
	}
	return &p, nil
}

func unmarshalPingPayload(data []byte) (*PingPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	if rawNonce, ok := raw["nonce"]; ok {
		if string(rawNonce) == "null" {
			return nil, errors.New("ping payload nonce must not be null")
		}
	}
	for k := range raw {
		if k != "nonce" {
			return nil, fmt.Errorf("unknown field %q in ping payload", k)
		}
	}
	var p PingPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if _, hasNonce := raw["nonce"]; hasNonce {
		if len(p.Nonce) < 1 || len(p.Nonce) > 64 {
			return nil, fmt.Errorf("invalid ping nonce length %d (must be 1-64)", len(p.Nonce))
		}
	}
	return &p, nil
}

func unmarshalPongPayload(data []byte) (*PongPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	rawServerTime, ok := raw["serverTime"]
	if !ok {
		return nil, errors.New("pong payload missing required field 'serverTime'")
	}
	if string(rawServerTime) == "null" {
		return nil, errors.New("pong payload serverTime must not be null")
	}
	if rawNonce, ok := raw["nonce"]; ok {
		if string(rawNonce) == "null" {
			return nil, errors.New("pong payload nonce must not be null")
		}
	}
	for k := range raw {
		if k != "nonce" && k != "serverTime" {
			return nil, fmt.Errorf("unknown field %q in pong payload", k)
		}
	}
	var p PongPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if _, hasNonce := raw["nonce"]; hasNonce {
		if len(p.Nonce) < 1 || len(p.Nonce) > 64 {
			return nil, fmt.Errorf("invalid pong nonce length %d (must be 1-64)", len(p.Nonce))
		}
	}
	if err := ValidateTimestamp(p.ServerTime); err != nil {
		return nil, fmt.Errorf("invalid pong serverTime: %w", err)
	}
	return &p, nil
}

func unmarshalServerDrainingPayload(data []byte) (*ServerDrainingPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, err
	}
	for _, req := range []string{"reason", "reconnectAfterMs"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("server.draining payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("server.draining payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "reason" && k != "reconnectAfterMs" {
			return nil, fmt.Errorf("unknown field %q in server.draining payload", k)
		}
	}
	var p ServerDrainingPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if p.Reason != "shutdown" && p.Reason != "restart" && p.Reason != "version" {
		return nil, fmt.Errorf("invalid server.draining reason %q (must be shutdown, restart, or version)", p.Reason)
	}
	if p.ReconnectAfterMs < 0 || p.ReconnectAfterMs > 600000 {
		return nil, fmt.Errorf("server.draining reconnectAfterMs %d out of bounds [0, 600000]", p.ReconnectAfterMs)
	}
	return &p, nil
}

func unmarshalRpcResponsePayload(data []byte) (*RpcResponsePayload, error) {
	var rawMap map[string]json.RawMessage
	if err := unmarshalStrict(data, &rawMap); err != nil {
		return nil, fmt.Errorf("invalid rpc.response payload: %w", err)
	}
	rawReqID, ok := rawMap["requestId"]
	if !ok {
		return nil, errors.New("rpc.response payload missing required field 'requestId'")
	}
	if string(rawReqID) == "null" {
		return nil, errors.New("rpc.response requestId must not be null")
	}
	var reqID string
	if err := json.Unmarshal(rawReqID, &reqID); err != nil {
		return nil, fmt.Errorf("invalid rpc.response requestId: %w", err)
	}
	if err := ValidateRemoteID(reqID); err != nil {
		return nil, fmt.Errorf("invalid rpc.response requestId %q: %w", reqID, err)
	}
	rawOk, ok := rawMap["ok"]
	if !ok {
		return nil, errors.New("rpc.response payload missing required field 'ok'")
	}
	if string(rawOk) == "null" {
		return nil, errors.New("rpc.response ok must not be null")
	}
	var isOk bool
	if err := json.Unmarshal(rawOk, &isOk); err != nil {
		return nil, fmt.Errorf("invalid rpc.response ok boolean: %w", err)
	}

	if isOk {
		for k := range rawMap {
			if k != "requestId" && k != "ok" && k != "result" {
				return nil, fmt.Errorf("unknown field %q in rpc.response success payload", k)
			}
		}
		if _, hasErr := rawMap["error"]; hasErr {
			return nil, errors.New("rpc.response success must not contain 'error' field (violates oneOf)")
		}
		rawResult, hasRes := rawMap["result"]
		if !hasRes {
			return nil, errors.New("rpc.response success requires 'result' field")
		}
		if string(rawResult) == "null" {
			return nil, errors.New("rpc.response result must not be null")
		}
		var resultMap map[string]interface{}
		if err := json.Unmarshal(rawResult, &resultMap); err != nil {
			return nil, fmt.Errorf("rpc.response result must be a JSON object: %w", err)
		}
		return &RpcResponsePayload{
			RequestID: reqID,
			Ok:        true,
			Result:    rawResult,
		}, nil
	}

	for k := range rawMap {
		if k != "requestId" && k != "ok" && k != "error" {
			return nil, fmt.Errorf("unknown field %q in rpc.response failure payload", k)
		}
	}
	if _, hasRes := rawMap["result"]; hasRes {
		return nil, errors.New("rpc.response failure must not contain 'result' field (violates oneOf)")
	}
	rawError, hasErr := rawMap["error"]
	if !hasErr {
		return nil, errors.New("rpc.response failure requires 'error' field")
	}
	if string(rawError) == "null" {
		return nil, errors.New("rpc.response error must not be null")
	}
	sErr, err := unmarshalStructuredError(rawError)
	if err != nil {
		return nil, fmt.Errorf("invalid rpc.response error payload: %w", err)
	}
	return &RpcResponsePayload{
		RequestID: reqID,
		Ok:        false,
		Error:     sErr,
	}, nil
}

func unmarshalChallengePayload(data []byte) (*ChallengePayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid challenge payload: %w", err)
	}
	for _, req := range []string{"connectionId", "challenge", "issuedAt", "expiresAt"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("challenge payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("challenge payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "connectionId" && k != "challenge" && k != "issuedAt" && k != "expiresAt" {
			return nil, fmt.Errorf("unknown field %q in challenge payload", k)
		}
	}
	var p ChallengePayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateRemoteID(p.ConnectionID); err != nil {
		return nil, fmt.Errorf("invalid challenge connectionId %q: %w", p.ConnectionID, err)
	}
	if !challengeRegex.MatchString(p.Challenge) {
		return nil, fmt.Errorf("invalid challenge format %q", p.Challenge)
	}
	if err := ValidateTimestamp(p.IssuedAt); err != nil {
		return nil, fmt.Errorf("invalid challenge issuedAt: %w", err)
	}
	if err := ValidateTimestamp(p.ExpiresAt); err != nil {
		return nil, fmt.Errorf("invalid challenge expiresAt: %w", err)
	}
	return &p, nil
}

func unmarshalHostAuthPayload(data []byte) (*HostAuthPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid host.auth payload: %w", err)
	}
	for _, req := range []string{"hostId", "keyId", "publicKey", "signature", "clientVersion", "protocolVersion"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("host.auth payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("host.auth payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "hostId" && k != "keyId" && k != "publicKey" && k != "signature" && k != "clientVersion" && k != "protocolVersion" {
			return nil, fmt.Errorf("unknown field %q in host.auth payload", k)
		}
	}
	var p HostAuthPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateRemoteID(p.HostID); err != nil {
		return nil, fmt.Errorf("invalid host.auth hostId %q: %w", p.HostID, err)
	}
	if err := ValidateRemoteID(p.KeyID); err != nil {
		return nil, fmt.Errorf("invalid host.auth keyId %q: %w", p.KeyID, err)
	}
	if p.ProtocolVersion != ProtocolVersion {
		return nil, fmt.Errorf("host.auth protocolVersion %d must be %d", p.ProtocolVersion, ProtocolVersion)
	}
	if !ed25519PublicKeyRegex.MatchString(p.PublicKey) {
		return nil, fmt.Errorf("invalid host.auth publicKey format")
	}
	if !ed25519SignatureRegex.MatchString(p.Signature) {
		return nil, fmt.Errorf("invalid host.auth signature format")
	}
	if len(p.ClientVersion) < 1 || len(p.ClientVersion) > 64 {
		return nil, fmt.Errorf("invalid host.auth clientVersion length %d", len(p.ClientVersion))
	}
	return &p, nil
}

func unmarshalAdminAuthPayload(data []byte) (*AdminAuthPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid admin.auth payload: %w", err)
	}
	for _, req := range []string{"accessToken", "clientVersion", "protocolVersion"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("admin.auth payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("admin.auth payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "accessToken" && k != "clientVersion" && k != "protocolVersion" {
			return nil, fmt.Errorf("unknown field %q in admin.auth payload", k)
		}
	}
	var p AdminAuthPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateOpaqueToken(p.AccessToken); err != nil {
		return nil, fmt.Errorf("invalid admin.auth accessToken: %w", err)
	}
	if p.ProtocolVersion != ProtocolVersion {
		return nil, fmt.Errorf("admin.auth protocolVersion %d must be %d", p.ProtocolVersion, ProtocolVersion)
	}
	if len(p.ClientVersion) < 1 || len(p.ClientVersion) > 64 {
		return nil, fmt.Errorf("invalid admin.auth clientVersion length %d", len(p.ClientVersion))
	}
	return &p, nil
}

func unmarshalAuthOkPayload(data []byte) (*AuthOkPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid auth.ok payload: %w", err)
	}
	for _, req := range []string{"connectionId", "role", "serverTime", "limits"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("auth.ok payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("auth.ok payload field %q must not be null", req)
		}
	}
	if rawHostID, ok := raw["hostId"]; ok && string(rawHostID) == "null" {
		return nil, errors.New("auth.ok payload hostId must not be null")
	}
	for k := range raw {
		if k != "connectionId" && k != "role" && k != "hostId" && k != "serverTime" && k != "limits" {
			return nil, fmt.Errorf("unknown field %q in auth.ok payload", k)
		}
	}
	var p AuthOkPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if err := ValidateRemoteID(p.ConnectionID); err != nil {
		return nil, fmt.Errorf("invalid auth.ok connectionId %q: %w", p.ConnectionID, err)
	}
	if p.Role != RoleHost && p.Role != RoleAdmin {
		return nil, fmt.Errorf("invalid auth.ok role %q (expected host or admin)", p.Role)
	}
	if p.HostID != "" {
		if err := ValidateRemoteID(p.HostID); err != nil {
			return nil, fmt.Errorf("invalid auth.ok payload hostId %q: %w", p.HostID, err)
		}
	}
	if err := ValidateTimestamp(p.ServerTime); err != nil {
		return nil, fmt.Errorf("invalid auth.ok serverTime: %w", err)
	}
	if err := ValidateConnectionLimits(p.Limits); err != nil {
		return nil, fmt.Errorf("invalid auth.ok limits: %w", err)
	}
	return &p, nil
}

func unmarshalRpcRequestPayload(data []byte) (*RpcRequestPayload, error) {
	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid rpc.request payload: %w", err)
	}
	for _, req := range []string{"method", "params"} {
		if _, ok := raw[req]; !ok {
			return nil, fmt.Errorf("rpc.request payload missing required field %q", req)
		}
		if string(raw[req]) == "null" {
			return nil, fmt.Errorf("rpc.request payload field %q must not be null", req)
		}
	}
	for k := range raw {
		if k != "method" && k != "params" {
			return nil, fmt.Errorf("unknown field %q in rpc.request payload", k)
		}
	}
	var p RpcRequestPayload
	if err := unmarshalStrict(data, &p); err != nil {
		return nil, err
	}
	if IsForbiddenMethod(p.Method) {
		return nil, fmt.Errorf("method %q is forbidden in remote protocol v1", p.Method)
	}
	if !IsValidMethod(p.Method) {
		return nil, fmt.Errorf("method %q is not registered in remote protocol v1", p.Method)
	}
	if err := ValidateRPCRequestParams(p.Method, p.Params); err != nil {
		return nil, err
	}
	return &p, nil
}

// ValidateRemoteStreamItem strictly validates RemoteStreamItem payloads according to stream-items.schema.json.
func ValidateRemoteStreamItem(rawItem []byte) error {
	var base struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(rawItem, &base); err != nil {
		return fmt.Errorf("stream item must be a JSON object: %w", err)
	}
	if base.Kind == "" {
		return errors.New("stream item missing required field 'kind'")
	}

	switch base.Kind {
	case "text":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "role", "content"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("text stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("text stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "role" && k != "content" && k != "append" && k != "messageId" {
				return fmt.Errorf("unknown field %q in text stream item", k)
			}
		}
		var item struct {
			Kind      string `json:"kind"`
			Role      string `json:"role"`
			Content   string `json:"content"`
			Append    *bool  `json:"append,omitempty"`
			MessageID string `json:"messageId,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if !IsValidRole(item.Role) {
			return fmt.Errorf("invalid text stream item role %q", item.Role)
		}
		if int64(len([]byte(item.Content))) > MaxAllowedChunkBytes {
			return fmt.Errorf("text stream item content length %d exceeds max %d", len([]byte(item.Content)), MaxAllowedChunkBytes)
		}
		if item.MessageID != "" {
			if err := ValidateRemoteID(item.MessageID); err != nil {
				return fmt.Errorf("invalid text stream item messageId: %w", err)
			}
		}
		return nil

	case "thinking":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "content"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("thinking stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("thinking stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "content" && k != "append" && k != "messageId" {
				return fmt.Errorf("unknown field %q in thinking stream item", k)
			}
		}
		var item struct {
			Kind      string `json:"kind"`
			Content   string `json:"content"`
			Append    *bool  `json:"append,omitempty"`
			MessageID string `json:"messageId,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if int64(len([]byte(item.Content))) > MaxAllowedChunkBytes {
			return fmt.Errorf("thinking stream item content length %d exceeds max %d", len([]byte(item.Content)), MaxAllowedChunkBytes)
		}
		if item.MessageID != "" {
			if err := ValidateRemoteID(item.MessageID); err != nil {
				return fmt.Errorf("invalid thinking stream item messageId: %w", err)
			}
		}
		return nil

	case "tool-call":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "tool"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("tool-call stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("tool-call stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			switch k {
			case "kind", "tool", "id", "status", "toolKind", "inputPreview":
			default:
				return fmt.Errorf("unknown field %q in tool-call stream item", k)
			}
		}
		var item struct {
			Kind         string `json:"kind"`
			Tool         string `json:"tool"`
			ID           string `json:"id,omitempty"`
			Status       string `json:"status,omitempty"`
			ToolKind     string `json:"toolKind,omitempty"`
			InputPreview string `json:"inputPreview,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if len(item.Tool) < 1 || len(item.Tool) > 128 {
			return fmt.Errorf("tool-call tool length %d out of bounds (1-128)", len(item.Tool))
		}
		if item.ID != "" {
			if err := ValidateRemoteID(item.ID); err != nil {
				return fmt.Errorf("invalid tool-call id: %w", err)
			}
		}
		if item.Status != "" {
			switch item.Status {
			case "pending", "running", "completed", "failed":
			default:
				return fmt.Errorf("invalid tool-call status %q", item.Status)
			}
		}
		if item.ToolKind != "" {
			switch item.ToolKind {
			case "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "mode", "other":
			default:
				return fmt.Errorf("invalid tool-call toolKind %q", item.ToolKind)
			}
		}
		if len(item.InputPreview) > 4096 {
			return fmt.Errorf("tool-call inputPreview length %d exceeds max 4096", len(item.InputPreview))
		}
		return nil

	case "tool-result":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "tool", "content"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("tool-result stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("tool-result stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "tool" && k != "content" && k != "id" && k != "isError" {
				return fmt.Errorf("unknown field %q in tool-result stream item", k)
			}
		}
		var item struct {
			Kind    string `json:"kind"`
			Tool    string `json:"tool"`
			Content string `json:"content"`
			ID      string `json:"id,omitempty"`
			IsError *bool  `json:"isError,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if len(item.Tool) < 1 || len(item.Tool) > 128 {
			return fmt.Errorf("tool-result tool length %d out of bounds (1-128)", len(item.Tool))
		}
		if int64(len([]byte(item.Content))) > MaxAllowedChunkBytes {
			return fmt.Errorf("tool-result content length %d exceeds max %d", len([]byte(item.Content)), MaxAllowedChunkBytes)
		}
		if item.ID != "" {
			if err := ValidateRemoteID(item.ID); err != nil {
				return fmt.Errorf("invalid tool-result id: %w", err)
			}
		}
		return nil

	case "command":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "command"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("command stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("command stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "command" {
				return fmt.Errorf("unknown field %q in command stream item", k)
			}
		}
		var item struct {
			Kind    string `json:"kind"`
			Command string `json:"command"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if len(item.Command) < 1 || len(item.Command) > 4096 {
			return fmt.Errorf("command stream item length %d out of bounds (1-4096)", len(item.Command))
		}
		return nil

	case "command-output":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "content"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("command-output stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("command-output stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "content" && k != "stream" {
				return fmt.Errorf("unknown field %q in command-output stream item", k)
			}
		}
		var item struct {
			Kind    string `json:"kind"`
			Content string `json:"content"`
			Stream  string `json:"stream,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if int64(len([]byte(item.Content))) > MaxAllowedChunkBytes {
			return fmt.Errorf("command-output content length %d exceeds max %d", len([]byte(item.Content)), MaxAllowedChunkBytes)
		}
		if item.Stream != "" && item.Stream != "stdout" && item.Stream != "stderr" {
			return fmt.Errorf("invalid command-output stream %q (expected stdout or stderr)", item.Stream)
		}
		return nil

	case "file-edit":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "path", "action"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("file-edit stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("file-edit stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "path" && k != "action" && k != "patch" {
				return fmt.Errorf("unknown field %q in file-edit stream item", k)
			}
		}
		var item struct {
			Kind   string `json:"kind"`
			Path   string `json:"path"`
			Action string `json:"action"`
			Patch  string `json:"patch,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if len(item.Path) < 1 || len(item.Path) > 1024 {
			return fmt.Errorf("file-edit path length %d out of bounds (1-1024)", len(item.Path))
		}
		if item.Action != "create" && item.Action != "update" && item.Action != "delete" {
			return fmt.Errorf("invalid file-edit action %q (expected create, update, or delete)", item.Action)
		}
		if item.Patch != "" && int64(len([]byte(item.Patch))) > MaxAllowedChunkBytes {
			return fmt.Errorf("file-edit patch length %d exceeds max %d", len([]byte(item.Patch)), MaxAllowedChunkBytes)
		}
		return nil

	case "usage":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for k := range raw {
			if k != "kind" && k != "inputTokens" && k != "outputTokens" && k != "totalTokens" && k != "totalCost" {
				return fmt.Errorf("unknown field %q in usage stream item", k)
			}
		}
		var item struct {
			Kind         string   `json:"kind"`
			InputTokens  *int     `json:"inputTokens,omitempty"`
			OutputTokens *int     `json:"outputTokens,omitempty"`
			TotalTokens  *int     `json:"totalTokens,omitempty"`
			TotalCost    *float64 `json:"totalCost,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if item.InputTokens != nil && *item.InputTokens < 0 {
			return fmt.Errorf("usage inputTokens %d must be >= 0", *item.InputTokens)
		}
		if item.OutputTokens != nil && *item.OutputTokens < 0 {
			return fmt.Errorf("usage outputTokens %d must be >= 0", *item.OutputTokens)
		}
		if item.TotalTokens != nil && *item.TotalTokens < 0 {
			return fmt.Errorf("usage totalTokens %d must be >= 0", *item.TotalTokens)
		}
		if item.TotalCost != nil && *item.TotalCost < 0 {
			return fmt.Errorf("usage totalCost %f must be >= 0", *item.TotalCost)
		}
		return nil

	case "error":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for _, req := range []string{"kind", "message"} {
			if _, ok := raw[req]; !ok {
				return fmt.Errorf("error stream item missing required field %q", req)
			}
			if string(raw[req]) == "null" {
				return fmt.Errorf("error stream item field %q must not be null", req)
			}
		}
		for k := range raw {
			if k != "kind" && k != "message" && k != "terminal" {
				return fmt.Errorf("unknown field %q in error stream item", k)
			}
		}
		var item struct {
			Kind     string `json:"kind"`
			Message  string `json:"message"`
			Terminal *bool  `json:"terminal,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if len(item.Message) < 1 || len(item.Message) > 512 {
			return fmt.Errorf("error stream item message length %d out of bounds (1-512)", len(item.Message))
		}
		return nil

	case "done":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(rawItem, &raw); err != nil {
			return err
		}
		for k := range raw {
			if k != "kind" && k != "exitCode" {
				return fmt.Errorf("unknown field %q in done stream item", k)
			}
		}
		var item struct {
			Kind     string `json:"kind"`
			ExitCode *int   `json:"exitCode,omitempty"`
		}
		if err := unmarshalStrict(rawItem, &item); err != nil {
			return err
		}
		if item.ExitCode != nil && (*item.ExitCode < -2147483648 || *item.ExitCode > 2147483647) {
			return fmt.Errorf("done stream item exitCode %d out of bounds", *item.ExitCode)
		}
		return nil

	default:
		return fmt.Errorf("unknown stream item kind %q", base.Kind)
	}
}

// ValidateEventData strictly validates domain event data payloads according to events.schema.json.
func ValidateEventData(name string, data []byte) error {
	switch name {
	case "host.status.changed":
		_, err := unmarshalHostStatus(data)
		return err

	case "conversation.created", "conversation.updated":
		_, err := unmarshalConversationSummary(data)
		return err

	case "conversation.deleted":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["conversationId"]; !ok {
			return errors.New("conversation.deleted missing required field 'conversationId'")
		}
		if string(raw["conversationId"]) == "null" {
			return errors.New("conversation.deleted conversationId must not be null")
		}
		for k := range raw {
			if k != "conversationId" {
				return fmt.Errorf("unknown field %q in conversation.deleted data", k)
			}
		}
		var d ConversationDeletedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		return ValidateRemoteID(d.ConversationID)

	case "message.created", "message.updated":
		_, err := unmarshalMessageSummary(data)
		return err

	case "run.started":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["runId"]; !ok {
			return errors.New("run.started missing required field 'runId'")
		}
		if string(raw["runId"]) == "null" {
			return errors.New("run.started runId must not be null")
		}
		if _, ok := raw["conversationId"]; !ok {
			return errors.New("run.started missing required field 'conversationId'")
		}
		if string(raw["conversationId"]) == "null" {
			return errors.New("run.started conversationId must not be null")
		}
		for k := range raw {
			if k != "runId" && k != "conversationId" && k != "agentId" {
				return fmt.Errorf("unknown field %q in run.started data", k)
			}
		}
		var d RunStartedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.RunID); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.ConversationID); err != nil {
			return err
		}
		if d.AgentID != "" {
			if err := ValidateRemoteID(d.AgentID); err != nil {
				return err
			}
		}
		return nil

	case "run.stream":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["runId"]; !ok {
			return errors.New("run.stream missing required field 'runId'")
		}
		if string(raw["runId"]) == "null" {
			return errors.New("run.stream runId must not be null")
		}
		rawItem, ok := raw["item"]
		if !ok {
			return errors.New("run.stream missing required field 'item'")
		}
		if string(rawItem) == "null" {
			return errors.New("run.stream item must not be null")
		}
		for k := range raw {
			switch k {
			case "runId", "conversationId", "item", "index":
			default:
				return fmt.Errorf("unknown field %q in run.stream data", k)
			}
		}
		var d RunStreamData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.RunID); err != nil {
			return err
		}
		if d.ConversationID != "" {
			if err := ValidateRemoteID(d.ConversationID); err != nil {
				return err
			}
		}
		if d.Index != nil && *d.Index < 0 {
			return fmt.Errorf("run.stream index %d must be >= 0", *d.Index)
		}
		return ValidateRemoteStreamItem(rawItem)

	case "run.finished", "run.stopped":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["runId"]; !ok {
			return fmt.Errorf("%s missing required field 'runId'", name)
		}
		if string(raw["runId"]) == "null" {
			return fmt.Errorf("%s runId must not be null", name)
		}
		if _, ok := raw["conversationId"]; !ok {
			return fmt.Errorf("%s missing required field 'conversationId'", name)
		}
		if string(raw["conversationId"]) == "null" {
			return fmt.Errorf("%s conversationId must not be null", name)
		}
		for k := range raw {
			if k != "runId" && k != "conversationId" {
				return fmt.Errorf("unknown field %q in %s data", k, name)
			}
		}
		var d RunTerminalData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.RunID); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.ConversationID); err != nil {
			return err
		}
		return nil

	case "run.failed":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["runId"]; !ok {
			return errors.New("run.failed missing required field 'runId'")
		}
		if string(raw["runId"]) == "null" {
			return errors.New("run.failed runId must not be null")
		}
		if _, ok := raw["conversationId"]; !ok {
			return errors.New("run.failed missing required field 'conversationId'")
		}
		if string(raw["conversationId"]) == "null" {
			return errors.New("run.failed conversationId must not be null")
		}
		rawErr, ok := raw["error"]
		if !ok {
			return errors.New("run.failed missing required field 'error'")
		}
		if string(rawErr) == "null" {
			return errors.New("run.failed error must not be null")
		}
		for k := range raw {
			if k != "runId" && k != "conversationId" && k != "error" {
				return fmt.Errorf("unknown field %q in run.failed data", k)
			}
		}
		var d RunFailedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.RunID); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.ConversationID); err != nil {
			return err
		}
		if _, err := unmarshalStructuredError(rawErr); err != nil {
			return fmt.Errorf("invalid run.failed error: %w", err)
		}
		return nil

	case "permission.requested", "authentication.requested":
		_, err := unmarshalDecisionSummary(data)
		return err

	case "permission.resolved", "authentication.resolved":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["decisionId"]; !ok {
			return fmt.Errorf("%s missing required field 'decisionId'", name)
		}
		if string(raw["decisionId"]) == "null" {
			return fmt.Errorf("%s decisionId must not be null", name)
		}
		rawAllow, ok := raw["allow"]
		if !ok {
			return fmt.Errorf("%s missing required field 'allow'", name)
		}
		if string(rawAllow) == "null" {
			return fmt.Errorf("%s allow boolean must not be null", name)
		}
		for k := range raw {
			if k != "decisionId" && k != "allow" {
				return fmt.Errorf("unknown field %q in %s data", k, name)
			}
		}
		var d DecisionResolvedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.DecisionID); err != nil {
			return err
		}
		return nil

	case "task.updated":
		_, err := unmarshalTaskSummary(data)
		return err

	case "task.log.appended":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["taskId"]; !ok {
			return errors.New("task.log.appended missing required field 'taskId'")
		}
		if string(raw["taskId"]) == "null" {
			return errors.New("task.log.appended taskId must not be null")
		}
		rawItem, ok := raw["item"]
		if !ok {
			return errors.New("task.log.appended missing required field 'item'")
		}
		if string(rawItem) == "null" {
			return errors.New("task.log.appended item must not be null")
		}
		for k := range raw {
			if k != "taskId" && k != "item" {
				return fmt.Errorf("unknown field %q in task.log.appended data", k)
			}
		}
		var d TaskLogAppendedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.TaskID); err != nil {
			return err
		}
		if _, err := unmarshalTaskLogItem(rawItem); err != nil {
			return fmt.Errorf("invalid task.log.appended item: %w", err)
		}
		return nil

	case "workflow.updated":
		_, err := unmarshalWorkflowSummary(data)
		return err

	case "delegation.updated":
		_, err := unmarshalDelegationSummary(data)
		return err

	case "terminal.opened":
		_, err := unmarshalTerminalSummary(data)
		return err

	case "terminal.output":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["terminalId"]; !ok {
			return errors.New("terminal.output missing required field 'terminalId'")
		}
		if string(raw["terminalId"]) == "null" {
			return errors.New("terminal.output terminalId must not be null")
		}
		if _, ok := raw["data"]; !ok {
			return errors.New("terminal.output missing required field 'data'")
		}
		if string(raw["data"]) == "null" {
			return errors.New("terminal.output data must not be null")
		}
		if _, ok := raw["seq"]; !ok {
			return errors.New("terminal.output missing required field 'seq'")
		}
		if string(raw["seq"]) == "null" {
			return errors.New("terminal.output seq must not be null")
		}
		for k := range raw {
			if k != "terminalId" && k != "data" && k != "seq" && k != "truncated" {
				return fmt.Errorf("unknown field %q in terminal.output data", k)
			}
		}
		var d TerminalOutputData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		if err := ValidateRemoteID(d.TerminalID); err != nil {
			return err
		}
		if int64(len([]byte(d.Data))) > MaxAllowedChunkBytes {
			return fmt.Errorf("terminal.output data byte length %d exceeds limit of %d", len([]byte(d.Data)), MaxAllowedChunkBytes)
		}
		if err := ValidateSeq(d.Seq); err != nil {
			return fmt.Errorf("invalid terminal.output seq: %w", err)
		}
		return nil

	case "terminal.closed":
		var raw map[string]json.RawMessage
		if err := unmarshalStrict(data, &raw); err != nil {
			return err
		}
		if _, ok := raw["terminalId"]; !ok {
			return errors.New("terminal.closed missing required field 'terminalId'")
		}
		if string(raw["terminalId"]) == "null" {
			return errors.New("terminal.closed terminalId must not be null")
		}
		for k := range raw {
			if k != "terminalId" {
				return fmt.Errorf("unknown field %q in terminal.closed data", k)
			}
		}
		var d TerminalClosedData
		if err := unmarshalStrict(data, &d); err != nil {
			return err
		}
		return ValidateRemoteID(d.TerminalID)

	default:
		return fmt.Errorf("event %q is not registered in remote protocol v1", name)
	}
}

// GenerateConnectionID generates a high-entropy connection ID (e.g. conn_...).
func GenerateConnectionID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return "conn_" + hex.EncodeToString(buf[:])
}

// GenerateMessageID generates a high-entropy message ID (e.g. msg_...).
func GenerateMessageID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return "msg_" + hex.EncodeToString(buf[:])
}

var allowedEnvelopeKeys = map[string]map[string]bool{
	FrameTypeChallenge: {
		"v":       true,
		"type":    true,
		"id":      true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeHostAuth: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeAdminAuth: {
		"v":       true,
		"type":    true,
		"id":      true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeAuthOk: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeError: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeRpcRequest: {
		"v":              true,
		"type":           true,
		"id":             true,
		"hostId":         true,
		"sentAt":         true,
		"expiresAt":      true,
		"idempotencyKey": true,
		"payload":        true,
		"meta":           true,
	},
	FrameTypeRpcResponse: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeEvent: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"seq":     true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeResume: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeSnapshot: {
		"v":       true,
		"type":    true,
		"id":      true,
		"hostId":  true,
		"sentAt":  true,
		"seq":     true,
		"payload": true,
		"meta":    true,
	},
	FrameTypePing: {
		"v":       true,
		"type":    true,
		"id":      true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypePong: {
		"v":       true,
		"type":    true,
		"id":      true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
	FrameTypeServerDraining: {
		"v":       true,
		"type":    true,
		"id":      true,
		"sentAt":  true,
		"payload": true,
		"meta":    true,
	},
}

var requiredEnvelopeKeys = map[string][]string{
	FrameTypeChallenge:      {"v", "type", "id", "sentAt", "payload"},
	FrameTypeHostAuth:       {"v", "type", "id", "hostId", "sentAt", "payload"},
	FrameTypeAdminAuth:      {"v", "type", "id", "sentAt", "payload"},
	FrameTypeAuthOk:         {"v", "type", "id", "sentAt", "payload"},
	FrameTypeError:          {"v", "type", "id", "sentAt", "payload"},
	FrameTypeRpcRequest:     {"v", "type", "id", "hostId", "sentAt", "payload"},
	FrameTypeRpcResponse:    {"v", "type", "id", "hostId", "sentAt", "payload"},
	FrameTypeEvent:          {"v", "type", "id", "hostId", "sentAt", "seq", "payload"},
	FrameTypeResume:         {"v", "type", "id", "hostId", "sentAt", "payload"},
	FrameTypeSnapshot:       {"v", "type", "id", "hostId", "sentAt", "seq", "payload"},
	FrameTypePing:           {"v", "type", "id", "sentAt", "payload"},
	FrameTypePong:           {"v", "type", "id", "sentAt", "payload"},
	FrameTypeServerDraining: {"v", "type", "id", "sentAt", "payload"},
}

func validateEnvelopeKeys(raw map[string]json.RawMessage, env *Envelope) error {
	allowed, ok := allowedEnvelopeKeys[env.Type]
	if !ok {
		return fmt.Errorf("unknown or invalid frame type %q", env.Type)
	}

	reqs := requiredEnvelopeKeys[env.Type]
	for _, req := range reqs {
		if _, present := raw[req]; !present {
			return fmt.Errorf("%s frame missing required field %q", env.Type, req)
		}
	}

	for k := range raw {
		if !allowed[k] {
			return fmt.Errorf("field %q is not permitted on %s frame", k, env.Type)
		}
	}

	// Presence checks for optional fields:
	// If present in raw JSON, string values must satisfy schema format (must not be empty string).
	if _, ok := raw["hostId"]; ok {
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid envelope hostId: %w", err)
		}
	}
	if _, ok := raw["expiresAt"]; ok {
		if err := ValidateTimestamp(env.ExpiresAt); err != nil {
			return fmt.Errorf("invalid envelope expiresAt: %w", err)
		}
	}
	if _, ok := raw["idempotencyKey"]; ok {
		if err := ValidateIdempotencyKey(env.IdempotencyKey); err != nil {
			return fmt.Errorf("invalid envelope idempotencyKey: %w", err)
		}
	}

	return nil
}

// DecodeEnvelope strictly unmarshals and validates a raw UTF-8 JSON WebSocket frame.
func DecodeEnvelope(data []byte) (*Envelope, error) {
	if int64(len(data)) > MaxAllowedFrameBytes {
		return nil, fmt.Errorf("frame size %d exceeds limit of %d bytes", len(data), MaxAllowedFrameBytes)
	}

	var raw map[string]json.RawMessage
	if err := unmarshalStrict(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid envelope JSON: %w", err)
	}

	for k, v := range raw {
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return nil, fmt.Errorf("envelope field %q must not be null", k)
		}
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var env Envelope
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("invalid envelope JSON: %w", err)
	}

	var extra json.RawMessage
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("unexpected trailing data after JSON envelope")
	}

	if err := validateEnvelopeKeys(raw, &env); err != nil {
		return nil, err
	}

	if err := ValidateEnvelope(&env); err != nil {
		return nil, err
	}

	return &env, nil
}

// ValidateEnvelope performs full protocol validation on an Envelope structure according to envelope.schema.json.
func ValidateEnvelope(env *Envelope) error {
	if env == nil {
		return errors.New("nil envelope")
	}

	// 1. Version check
	if env.V != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d (expected %d)", env.V, ProtocolVersion)
	}

	// 2. Type check
	if !IsValidFrameType(env.Type) {
		return fmt.Errorf("unknown or invalid frame type %q", env.Type)
	}

	// 3. ID check
	if err := ValidateRemoteID(env.ID); err != nil {
		return fmt.Errorf("invalid envelope id %q: %w", env.ID, err)
	}

	// 4. SentAt timestamp check (must be UTC RFC3339 ending in 'Z')
	if err := ValidateTimestamp(env.SentAt); err != nil {
		return fmt.Errorf("invalid sentAt timestamp %q: %w", env.SentAt, err)
	}

	// 5. Payload non-empty check
	if len(env.Payload) == 0 {
		return errors.New("envelope payload must not be empty")
	}

	// 6. Meta validation if present
	if env.Meta != nil {
		if len(env.Meta) > 16 {
			return fmt.Errorf("meta map exceeds maximum of 16 properties (got %d)", len(env.Meta))
		}
		for k, v := range env.Meta {
			if len(k) < 1 || len(k) > 64 {
				return fmt.Errorf("invalid meta key length %q", k)
			}
			switch v.(type) {
			case string, float64, bool, nil:
				// Allowed primitive types
			default:
				return fmt.Errorf("meta property %q has non-primitive type %T", k, v)
			}
		}
	}

	// 7. Frame-specific exclusivity and payload validations
	switch env.Type {
	case FrameTypeChallenge:
		if env.HostID != "" {
			return errors.New("hostId is not permitted on challenge frame")
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on challenge frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on challenge frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on challenge frame")
		}

		var p ChallengePayload
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid challenge payload: %w", err)
		}
		if err := ValidateRemoteID(p.ConnectionID); err != nil {
			return fmt.Errorf("invalid challenge connectionId %q: %w", p.ConnectionID, err)
		}
		if !challengeRegex.MatchString(p.Challenge) {
			return fmt.Errorf("invalid challenge format %q", p.Challenge)
		}
		if err := ValidateTimestamp(p.IssuedAt); err != nil {
			return fmt.Errorf("invalid challenge issuedAt: %w", err)
		}
		if err := ValidateTimestamp(p.ExpiresAt); err != nil {
			return fmt.Errorf("invalid challenge expiresAt: %w", err)
		}

	case FrameTypeHostAuth:
		if env.HostID == "" {
			return errors.New("host.auth frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on host.auth frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on host.auth frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on host.auth frame")
		}

		var p HostAuthPayload
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid host.auth payload: %w", err)
		}
		if p.HostID != env.HostID {
			return fmt.Errorf("host.auth payload hostId %q does not match envelope hostId %q", p.HostID, env.HostID)
		}
		if err := ValidateRemoteID(p.KeyID); err != nil {
			return fmt.Errorf("invalid host.auth keyId %q: %w", p.KeyID, err)
		}
		if p.ProtocolVersion != ProtocolVersion {
			return fmt.Errorf("host.auth protocolVersion %d must be %d", p.ProtocolVersion, ProtocolVersion)
		}
		if !ed25519PublicKeyRegex.MatchString(p.PublicKey) {
			return fmt.Errorf("invalid host.auth publicKey format")
		}
		if !ed25519SignatureRegex.MatchString(p.Signature) {
			return fmt.Errorf("invalid host.auth signature format")
		}
		if len(p.ClientVersion) < 1 || len(p.ClientVersion) > 64 {
			return fmt.Errorf("invalid host.auth clientVersion length %d", len(p.ClientVersion))
		}

	case FrameTypeAdminAuth:
		if env.HostID != "" {
			return errors.New("hostId is not permitted on admin.auth frame")
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on admin.auth frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on admin.auth frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on admin.auth frame")
		}

		var p AdminAuthPayload
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid admin.auth payload: %w", err)
		}
		if err := ValidateOpaqueToken(p.AccessToken); err != nil {
			return fmt.Errorf("invalid admin.auth accessToken: %w", err)
		}
		if p.ProtocolVersion != ProtocolVersion {
			return fmt.Errorf("admin.auth protocolVersion %d must be %d", p.ProtocolVersion, ProtocolVersion)
		}
		if len(p.ClientVersion) < 1 || len(p.ClientVersion) > 64 {
			return fmt.Errorf("invalid admin.auth clientVersion length %d", len(p.ClientVersion))
		}

	case FrameTypeAuthOk:
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on auth.ok frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on auth.ok frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on auth.ok frame")
		}
		if env.HostID != "" {
			if err := ValidateRemoteID(env.HostID); err != nil {
				return fmt.Errorf("invalid auth.ok envelope hostId %q: %w", env.HostID, err)
			}
		}

		var p AuthOkPayload
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid auth.ok payload: %w", err)
		}
		if err := ValidateRemoteID(p.ConnectionID); err != nil {
			return fmt.Errorf("invalid auth.ok connectionId %q: %w", p.ConnectionID, err)
		}
		if p.Role != RoleHost && p.Role != RoleAdmin {
			return fmt.Errorf("invalid auth.ok role %q (expected host or admin)", p.Role)
		}
		if p.HostID != "" {
			if err := ValidateRemoteID(p.HostID); err != nil {
				return fmt.Errorf("invalid auth.ok payload hostId %q: %w", p.HostID, err)
			}
			if env.HostID != "" && env.HostID != p.HostID {
				return fmt.Errorf("auth.ok envelope hostId %q does not match payload hostId %q", env.HostID, p.HostID)
			}
		}
		if err := ValidateTimestamp(p.ServerTime); err != nil {
			return fmt.Errorf("invalid auth.ok serverTime: %w", err)
		}
		if err := ValidateConnectionLimits(p.Limits); err != nil {
			return fmt.Errorf("invalid auth.ok limits: %w", err)
		}

	case FrameTypeError:
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on error frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on error frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on error frame")
		}
		if env.HostID != "" {
			if err := ValidateRemoteID(env.HostID); err != nil {
				return fmt.Errorf("invalid error envelope hostId %q: %w", env.HostID, err)
			}
		}

		var p StructuredError
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid error payload: %w", err)
		}
		if err := ValidateStructuredError(p); err != nil {
			return fmt.Errorf("invalid error payload: %w", err)
		}

	case FrameTypeRpcRequest:
		if env.HostID == "" {
			return errors.New("rpc.request frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on rpc.request frame")
		}

		var p RpcRequestPayload
		if err := unmarshalStrict(env.Payload, &p); err != nil {
			return fmt.Errorf("invalid rpc.request payload: %w", err)
		}
		if IsForbiddenMethod(p.Method) {
			return fmt.Errorf("method %q is forbidden in remote protocol v1", p.Method)
		}
		if !IsValidMethod(p.Method) {
			return fmt.Errorf("method %q is not registered in remote protocol v1", p.Method)
		}
		if err := ValidateRPCRequestParams(p.Method, p.Params); err != nil {
			return err
		}

		if IsWriteMethod(p.Method) {
			if env.ExpiresAt == "" {
				return fmt.Errorf("write method %q requires expiresAt", p.Method)
			}
			if err := ValidateTimestamp(env.ExpiresAt); err != nil {
				return fmt.Errorf("invalid expiresAt timestamp %q: %w", env.ExpiresAt, err)
			}
			if env.IdempotencyKey == "" {
				return fmt.Errorf("write method %q requires idempotencyKey", p.Method)
			}
			if err := ValidateIdempotencyKey(env.IdempotencyKey); err != nil {
				return fmt.Errorf("invalid idempotencyKey %q: %w", env.IdempotencyKey, err)
			}
		} else {
			if env.ExpiresAt != "" {
				if err := ValidateTimestamp(env.ExpiresAt); err != nil {
					return fmt.Errorf("invalid expiresAt timestamp %q: %w", env.ExpiresAt, err)
				}
			}
			if env.IdempotencyKey != "" {
				if err := ValidateIdempotencyKey(env.IdempotencyKey); err != nil {
					return fmt.Errorf("invalid idempotencyKey %q: %w", env.IdempotencyKey, err)
				}
			}
		}

	case FrameTypeRpcResponse:
		if env.HostID == "" {
			return errors.New("rpc.response frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on rpc.response frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on rpc.response frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on rpc.response frame")
		}
		if _, err := unmarshalRpcResponsePayload(env.Payload); err != nil {
			return fmt.Errorf("invalid rpc.response payload: %w", err)
		}

	case FrameTypeEvent:
		if env.HostID == "" {
			return errors.New("event frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on event frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on event frame")
		}
		if env.Seq == nil {
			return errors.New("event frame requires seq")
		}
		if err := ValidateSeq(*env.Seq); err != nil {
			return fmt.Errorf("invalid event seq: %w", err)
		}
		if _, err := unmarshalEventPayload(env.Payload); err != nil {
			return fmt.Errorf("invalid event payload: %w", err)
		}

	case FrameTypeResume:
		if env.HostID == "" {
			return errors.New("resume frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on resume frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on resume frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on resume frame")
		}
		if _, err := unmarshalResumePayload(env.Payload); err != nil {
			return fmt.Errorf("invalid resume payload: %w", err)
		}

	case FrameTypeSnapshot:
		if env.HostID == "" {
			return errors.New("snapshot frame requires hostId")
		}
		if err := ValidateRemoteID(env.HostID); err != nil {
			return fmt.Errorf("invalid hostId %q: %w", env.HostID, err)
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on snapshot frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on snapshot frame")
		}
		if env.Seq == nil {
			return errors.New("snapshot frame requires seq")
		}
		if err := ValidateSeq(*env.Seq); err != nil {
			return fmt.Errorf("invalid snapshot seq: %w", err)
		}
		if _, err := unmarshalSnapshotPayload(env.Payload); err != nil {
			return fmt.Errorf("invalid snapshot payload: %w", err)
		}

	case FrameTypePing:
		if env.HostID != "" {
			return errors.New("hostId is not permitted on ping frame")
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on ping frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on ping frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on ping frame")
		}
		if _, err := unmarshalPingPayload(env.Payload); err != nil {
			return fmt.Errorf("invalid ping payload: %w", err)
		}

	case FrameTypePong:
		if env.HostID != "" {
			return errors.New("hostId is not permitted on pong frame")
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on pong frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on pong frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on pong frame")
		}
		if _, err := unmarshalPongPayload(env.Payload); err != nil {
			return fmt.Errorf("invalid pong payload: %w", err)
		}

	case FrameTypeServerDraining:
		if env.HostID != "" {
			return errors.New("hostId is not permitted on server.draining frame")
		}
		if env.ExpiresAt != "" {
			return errors.New("expiresAt is not permitted on server.draining frame")
		}
		if env.IdempotencyKey != "" {
			return errors.New("idempotencyKey is not permitted on server.draining frame")
		}
		if env.Seq != nil {
			return errors.New("seq is not permitted on server.draining frame")
		}
		if _, err := unmarshalServerDrainingPayload(env.Payload); err != nil {
			return fmt.Errorf("invalid server.draining payload: %w", err)
		}
	}

	return nil
}

// EncodeEnvelope marshals an envelope into UTF-8 JSON bytes and asserts frame length constraints.
func EncodeEnvelope(env *Envelope) ([]byte, error) {
	if env == nil {
		return nil, errors.New("cannot encode nil envelope")
	}
	data, err := json.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal envelope: %w", err)
	}
	if int64(len(data)) > MaxAllowedFrameBytes {
		return nil, fmt.Errorf("encoded frame size %d exceeds limit of %d bytes", len(data), MaxAllowedFrameBytes)
	}
	return data, nil
}

func unmarshalStrict(data []byte, v interface{}) error {
	if len(data) == 0 {
		return errors.New("empty payload")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing data in payload")
	}
	return nil
}

// NewConnectionLimits derives schema-compliant wire ConnectionLimits matching server configuration.
func NewConnectionLimits(heartbeatInterval, challengeTTL, rpcTimeout time.Duration) ConnectionLimits {
	limits := DefaultConnectionLimits()

	if heartbeatInterval >= 5*time.Second && heartbeatInterval <= 120*time.Second {
		limits.HeartbeatIntervalMs = int(heartbeatInterval.Milliseconds())
	} else if heartbeatInterval > 120*time.Second {
		limits.HeartbeatIntervalMs = 120000
	} else if heartbeatInterval > 0 && heartbeatInterval < 5*time.Second {
		// Internal short watchdog in tests: wire limit stays schema-compliant at 5000ms minimum
		limits.HeartbeatIntervalMs = 5000
	}

	if challengeTTL >= 1*time.Second && challengeTTL <= 300*time.Second {
		limits.ChallengeTTLMs = int(challengeTTL.Milliseconds())
	} else if challengeTTL > 300*time.Second {
		limits.ChallengeTTLMs = 300000
	} else if challengeTTL > 0 && challengeTTL < 1*time.Second {
		limits.ChallengeTTLMs = 1000
	}

	if rpcTimeout >= 1*time.Second && rpcTimeout <= 60*time.Second {
		limits.RPCReadTimeoutMs = int(rpcTimeout.Milliseconds())
	} else if rpcTimeout > 60*time.Second {
		limits.RPCReadTimeoutMs = 60000
	} else if rpcTimeout > 0 && rpcTimeout < 1*time.Second {
		limits.RPCReadTimeoutMs = 1000
	}

	if rpcTimeout >= 1*time.Second && rpcTimeout <= 120*time.Second {
		limits.RPCWriteTimeoutMs = int(rpcTimeout.Milliseconds())
	} else if rpcTimeout > 120*time.Second {
		limits.RPCWriteTimeoutMs = 120000
	} else if rpcTimeout > 0 && rpcTimeout < 1*time.Second {
		limits.RPCWriteTimeoutMs = 1000
	}

	return limits
}

// Helper Envelope Constructors

// NewErrorEnvelope creates a protocol error frame.
func NewErrorEnvelope(reqID string, hostID string, errCode string, message string, retryable bool, details map[string]interface{}) *Envelope {
	errPayload := StructuredError{
		Code:      errCode,
		Message:   message,
		Retryable: retryable,
		Details:   details,
	}
	payloadBytes, _ := json.Marshal(errPayload)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	env := &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypeError,
		ID:      reqID,
		SentAt:  now,
		Payload: payloadBytes,
	}
	if hostID != "" {
		env.HostID = hostID
	}
	return env
}

// NewChallengeEnvelope creates a challenge frame for host authentication.
func NewChallengeEnvelope(msgID, connectionID, challenge, issuedAt, expiresAt string) *Envelope {
	p := ChallengePayload{
		ConnectionID: connectionID,
		Challenge:    challenge,
		IssuedAt:     issuedAt,
		ExpiresAt:    expiresAt,
	}
	payloadBytes, _ := json.Marshal(p)
	return &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypeChallenge,
		ID:      msgID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: payloadBytes,
	}
}

// NewAuthOkEnvelope creates an auth.ok frame.
func NewAuthOkEnvelope(msgID, connectionID, role, hostID string, limits ConnectionLimits) *Envelope {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	p := AuthOkPayload{
		ConnectionID: connectionID,
		Role:         role,
		HostID:       hostID,
		ServerTime:   now,
		Limits:       limits,
	}
	payloadBytes, _ := json.Marshal(p)
	env := &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypeAuthOk,
		ID:      msgID,
		SentAt:  now,
		Payload: payloadBytes,
	}
	if hostID != "" {
		env.HostID = hostID
	}
	return env
}

// NewPongEnvelope creates an application pong frame.
func NewPongEnvelope(msgID, nonce string) *Envelope {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	p := PongPayload{
		Nonce:      nonce,
		ServerTime: now,
	}
	payloadBytes, _ := json.Marshal(p)
	return &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypePong,
		ID:      msgID,
		SentAt:  now,
		Payload: payloadBytes,
	}
}

// NewServerDrainingEnvelope creates a server.draining frame.
func NewServerDrainingEnvelope(msgID, reason string, reconnectAfterMs int) *Envelope {
	p := ServerDrainingPayload{
		Reason:           reason,
		ReconnectAfterMs: reconnectAfterMs,
	}
	payloadBytes, _ := json.Marshal(p)
	return &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypeServerDraining,
		ID:      msgID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: payloadBytes,
	}
}
