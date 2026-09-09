package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

type rpcParamKind uint8

const (
	rpcParamString rpcParamKind = iota + 1
	rpcParamInteger
	rpcParamBoolean
)

type rpcParamRule struct {
	kind      rpcParamKind
	required  bool
	minLength int
	maxLength int
	pattern   string
	minimum   int64
	maximum   int64
	maxBytes  int
}

const remoteIDPattern = `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`

func stringParam(required bool, minLength, maxLength int) rpcParamRule {
	return rpcParamRule{kind: rpcParamString, required: required, minLength: minLength, maxLength: maxLength}
}

func remoteIDParam(required bool) rpcParamRule {
	return rpcParamRule{kind: rpcParamString, required: required, minLength: 1, maxLength: 128, pattern: remoteIDPattern}
}

func integerParam(required bool, minimum, maximum int64) rpcParamRule {
	return rpcParamRule{kind: rpcParamInteger, required: required, minimum: minimum, maximum: maximum}
}

func booleanParam(required bool) rpcParamRule {
	return rpcParamRule{kind: rpcParamBoolean, required: required}
}

var rpcRequestParamSpecs = map[string]map[string]rpcParamRule{
	"host.status": {},
	"sync.snapshot": {
		"conversationLimit": integerParam(false, 1, 100),
	},
	"project.list": {
		"cursor": stringParam(false, 1, 256),
		"limit":  integerParam(false, 1, 100),
	},
	"agent.list": {
		"projectId": remoteIDParam(false),
		"cursor":    stringParam(false, 1, 256),
		"limit":     integerParam(false, 1, 100),
	},
	"conversation.list": {
		"projectId": remoteIDParam(false),
		"cursor":    stringParam(false, 1, 256),
		"limit":     integerParam(false, 1, 100),
	},
	"conversation.get": {
		"conversationId": remoteIDParam(true),
	},
	"message.list": {
		"conversationId": remoteIDParam(true),
		"cursor":         stringParam(false, 1, 256),
		"limit":          integerParam(false, 1, 100),
	},
	"task.list": {
		"projectId":      remoteIDParam(false),
		"conversationId": remoteIDParam(false),
		"cursor":         stringParam(false, 1, 256),
		"limit":          integerParam(false, 1, 100),
	},
	"task.readLog": {
		"taskId": remoteIDParam(true),
		"cursor": stringParam(false, 1, 256),
		"limit":  integerParam(false, 1, 100),
	},
	"workflow.list": {
		"cursor": stringParam(false, 1, 256),
		"limit":  integerParam(false, 1, 100),
	},
	"workflow.get": {
		"workflowId": remoteIDParam(true),
	},
	"delegation.list": {
		"cursor": stringParam(false, 1, 256),
		"limit":  integerParam(false, 1, 100),
	},
	"delegation.get": {
		"delegationId": remoteIDParam(true),
	},
	"conversation.create": {
		"projectId": remoteIDParam(true),
		"title":     stringParam(false, 1, 200),
		"agentId":   remoteIDParam(false),
	},
	"conversation.rename": {
		"conversationId": remoteIDParam(true),
		"title":          stringParam(true, 1, 200),
	},
	"conversation.archive": {
		"conversationId": remoteIDParam(true),
	},
	"conversation.delete": {
		"conversationId": remoteIDParam(true),
	},
	"conversation.send": {
		"conversationId": remoteIDParam(true),
		"content":        stringParam(true, 1, 32768),
	},
	"run.stop": {
		"runId": remoteIDParam(true),
	},
	"permission.respond": {
		"decisionId": remoteIDParam(true),
		"allow":      booleanParam(true),
	},
	"authentication.respond": {
		"decisionId": remoteIDParam(true),
		"allow":      booleanParam(true),
	},
	"workflow.start": {
		"workflowId":     remoteIDParam(true),
		"conversationId": remoteIDParam(false),
	},
	"workflow.stop": {
		"workflowId": remoteIDParam(true),
	},
	"delegation.start": {
		"teamId":         remoteIDParam(true),
		"conversationId": remoteIDParam(true),
		"prompt":         stringParam(true, 1, 32768),
	},
	"delegation.stop": {
		"delegationId": remoteIDParam(true),
	},
	"terminal.create": {
		"projectId": remoteIDParam(true),
		"cols":      integerParam(false, 20, 300),
		"rows":      integerParam(false, 5, 100),
	},
	"terminal.input": {
		"terminalId": remoteIDParam(true),
		"data":       {kind: rpcParamString, required: true, minLength: 0, maxLength: 32768, maxBytes: int(MaxAllowedChunkBytes)},
	},
	"terminal.resize": {
		"terminalId": remoteIDParam(true),
		"cols":       integerParam(true, 20, 300),
		"rows":       integerParam(true, 5, 100),
	},
	"terminal.snapshot": {
		"terminalId": remoteIDParam(true),
	},
	"terminal.close": {
		"terminalId": remoteIDParam(true),
	},
}

