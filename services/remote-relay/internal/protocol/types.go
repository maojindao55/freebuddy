package protocol

import "encoding/json"

// ProtocolVersion is the fixed protocol major version for v1.
const ProtocolVersion = 1

// Transport and stream limits defined by protocol/remote/v1.
const (
	MaxAllowedFrameBytes int64 = 262144           // 256 KiB
	MaxAllowedChunkBytes int64 = 32768            // 32 KiB
	MaxSeq               int64 = 9007199254740991 // 2^53 - 1 (Number.MAX_SAFE_INTEGER)
)

// Frame types defined in protocol/remote/v1/common.schema.json.
const (
	FrameTypeChallenge      = "challenge"
	FrameTypeHostAuth       = "host.auth"
	FrameTypeAdminAuth      = "admin.auth"
	FrameTypeAuthOk         = "auth.ok"
	FrameTypeError          = "error"
	FrameTypeRpcRequest     = "rpc.request"
	FrameTypeRpcResponse    = "rpc.response"
	FrameTypeEvent          = "event"
	FrameTypeResume         = "resume"
	FrameTypeSnapshot       = "snapshot"
	FrameTypePing           = "ping"
	FrameTypePong           = "pong"
	FrameTypeServerDraining = "server.draining"
)

// Error codes defined in protocol/remote/v1/errors.json.
const (
	ErrCodeInvalidRequest     = "invalid_request"
	ErrCodeUnsupportedVersion = "unsupported_version"
	ErrCodeUnauthorized       = "unauthorized"
	ErrCodeForbidden          = "forbidden"
	ErrCodeHostOffline        = "host_offline"
	ErrCodeMethodNotAllowed   = "method_not_allowed"
	ErrCodeRequestExpired     = "request_expired"
	ErrCodeDuplicateRequest   = "duplicate_request"
	ErrCodeRpcTimeout         = "rpc_timeout"
	ErrCodeBackpressure       = "backpressure"
	ErrCodeConflict           = "conflict"
	ErrCodeNotFound           = "not_found"
	ErrCodeInternalError      = "internal_error"
)

// Roles.
const (
	RoleHost  = "host"
	RoleAdmin = "admin"
)

// Envelope is the wire frame envelope for all WebSocket messages.
type Envelope struct {
	V              int                    `json:"v"`
	Type           string                 `json:"type"`
	ID             string                 `json:"id"`
	HostID         string                 `json:"hostId,omitempty"`
	SentAt         string                 `json:"sentAt"`
	ExpiresAt      string                 `json:"expiresAt,omitempty"`
	IdempotencyKey string                 `json:"idempotencyKey,omitempty"`
	Seq            *int64                 `json:"seq,omitempty"`
	Payload        json.RawMessage        `json:"payload"`
	Meta           map[string]interface{} `json:"meta,omitempty"`
}

// StructuredError represents protocol-level structured errors.
type StructuredError struct {
	Code      string                 `json:"code"`
	Message   string                 `json:"message"`
	Retryable bool                   `json:"retryable"`
	Details   map[string]interface{} `json:"details,omitempty"`
}

// ChallengePayload is sent from Relay to Host upon connection.
type ChallengePayload struct {
	ConnectionID string `json:"connectionId"`
	Challenge    string `json:"challenge"`
	IssuedAt     string `json:"issuedAt"`
	ExpiresAt    string `json:"expiresAt"`
}

