package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestValidateRPCRequestParams_AllMethods(t *testing.T) {
	valid := map[string]string{
		"host.status":            `{}`,
		"sync.snapshot":          `{"conversationLimit":100}`,
		"project.list":           `{"cursor":"next","limit":1}`,
		"agent.list":             `{"projectId":"project_1","cursor":"next","limit":100}`,
		"conversation.list":      `{"projectId":"project_1","cursor":"next","limit":100}`,
		"conversation.get":       `{"conversationId":"conversation_1"}`,
		"message.list":           `{"conversationId":"conversation_1","cursor":"next","limit":100}`,
		"task.list":              `{"projectId":"project_1","conversationId":"conversation_1","cursor":"next","limit":100}`,
		"task.readLog":           `{"taskId":"task_1","cursor":"next","limit":100}`,
		"workflow.list":          `{"cursor":"next","limit":100}`,
		"workflow.get":           `{"workflowId":"workflow_1"}`,
		"delegation.list":        `{"cursor":"next","limit":100}`,
		"delegation.get":         `{"delegationId":"delegation_1"}`,
		"conversation.create":    `{"projectId":"project_1","title":"Title","agentId":"agent_1"}`,
		"conversation.rename":    `{"conversationId":"conversation_1","title":"Title"}`,
		"conversation.archive":   `{"conversationId":"conversation_1"}`,
		"conversation.delete":    `{"conversationId":"conversation_1"}`,
		"conversation.send":      `{"conversationId":"conversation_1","content":"hello"}`,
		"run.stop":               `{"runId":"run_1"}`,
		"permission.respond":     `{"decisionId":"decision_1","allow":true}`,
		"authentication.respond": `{"decisionId":"decision_1","allow":false}`,
		"workflow.start":         `{"workflowId":"workflow_1","conversationId":"conversation_1"}`,
		"workflow.stop":          `{"workflowId":"workflow_1"}`,
		"delegation.start":       `{"teamId":"team_1","conversationId":"conversation_1","prompt":"work"}`,
		"delegation.stop":        `{"delegationId":"delegation_1"}`,
		"terminal.create":        `{"projectId":"project_1","cols":20,"rows":5}`,
		"terminal.input":         `{"terminalId":"terminal_1","data":""}`,
		"terminal.resize":        `{"terminalId":"terminal_1","cols":300,"rows":100}`,
		"terminal.snapshot":      `{"terminalId":"terminal_1"}`,
		"terminal.close":         `{"terminalId":"terminal_1"}`,
	}

	if len(valid) != len(ReadMethods)+len(WriteMethods) {
		t.Fatalf("valid params table has %d methods, registry has %d", len(valid), len(ReadMethods)+len(WriteMethods))
	}

	for method, params := range valid {
		t.Run(method, func(t *testing.T) {
			if err := ValidateRPCRequestParams(method, json.RawMessage(params)); err != nil {
				t.Fatalf("valid params rejected: %v", err)
			}

			env := rpcRequestEnvelopeForTest(t, method, params)
			if err := ValidateEnvelope(env); err != nil {
				t.Fatalf("ValidateEnvelope rejected valid params: %v", err)
			}
			encoded, err := json.Marshal(env)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeEnvelope(encoded); err != nil {
				t.Fatalf("DecodeEnvelope rejected valid params: %v", err)
			}
		})
	}
}

