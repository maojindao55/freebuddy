import test from "node:test";
import assert from "node:assert/strict";

const {
  MCP_SCHEME_MAX_URL_LENGTH,
  MCP_SCHEME_MAX_PAYLOAD_BYTES,
  findSchemeUrlInArgv,
  isMcpSchemeUrl,
  parseMcpSchemeLink,
  buildMcpSchemeLink
} = await import("../dist-electron/shared/mcpSchemeLink.js");

function toBase64Utf8(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function toBase64UrlUtf8(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

test("isMcpSchemeUrl distinguishes MCP routes from other FreeBuddy scheme routes", () => {
  assert.equal(isMcpSchemeUrl("freebuddy://mcp/install?name=test&command=npx"), true);
  assert.equal(isMcpSchemeUrl("freebuddy:///mcp/install?name=test&command=npx"), true);
  assert.equal(isMcpSchemeUrl("freebuddy-dev://mcp/import?name=test&command=npx"), true);
  assert.equal(isMcpSchemeUrl("freebuddy://mcp/unknown"), true);

  assert.equal(isMcpSchemeUrl("freebuddy://preview"), false);
  assert.equal(isMcpSchemeUrl("freebuddy://share?id=123"), false);
  assert.equal(isMcpSchemeUrl("freebuddy://conversation-share/v1/abcdef"), false);
  assert.equal(isMcpSchemeUrl("cursor://anysphere.cursor-deeplink/mcp/install?name=a&config=e30="), false);
  assert.equal(isMcpSchemeUrl("not a url"), false);
});

test("findSchemeUrlInArgv finds quoted and case-insensitive scheme URLs", () => {
  assert.equal(
    findSchemeUrlInArgv([
      "C:\\Program Files\\FreeBuddy\\FreeBuddy.exe",
      "--allow-file-access",
      '"freebuddy-dev://mcp/install?name=demo&command=npx"'
    ]),
    "freebuddy-dev://mcp/install?name=demo&command=npx"
  );
  assert.equal(
    findSchemeUrlInArgv(["FreeBuddy", "FREEBUDDY://mcp/install?name=demo&command=npx"]),
    "FREEBUDDY://mcp/install?name=demo&command=npx"
  );
  assert.equal(
    findSchemeUrlInArgv(["FreeBuddy", "/tmp/project", "--open", "file.txt"]),
    undefined
  );
});

test("parseMcpSchemeLink parses Cursor-style base64 stdio config including UTF-8 and unencoded +", () => {
  // Choose JSON that produces '+' in standard base64 when encoded.
  const cfg = {
    command: "npx",
    args: ["-y", "@example/mcp", "--label=中文说明???>"],
    env: {
      PUBLIC_LABEL: "中文标签",
      GITHUB_TOKEN: "ghp_secret_value_12345"
    }
  };
  const b64 = toBase64Utf8(cfg);
  assert.ok(b64.includes("+") || b64.includes("/"), "fixture should exercise base64 symbols");
  // Simulate unencoded '+' in query string (URLSearchParams decodes '+' as space).
  const url = `freebuddy://mcp/install?name=my-stdio&config=${b64}`;
  const res = parseMcpSchemeLink(url);
  assert.equal(res.ok, true);
  assert.equal(res.source, "freebuddy");
  assert.equal(res.draft.name, "my-stdio");
  assert.equal(res.draft.transport, "stdio");
  assert.equal(res.draft.command, "npx");
  assert.deepEqual(res.draft.args, ["-y", "@example/mcp", "--label=中文说明???>"]);
  assert.deepEqual(res.draft.env, [
    { name: "PUBLIC_LABEL", value: "中文标签" },
    { name: "GITHUB_TOKEN", value: "ghp_secret_value_12345", secret: true }
  ]);
  assert.deepEqual(res.warnings, ["contains_secrets"]);
});

test("parseMcpSchemeLink supports base64url, raw JSON config, and freebuddy-dev", () => {
  const b64url = toBase64UrlUtf8({
    type: "sse",
    url: "https://mcp.example.com/sse",
    headers: { Authorization: "Bearer abc" }
  });
  const res1 = parseMcpSchemeLink(`freebuddy-dev://mcp/import?name=remote-sse&config=${b64url}`);
  assert.equal(res1.ok, true);
  assert.equal(res1.source, "freebuddy-dev");
  assert.equal(res1.draft.transport, "sse");
  assert.equal(res1.draft.url, "https://mcp.example.com/sse");
  assert.equal(res1.draft.authType, "headers");
  assert.deepEqual(res1.draft.headers, [
    { name: "Authorization", value: "Bearer abc", secret: true }
  ]);
  assert.deepEqual(res1.warnings, ["contains_secrets"]);

  const rawJsonUrl = `freebuddy://mcp/install?name=raw-json&config=${encodeURIComponent(
    JSON.stringify({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      authType: "oauth",
      oauthClientId: "pub-client",
      oauthScope: "read write"
    })
  )}`;
  const res2 = parseMcpSchemeLink(rawJsonUrl);
  assert.equal(res2.ok, true);
  assert.equal(res2.draft.transport, "http");
  assert.equal(res2.draft.authType, "oauth");
  assert.equal(res2.draft.oauthClientId, "pub-client");
  assert.equal(res2.draft.oauthScope, "read write");
  assert.deepEqual(res2.draft.headers, []);
});

test("parseMcpSchemeLink supports VS Code raw JSON query and mcpServers wrapper", () => {
  const vsCodePayload = encodeURIComponent(
    JSON.stringify({
      name: "My Server!",
      command: "uvx",
      args: ["mcp-server-fetch"]
    })
  );
  const res1 = parseMcpSchemeLink(`freebuddy://mcp/install?${vsCodePayload}`);
  assert.equal(res1.ok, true);
  assert.equal(res1.draft.name, "My-Server");
  assert.equal(res1.draft.command, "uvx");
  assert.deepEqual(res1.draft.args, ["mcp-server-fetch"]);
  assert.deepEqual(res1.warnings, ["name_normalized"]);

  const wrappedSingle = toBase64Utf8({
    mcpServers: {
      "weather-srv": {
        command: "node",
        args: ["server.js"]
      }
    }
  });
  const res2 = parseMcpSchemeLink(`freebuddy://mcp/install?config=${encodeURIComponent(wrappedSingle)}`);
  assert.equal(res2.ok, true);
  assert.equal(res2.draft.name, "weather-srv");
  assert.equal(res2.draft.command, "node");

  const wrappedMulti = toBase64Utf8({
    mcpServers: {
      alpha: { command: "npx", args: ["-y", "a"] },
      beta: { command: "npx", args: ["-y", "b"] }
    }
  });
  const resMatch = parseMcpSchemeLink(
    `freebuddy://mcp/install?name=BETA&config=${encodeURIComponent(wrappedMulti)}`
  );
  assert.equal(resMatch.ok, true);
  assert.equal(resMatch.draft.name, "BETA");
  assert.deepEqual(resMatch.draft.args, ["-y", "b"]);

  const resMultiErr = parseMcpSchemeLink(
    `freebuddy://mcp/install?config=${encodeURIComponent(wrappedMulti)}`
  );
  assert.equal(resMultiErr.ok, false);
  assert.equal(resMultiErr.errorCode, "multiple_servers_unsupported");
});

test("parseMcpSchemeLink supports direct query params and transport auto-inference", () => {
  const res1 = parseMcpSchemeLink(
    "freebuddy://mcp/install?name=direct-stdio&command=npx&arg=-y&arg=@test/mcp"
  );
  assert.equal(res1.ok, true);
  assert.equal(res1.draft.transport, "stdio");
  assert.deepEqual(res1.draft.args, ["-y", "@test/mcp"]);

  const res2 = parseMcpSchemeLink(
    `freebuddy://mcp/install?name=direct-args-json&command=npx&args=${encodeURIComponent('["-y","pkg"]')}`
  );
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.draft.args, ["-y", "pkg"]);

  const resSse = parseMcpSchemeLink(
    "freebuddy://mcp/install?name=auto-sse&url=https://example.com/v1/sse"
  );
  assert.equal(resSse.ok, true);
  assert.equal(resSse.draft.transport, "sse");

  const resHttp = parseMcpSchemeLink(
    "freebuddy://mcp/install?name=auto-http&url=https://example.com/mcp"
  );
  assert.equal(resHttp.ok, true);
  assert.equal(resHttp.draft.transport, "http");
});

test("parseMcpSchemeLink gates third-party schemes unless allowThirdPartySchemes is true", () => {
  const cfg = encodeURIComponent(toBase64Utf8({ command: "npx", args: ["-y", "pkg"] }));
  const cursorUrl = `cursor://anysphere.cursor-deeplink/mcp/install?name=pkg&config=${cfg}`;
  const vscodeUrl = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "pkg", command: "npx" }))}`;
  const vscodeSlashUrl = `vscode://mcp/install?${encodeURIComponent(JSON.stringify({ name: "pkg", url: "https://example.com/mcp" }))}`;
  const insidersUrl = `vscode-insiders:mcp/install?${encodeURIComponent(JSON.stringify({ name: "pkg", command: "uvx" }))}`;

  for (const url of [cursorUrl, vscodeUrl, vscodeSlashUrl, insidersUrl]) {
    const blocked = parseMcpSchemeLink(url);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, "unsupported_scheme");

    const allowed = parseMcpSchemeLink(url, { allowThirdPartySchemes: true });
    assert.equal(allowed.ok, true);
  }
});