// HostAuthPayload is sent from Host to Relay in response to a challenge.
type HostAuthPayload struct {
	HostID          string `json:"hostId"`
	KeyID           string `json:"keyId"`
	PublicKey       string `json:"publicKey"`
	Signature       string `json:"signature"`
	ClientVersion   string `json:"clientVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

// AdminAuthPayload is sent from Admin to Relay upon connection.
type AdminAuthPayload struct {
	AccessToken     string `json:"accessToken"`
	ClientVersion   string `json:"clientVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

// ConnectionLimits defines protocol connection limits sent in auth.ok.
type ConnectionLimits struct {
	MaxFrameBytes       int64 `json:"maxFrameBytes"`
	MaxChunkBytes       int64 `json:"maxChunkBytes"`
	MaxConcurrentRPCs   int   `json:"maxConcurrentRpcs"`
	RPCReadTimeoutMs    int   `json:"rpcReadTimeoutMs"`
	RPCWriteTimeoutMs   int   `json:"rpcWriteTimeoutMs"`
	HeartbeatIntervalMs int   `json:"heartbeatIntervalMs"`
	ChallengeTTLMs      int   `json:"challengeTtlMs"`
}

// DefaultConnectionLimits returns standard v1 connection limits.
func DefaultConnectionLimits() ConnectionLimits {
	return ConnectionLimits{
		MaxFrameBytes:       MaxAllowedFrameBytes, // 262144
		MaxChunkBytes:       MaxAllowedChunkBytes, // 32768
		MaxConcurrentRPCs:   16,
		RPCReadTimeoutMs:    15000,
		RPCWriteTimeoutMs:   30000,
		HeartbeatIntervalMs: 30000,
		ChallengeTTLMs:      60000,
	}
}

// AuthOkPayload is sent from Relay to Client on successful authentication.
type AuthOkPayload struct {
	ConnectionID string           `json:"connectionId"`
	Role         string           `json:"role"`
	HostID       string           `json:"hostId,omitempty"`
	ServerTime   string           `json:"serverTime"`
	Limits       ConnectionLimits `json:"limits"`
}

// RpcRequestPayload is sent from Admin to Host.
type RpcRequestPayload struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// RpcResponsePayload is sent from Host to Admin in response to an RPC request.
type RpcResponsePayload struct {
	RequestID string           `json:"requestId"`
	Ok        bool             `json:"ok"`
	Result    json.RawMessage  `json:"result,omitempty"`
	Error     *StructuredError `json:"error,omitempty"`
}

// EventPayload is sent from Host to Admin.
type EventPayload struct {
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
}

// ResumePayload is sent from Admin to Host/Relay to resume an event stream.
type ResumePayload struct {
	ResumeFrom int64 `json:"resumeFrom"`
}

// PingPayload is sent for application heartbeats.
type PingPayload struct {
	Nonce string `json:"nonce,omitempty"`
}

// PongPayload is sent in response to PingPayload.
type PongPayload struct {
	Nonce      string `json:"nonce,omitempty"`
	ServerTime string `json:"serverTime"`
}

// ServerDrainingPayload is sent from Relay to Client when shutting down.
type ServerDrainingPayload struct {
	Reason           string `json:"reason"`
	ReconnectAfterMs int    `json:"reconnectAfterMs"`
}

// HostStatus represents host runtime state.
type HostStatus struct {
	HostID               string `json:"hostId"`
	DisplayName          string `json:"displayName,omitempty"`
	Online               bool   `json:"online"`
	AppVersion           string `json:"appVersion"`
	ProtocolVersion      int    `json:"protocolVersion"`
	RemoteEnabled        bool   `json:"remoteEnabled"`
	ActiveRunCount       int    `json:"activeRunCount"`
	PendingDecisionCount int    `json:"pendingDecisionCount"`
	ActiveTerminalCount  int    `json:"activeTerminalCount"`
	ServerTime           string `json:"serverTime"`
}

// ProjectSummary represents a high-level project summary.
type ProjectSummary struct {
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
}

// AgentSummary represents an agent model summary.
type AgentSummary struct {
	AgentID   string `json:"agentId"`
	Name      string `json:"name"`
	Kind      string `json:"kind,omitempty"`
	Available bool   `json:"available"`
}

// ConversationSummary represents a conversation summary.
type ConversationSummary struct {
	ConversationID string `json:"conversationId"`
	ProjectID      string `json:"projectId,omitempty"`
	Title          string `json:"title"`
	Archived       bool   `json:"archived"`
	UpdatedAt      string `json:"updatedAt"`
	LastMessageAt  string `json:"lastMessageAt,omitempty"`
}

// MessageSummary represents a message item.
type MessageSummary struct {
	MessageID      string `json:"messageId"`
	ConversationID string `json:"conversationId"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	Truncated      *bool  `json:"truncated,omitempty"`
	CreatedAt      string `json:"createdAt"`
	RunID          string `json:"runId,omitempty"`
}

// TaskSummary represents a background task summary.
type TaskSummary struct {
	TaskID         string `json:"taskId"`
	Title          string `json:"title"`
	Status         string `json:"status"`
	ProjectID      string `json:"projectId,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	UpdatedAt      string `json:"updatedAt"`
}

// TaskLogItem represents a single log line in a task.
type TaskLogItem struct {
	Seq       int64  `json:"seq"`
	Text      string `json:"text"`
	CreatedAt string `json:"createdAt"`
}

// RunSummary represents an agent execution run.
type RunSummary struct {
	RunID          string `json:"runId"`
	ConversationID string `json:"conversationId"`
	AgentID        string `json:"agentId,omitempty"`
	Status         string `json:"status"`
	StartedAt      string `json:"startedAt,omitempty"`
}

// DecisionSummary represents a pending decision.
type DecisionSummary struct {
	DecisionID     string `json:"decisionId"`
	Kind           string `json:"kind"`
	RunID          string `json:"runId"`
	ConversationID string `json:"conversationId"`
	Summary        string `json:"summary"`
	Tool           string `json:"tool,omitempty"`
}

// WorkflowSummary represents a workflow state.
type WorkflowSummary struct {
	WorkflowID string `json:"workflowId"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	UpdatedAt  string `json:"updatedAt"`
}

// DelegationSummary represents a delegation state.
type DelegationSummary struct {
	DelegationID string `json:"delegationId"`
	TeamID       string `json:"teamId,omitempty"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	UpdatedAt    string `json:"updatedAt"`
}

// TerminalSummary represents an open terminal session.
type TerminalSummary struct {
	TerminalID string `json:"terminalId"`
	ProjectID  string `json:"projectId"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	CreatedAt  string `json:"createdAt,omitempty"`
}

// SnapshotPayload represents a full state synchronization snapshot.
type SnapshotPayload struct {
	BaseSeq           int64                 `json:"baseSeq"`
	Host              HostStatus            `json:"host"`
	Projects          []ProjectSummary      `json:"projects,omitempty"`
	Agents            []AgentSummary        `json:"agents,omitempty"`
	Conversations     []ConversationSummary `json:"conversations,omitempty"`
	ActiveRuns        []RunSummary          `json:"activeRuns,omitempty"`
	PendingDecisions  []DecisionSummary     `json:"pendingDecisions,omitempty"`
	ActiveWorkflows   []WorkflowSummary     `json:"activeWorkflows,omitempty"`
	ActiveDelegations []DelegationSummary   `json:"activeDelegations,omitempty"`
	ActiveTasks       []TaskSummary         `json:"activeTasks,omitempty"`
	ActiveTerminals   []TerminalSummary     `json:"activeTerminals,omitempty"`
}

// Event data payloads

// ConversationDeletedData is data for conversation.deleted.
type ConversationDeletedData struct {
	ConversationID string `json:"conversationId"`
}

// RunStartedData is data for run.started.
type RunStartedData struct {
	RunID          string `json:"runId"`
	ConversationID string `json:"conversationId"`
	AgentID        string `json:"agentId,omitempty"`
}

// RunStreamData is data for run.stream.
type RunStreamData struct {
	RunID          string          `json:"runId"`
	ConversationID string          `json:"conversationId,omitempty"`
	Item           json.RawMessage `json:"item"`
	Index          *int            `json:"index,omitempty"`
}

// RunTerminalData is data for run.finished and run.stopped.
type RunTerminalData struct {
	RunID          string `json:"runId"`
	ConversationID string `json:"conversationId"`
}

// RunFailedData is data for run.failed.
type RunFailedData struct {
	RunID          string          `json:"runId"`
	ConversationID string          `json:"conversationId"`
	Error          StructuredError `json:"error"`
}

// DecisionResolvedData is data for permission.resolved and authentication.resolved.
type DecisionResolvedData struct {
	DecisionID string `json:"decisionId"`
	Allow      bool   `json:"allow"`
}

// TaskLogAppendedData is data for task.log.appended.
type TaskLogAppendedData struct {
	TaskID string      `json:"taskId"`
	Item   TaskLogItem `json:"item"`
}

// TerminalOutputData is data for terminal.output.
type TerminalOutputData struct {
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"`
	Seq        int64  `json:"seq"`
	Truncated  *bool  `json:"truncated,omitempty"`
}

// TerminalClosedData is data for terminal.closed.
type TerminalClosedData struct {
	TerminalID string `json:"terminalId"`
}