// ValidateRPCRequestParams validates rpc.request params against the frozen v1 method schemas.
func ValidateRPCRequestParams(method string, raw json.RawMessage) error {
	spec, ok := rpcRequestParamSpecs[method]
	if !ok {
		return fmt.Errorf("method %q is not registered in remote protocol v1", method)
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return errors.New("rpc.request params must be a non-null JSON object")
	}

	var params map[string]json.RawMessage
	if err := unmarshalStrict(trimmed, &params); err != nil {
		return fmt.Errorf("rpc.request params must be a JSON object: %w", err)
	}
	if params == nil {
		return errors.New("rpc.request params must be a non-null JSON object")
	}

	for name, rule := range spec {
		value, present := params[name]
		if rule.required && (!present || bytes.Equal(bytes.TrimSpace(value), []byte("null"))) {
			return fmt.Errorf("rpc.request params for %q missing required field %q", method, name)
		}
	}

	for name, value := range params {
		rule, allowed := spec[name]
		if !allowed {
			return fmt.Errorf("unknown field %q in rpc.request params for %q", name, method)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("rpc.request params field %q for %q must not be null", name, method)
		}
		if err := validateRPCParamValue(name, value, rule); err != nil {
			return fmt.Errorf("invalid rpc.request params for %q: %w", method, err)
		}
	}

	return nil
}

func validateRPCParamValue(name string, raw json.RawMessage, rule rpcParamRule) error {
	switch rule.kind {
	case rpcParamString:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("field %q must be a string", name)
		}
		length := utf8.RuneCountInString(value)
		if length < rule.minLength || length > rule.maxLength {
			return fmt.Errorf("field %q length %d out of bounds [%d, %d]", name, length, rule.minLength, rule.maxLength)
		}
		if rule.pattern == remoteIDPattern && !remoteIDRegex.MatchString(value) {
			return fmt.Errorf("field %q does not match RemoteId", name)
		}
		if rule.maxBytes > 0 && len([]byte(value)) > rule.maxBytes {
			return fmt.Errorf("field %q UTF-8 byte length %d exceeds %d", name, len([]byte(value)), rule.maxBytes)
		}
		return nil

	case rpcParamInteger:
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var value any
		if err := dec.Decode(&value); err != nil {
			return fmt.Errorf("field %q must be an integer", name)
		}
		number, ok := value.(json.Number)
		if !ok {
			return fmt.Errorf("field %q must be an integer", name)
		}
		parsed, err := strconv.ParseFloat(number.String(), 64)
		if err != nil || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed {
			return fmt.Errorf("field %q must be an integer", name)
		}
		if parsed < float64(rule.minimum) || parsed > float64(rule.maximum) {
			return fmt.Errorf("field %q value %s out of bounds [%d, %d]", name, number, rule.minimum, rule.maximum)
		}
		return nil

	case rpcParamBoolean:
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("field %q must be a boolean", name)
		}
		return nil

	default:
		return fmt.Errorf("field %q has unsupported validation rule", name)
	}
}