test("parseMcpSchemeLink rejects malformed, oversized, and unsafe inputs", () => {
  assert.deepEqual(parseMcpSchemeLink("   "), { ok: false, errorCode: "empty_link" });

  const hugeUrl = `freebuddy://mcp/install?name=huge&command=npx&arg=${"a".repeat(MCP_SCHEME_MAX_URL_LENGTH)}`;
  assert.deepEqual(parseMcpSchemeLink(hugeUrl), { ok: false, errorCode: "too_large" });

  const hugeConfig = toBase64Utf8({ command: "npx", args: ["x".repeat(MCP_SCHEME_MAX_PAYLOAD_BYTES)] });
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=huge&config=${encodeURIComponent(hugeConfig)}`).errorCode,
    "too_large"
  );

  assert.equal(
    parseMcpSchemeLink("freebuddy://mcp/other?name=a&command=npx").errorCode,
    "unsupported_route"
  );
  assert.equal(
    parseMcpSchemeLink("freebuddy://mcp/install?name=bad&url=file:///etc/passwd").errorCode,
    "invalid_remote_url"
  );
  assert.equal(
    parseMcpSchemeLink("freebuddy://mcp/install?name=bad&url=https://user:pass@example.com/mcp").errorCode,
    "invalid_remote_url"
  );
  assert.equal(
    parseMcpSchemeLink("freebuddy://mcp/install?name=bad&url=https://example.com/mcp%23frag").errorCode,
    "invalid_remote_url"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp#frag" }))}`).errorCode,
    "invalid_remote_url"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ command: "npx\nrm" }))}`).errorCode,
    "invalid_command"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ command: "npx", args: ["-y\nevil"] }))}`).errorCode,
    "invalid_args"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp", headers: { "Bad Header": "1" } }))}`).errorCode,
    "invalid_header"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "a", authorization: "b" } }))}`).errorCode,
    "invalid_header"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer a\r\nX: 1" } }))}`).errorCode,
    "invalid_header"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp", authType: "basic" }))}`).errorCode,
    "invalid_auth_type"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ type: "http", url: "https://example.com/mcp", authType: "oauth", oauthClientId: "bad\nid" }))}`).errorCode,
    "invalid_oauth_config"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({ command: "npx", url: "https://example.com/mcp" }))}`).errorCode,
    "ambiguous_transport"
  );
  assert.equal(
    parseMcpSchemeLink(`freebuddy://mcp/install?name=bad&config=${encodeURIComponent(toBase64Utf8({}))}`).errorCode,
    "missing_target"
  );
});

