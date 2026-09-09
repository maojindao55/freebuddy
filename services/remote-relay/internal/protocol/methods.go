package protocol

import "strings"

// ReadMethods defines the frozen set of read-only v1 methods.
var ReadMethods = map[string]struct{}{
	"host.status":       {},
	"sync.snapshot":     {},
	"project.list":      {},
	"agent.list":        {},
	"conversation.list": {},
	"conversation.get":  {},
	"message.list":      {},
	"task.list":         {},
	"task.readLog":      {},
	"workflow.list":     {},
	"workflow.get":      {},
	"delegation.list":   {},
	"delegation.get":    {},
}

// WriteMethods defines the frozen set of write (state-mutating) v1 methods.
var WriteMethods = map[string]struct{}{
	"conversation.create":    {},
	"conversation.rename":    {},
	"conversation.archive":   {},
	"conversation.delete":    {},
	"conversation.send":      {},
	"run.stop":               {},
	"permission.respond":     {},
	"authentication.respond": {},
	"workflow.start":         {},
	"workflow.stop":          {},
	"delegation.start":       {},
	"delegation.stop":        {},
	"terminal.create":        {},
	"terminal.input":         {},
	"terminal.resize":        {},
	"terminal.snapshot":      {},
	"terminal.close":         {},
}

// Events defines the frozen set of v1 domain events.
var Events = map[string]struct{}{
	"host.status.changed":      {},
	"conversation.created":     {},
	"conversation.updated":     {},
	"conversation.deleted":     {},
	"message.created":          {},
	"message.updated":          {},
	"run.started":              {},
	"run.stream":               {},
	"run.finished":             {},
	"run.failed":               {},
	"run.stopped":              {},
	"permission.requested":     {},
	"permission.resolved":      {},
	"authentication.requested": {},
	"authentication.resolved":  {},
	"task.updated":             {},
	"task.log.appended":        {},
	"workflow.updated":         {},
	"delegation.updated":       {},
	"terminal.opened":          {},
	"terminal.output":          {},
	"terminal.closed":          {},
}

// ValidFrameTypes defines all 13 valid v1 frame types.
var ValidFrameTypes = map[string]struct{}{
	FrameTypeChallenge:      {},
	FrameTypeHostAuth:       {},
	FrameTypeAdminAuth:      {},
	FrameTypeAuthOk:         {},
	FrameTypeError:          {},
	FrameTypeRpcRequest:     {},
	FrameTypeRpcResponse:    {},
	FrameTypeEvent:          {},
	FrameTypeResume:         {},
	FrameTypeSnapshot:       {},
	FrameTypePing:           {},
	FrameTypePong:           {},
	FrameTypeServerDraining: {},
}

// IsReadMethod returns true if method is a recognized read method.
func IsReadMethod(method string) bool {
	_, ok := ReadMethods[method]
	return ok
}

// IsWriteMethod returns true if method is a recognized write method.
func IsWriteMethod(method string) bool {
	_, ok := WriteMethods[method]
	return ok
}

// IsValidMethod returns true if method is in the v1 registry.
func IsValidMethod(method string) bool {
	return IsReadMethod(method) || IsWriteMethod(method)
}

// IsValidEvent returns true if event is in the v1 event catalog.
func IsValidEvent(event string) bool {
	_, ok := Events[event]
	return ok
}

// IsValidFrameType returns true if frameType is one of the 13 v1 frame types.
func IsValidFrameType(frameType string) bool {
	_, ok := ValidFrameTypes[frameType]
	return ok
}

// IsForbiddenMethod returns true if the method attempts to use prohibited dangerous primitives.
func IsForbiddenMethod(method string) bool {
	m := strings.ToLower(method)
	return m == "ipc.invoke" ||
		m == "shell.exec" ||
		strings.HasPrefix(m, "ipc.") ||
		strings.HasPrefix(m, "shell.") ||
		strings.HasPrefix(m, "fs.")
}

// ValidErrorCodes defines the frozen set of v1 error codes.
var ValidErrorCodes = map[string]struct{}{
	ErrCodeInvalidRequest:     {},
	ErrCodeUnsupportedVersion: {},
	ErrCodeUnauthorized:       {},
	ErrCodeForbidden:          {},
	ErrCodeHostOffline:        {},
	ErrCodeMethodNotAllowed:   {},
	ErrCodeRequestExpired:     {},
	ErrCodeDuplicateRequest:   {},
	ErrCodeRpcTimeout:         {},
	ErrCodeBackpressure:       {},
	ErrCodeConflict:           {},
	ErrCodeNotFound:           {},
	ErrCodeInternalError:      {},
}

// IsValidErrorCode returns true if code is in the v1 error code registry.
func IsValidErrorCode(code string) bool {
	_, ok := ValidErrorCodes[code]
	return ok
}

// ValidRoles defines valid roles.
var ValidRoles = map[string]struct{}{
	"user":      {},
	"assistant": {},
	"system":    {},
}

// IsValidRole returns true if role is valid.
func IsValidRole(role string) bool {
	_, ok := ValidRoles[role]
	return ok
}

// ValidTaskStatuses defines valid task statuses.
var ValidTaskStatuses = map[string]struct{}{
	"pending":   {},
	"running":   {},
	"blocked":   {},
	"completed": {},
	"failed":    {},
	"cancelled": {},
}

// IsValidTaskStatus returns true if status is valid.
func IsValidTaskStatus(status string) bool {
	_, ok := ValidTaskStatuses[status]
	return ok
}

// ValidRunStatuses defines valid run statuses.
var ValidRunStatuses = map[string]struct{}{
	"running":  {},
	"finished": {},
	"failed":   {},
	"stopped":  {},
}

// IsValidRunStatus returns true if status is valid.
func IsValidRunStatus(status string) bool {
	_, ok := ValidRunStatuses[status]
	return ok
}

// ValidWorkflowStatuses defines valid workflow statuses.
var ValidWorkflowStatuses = map[string]struct{}{
	"idle":      {},
	"running":   {},
	"paused":    {},
	"blocked":   {},
	"completed": {},
	"failed":    {},
	"stopped":   {},
}

// IsValidWorkflowStatus returns true if status is valid.
func IsValidWorkflowStatus(status string) bool {
	_, ok := ValidWorkflowStatuses[status]
	return ok
}

// ValidDelegationStatuses defines valid delegation statuses.
var ValidDelegationStatuses = map[string]struct{}{
	"idle":      {},
	"running":   {},
	"blocked":   {},
	"completed": {},
	"failed":    {},
	"stopped":   {},
}

// IsValidDelegationStatus returns true if status is valid.
func IsValidDelegationStatus(status string) bool {
	_, ok := ValidDelegationStatuses[status]
	return ok
}