func TestValidateRPCRequestParams_RejectsSchemaViolations(t *testing.T) {
	tooLongCursor := strings.Repeat("c", 257)
	tooLongTitle := strings.Repeat("t", 201)
	tooLongContent := strings.Repeat("x", 32769)
	tooManyChunkBytes := strings.Repeat("界", 11000)
	tooLongID := strings.Repeat("a", 129)

	tests := []struct {
		name   string
		method string
		params string
	}{
		{"params null", "host.status", `null`},
		{"params array", "host.status", `[]`},
		{"unknown field", "host.status", `{"extra":true}`},
		{"forbidden cwd is unknown", "host.status", `{"cwd":"/tmp"}`},
		{"missing required", "conversation.get", `{}`},
		{"required null", "conversation.get", `{"conversationId":null}`},
		{"optional null", "project.list", `{"cursor":null}`},
		{"wrong string type", "conversation.get", `{"conversationId":1}`},
		{"remote id pattern", "conversation.get", `{"conversationId":"bad id"}`},
		{"remote id too long", "conversation.get", fmt.Sprintf(`{"conversationId":%q}`, tooLongID)},
		{"cursor empty", "project.list", `{"cursor":""}`},
		{"cursor too long", "project.list", fmt.Sprintf(`{"cursor":%q}`, tooLongCursor)},
		{"limit too small", "project.list", `{"limit":0}`},
		{"limit too large", "project.list", `{"limit":101}`},
		{"limit non integer", "project.list", `{"limit":1.5}`},
		{"limit wrong type", "project.list", `{"limit":"1"}`},
		{"title empty", "conversation.rename", `{"conversationId":"conversation_1","title":""}`},
		{"title too long", "conversation.rename", fmt.Sprintf(`{"conversationId":"conversation_1","title":%q}`, tooLongTitle)},
		{"content empty", "conversation.send", `{"conversationId":"conversation_1","content":""}`},
		{"content too long", "conversation.send", fmt.Sprintf(`{"conversationId":"conversation_1","content":%q}`, tooLongContent)},
		{"prompt empty", "delegation.start", `{"teamId":"team_1","conversationId":"conversation_1","prompt":""}`},
		{"allow wrong type", "permission.respond", `{"decisionId":"decision_1","allow":"true"}`},
		{"cols too small", "terminal.create", `{"projectId":"project_1","cols":19}`},
		{"cols too large", "terminal.create", `{"projectId":"project_1","cols":301}`},
		{"cols non integer", "terminal.create", `{"projectId":"project_1","cols":20.5}`},
		{"rows too small", "terminal.create", `{"projectId":"project_1","rows":4}`},
		{"rows too large", "terminal.create", `{"projectId":"project_1","rows":101}`},
		{"chunk byte limit", "terminal.input", fmt.Sprintf(`{"terminalId":"terminal_1","data":%q}`, tooManyChunkBytes)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateRPCRequestParams(tc.method, json.RawMessage(tc.params)); err == nil {
				t.Fatal("ValidateRPCRequestParams accepted invalid params")
			}

			env := rpcRequestEnvelopeForTest(t, tc.method, tc.params)
			if err := ValidateEnvelope(env); err == nil {
				t.Fatal("ValidateEnvelope accepted invalid params")
			}
			encoded, err := json.Marshal(env)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeEnvelope(encoded); err == nil {
				t.Fatal("DecodeEnvelope accepted invalid params")
			}
		})
	}
}