test("buildMcpSchemeLink strips secrets and roundtrips cleanly via parseMcpSchemeLink", () => {
  const stdioWithSecrets = buildMcpSchemeLink({
    name: "github-mcp",
    transport: "stdio",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-github",
      "--api-key=secret_inline_123",
      "--token",
      "secret_flag_456",
      "Authorization: Bearer secret_bearer_789",
      "--mode=readonly"
    ],
    env: [
      { name: "GITHUB_TOKEN", secret: true, hasValue: true },
      { name: "LOG_LEVEL", value: "info", secret: false }
    ]
  });
  assert.equal(stdioWithSecrets.strippedSecrets, true);
  assert.ok(!stdioWithSecrets.url.includes("secret_inline_123"));
  assert.ok(!stdioWithSecrets.url.includes("secret_flag_456"));
  assert.ok(!stdioWithSecrets.url.includes("secret_bearer_789"));

  const parsedStdio = parseMcpSchemeLink(stdioWithSecrets.url);
  assert.equal(parsedStdio.ok, true);
  assert.equal(parsedStdio.draft.name, "github-mcp");
  assert.deepEqual(parsedStdio.draft.args, [
    "-y",
    "@modelcontextprotocol/server-github",
    "--api-key=",
    "--token",
    "",
    "Authorization: Bearer ",
    "--mode=readonly"
  ]);
  assert.deepEqual(parsedStdio.draft.env, [
    { name: "GITHUB_TOKEN", value: "", secret: true },
    { name: "LOG_LEVEL", value: "info" }
  ]);
  assert.deepEqual(parsedStdio.warnings, []);

  const remoteWithHeaders = buildMcpSchemeLink({
    name: "remote-api",
    transport: "http",
    url: "https://api.example.com/mcp",
    authType: "headers",
    headers: [{ name: "X-API-Key", secret: true, hasValue: true }]
  });
  assert.equal(remoteWithHeaders.strippedSecrets, true);
  const parsedRemote = parseMcpSchemeLink(remoteWithHeaders.url);
  assert.equal(parsedRemote.ok, true);
  assert.equal(parsedRemote.draft.transport, "http");
  assert.equal(parsedRemote.draft.url, "https://api.example.com/mcp");
  assert.deepEqual(parsedRemote.draft.headers, [
    { name: "X-API-Key", value: "", secret: true }
  ]);
  assert.deepEqual(parsedRemote.warnings, []);

  const oauthServer = buildMcpSchemeLink({
    name: "oauth-srv",
    transport: "sse",
    url: "https://oauth.example.com/sse",
    authType: "oauth",
    oauthClientId: "client-123",
    oauthScope: "mcp:tools"
  });
  assert.equal(oauthServer.strippedSecrets, false);
  const parsedOauth = parseMcpSchemeLink(oauthServer.url);
  assert.equal(parsedOauth.ok, true);
  assert.equal(parsedOauth.draft.transport, "sse");
  assert.equal(parsedOauth.draft.authType, "oauth");
  assert.equal(parsedOauth.draft.oauthClientId, "client-123");
  assert.equal(parsedOauth.draft.oauthScope, "mcp:tools");
});