func TestRPCRequestParamSpecsMatchAuthority(t *testing.T) {
	root := findProtocolRootDir(t)
	common := loadSchemaDocument(t, filepath.Join(root, "common.schema.json"))

	registryData, err := os.ReadFile(filepath.Join(root, "methods", "registry.json"))
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Methods []struct {
			Method string `json:"method"`
			Schema string `json:"schema"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(registryData, &registry); err != nil {
		t.Fatal(err)
	}

	seen := make(map[string]struct{}, len(registry.Methods))
	for _, method := range registry.Methods {
		seen[method.Method] = struct{}{}
		document := loadSchemaDocument(t, filepath.Join(root, filepath.FromSlash(method.Schema)))
		raw, ok := document.Defs[method.Method+".params"]
		if !ok {
			t.Fatalf("authority schema missing %s.params", method.Method)
		}
		resolvedRaw := resolveSchemaRaw(t, raw, common)
		node := decodeSchemaNode(t, resolvedRaw)
		assertOnlySchemaKeys(t, resolvedRaw, "type", "additionalProperties", "required", "properties")
		if node.Type != "object" || node.AdditionalProperties == nil || *node.AdditionalProperties {
			t.Fatalf("%s.params must be an object with additionalProperties:false", method.Method)
		}

		expected := make(map[string]rpcParamRule, len(node.Properties))
		required := make(map[string]struct{}, len(node.Required))
		for _, name := range node.Required {
			required[name] = struct{}{}
		}
		for name, propertyRaw := range node.Properties {
			resolvedPropertyRaw := resolveSchemaRaw(t, propertyRaw, common)
			property := decodeSchemaNode(t, resolvedPropertyRaw)
			assertOnlySchemaKeys(t, resolvedPropertyRaw, "type", "minLength", "maxLength", "pattern", "minimum", "maximum", "description")
			_, isRequired := required[name]
			expected[name] = schemaNodeToParamRule(t, name, property, isRequired)
		}

		actual, ok := rpcRequestParamSpecs[method.Method]
		if !ok {
			t.Fatalf("Go binding missing params spec for %s", method.Method)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("Go params binding drift for %s\nactual: %#v\nexpected: %#v", method.Method, actual, expected)
		}
	}

	if len(seen) != len(rpcRequestParamSpecs) {
		extra := make([]string, 0)
		for method := range rpcRequestParamSpecs {
			if _, ok := seen[method]; !ok {
				extra = append(extra, method)
			}
		}
		sort.Strings(extra)
		t.Fatalf("Go params binding has methods absent from authority: %v", extra)
	}
}

type rpcSchemaDocument struct {
	Defs map[string]json.RawMessage `json:"$defs"`
}

type rpcSchemaNode struct {
	Ref                  string                     `json:"$ref"`
	Type                 string                     `json:"type"`
	AdditionalProperties *bool                      `json:"additionalProperties"`
	Required             []string                   `json:"required"`
	Properties           map[string]json.RawMessage `json:"properties"`
	MinLength            *int                       `json:"minLength"`
	MaxLength            *int                       `json:"maxLength"`
	Pattern              string                     `json:"pattern"`
	Minimum              *int64                     `json:"minimum"`
	Maximum              *int64                     `json:"maximum"`
}

func loadSchemaDocument(t *testing.T, path string) rpcSchemaDocument {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document rpcSchemaDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func resolveSchemaRaw(t *testing.T, raw json.RawMessage, common rpcSchemaDocument) json.RawMessage {
	t.Helper()
	var reference struct {
		Ref string `json:"$ref"`
	}
	if err := json.Unmarshal(raw, &reference); err != nil {
		t.Fatal(err)
	}
	if reference.Ref == "" {
		return raw
	}
	name := reference.Ref[strings.LastIndex(reference.Ref, "/")+1:]
	resolved, ok := common.Defs[name]
	if !ok {
		t.Fatalf("unsupported or missing schema ref %q", reference.Ref)
	}
	return resolved
}

func decodeSchemaNode(t *testing.T, raw json.RawMessage) rpcSchemaNode {
	t.Helper()
	var node rpcSchemaNode
	if err := json.Unmarshal(raw, &node); err != nil {
		t.Fatal(err)
	}
	return node
}

func schemaNodeToParamRule(t *testing.T, name string, node rpcSchemaNode, required bool) rpcParamRule {
	t.Helper()
	switch node.Type {
	case "string":
		if node.MinLength == nil || node.MaxLength == nil {
			t.Fatalf("string param %s must define minLength and maxLength", name)
		}
		rule := rpcParamRule{kind: rpcParamString, required: required, minLength: *node.MinLength, maxLength: *node.MaxLength, pattern: node.Pattern}
		if name == "data" && *node.MaxLength == int(MaxAllowedChunkBytes) {
			rule.maxBytes = int(MaxAllowedChunkBytes)
		}
		return rule
	case "integer":
		if node.Minimum == nil || node.Maximum == nil {
			t.Fatalf("integer param %s must define minimum and maximum", name)
		}
		return integerParam(required, *node.Minimum, *node.Maximum)
	case "boolean":
		return booleanParam(required)
	default:
		t.Fatalf("unsupported authority param type %q for %s", node.Type, name)
		return rpcParamRule{}
	}
}

func assertOnlySchemaKeys(t *testing.T, raw json.RawMessage, allowed ...string) {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range object {
		if _, ok := allowedSet[key]; !ok {
			t.Fatalf("authority params schema uses unsupported keyword %q", key)
		}
	}
}

func rpcRequestEnvelopeForTest(t *testing.T, method, params string) *Envelope {
	t.Helper()
	payload, err := json.Marshal(RpcRequestPayload{Method: method, Params: json.RawMessage(params)})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	env := &Envelope{
		V:       ProtocolVersion,
		Type:    FrameTypeRpcRequest,
		ID:      "msg_rpc_params_test",
		HostID:  "host_1",
		SentAt:  now.Format(time.RFC3339Nano),
		Payload: payload,
	}
	if IsWriteMethod(method) {
		env.ExpiresAt = now.Add(time.Minute).Format(time.RFC3339Nano)
		env.IdempotencyKey = "abcdefghijklmnopqrstuv"
	}
	return env
}
