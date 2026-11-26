# 通过 Scheme 链接接入 MCP 服务器

第三方网站、MCP 市场、文档站点或本地工具可以通过 `freebuddy://` URL scheme 链接一键唤起 FreeBuddy 桌面端并预填 MCP（Model Context Protocol）服务器配置，省去用户手动复制命令行、URL 和环境变量的步骤。

## 协议与入口

| 场景 | 支持的 Scheme / 路径 | 说明 |
|---|---|---|
| 系统级唤起（正式版） | `freebuddy://mcp/install`<br>`freebuddy://mcp/import` | 点击网页链接或系统 `open` / 协议拉起时由正式版 FreeBuddy 响应 |
| 系统级唤起（本地开发） | `freebuddy-dev://mcp/install`<br>`freebuddy-dev://mcp/import` | 仅在 `npm run dev` 模式下使用，与正式版互不干扰 |
| 应用内「通过链接导入」 | `freebuddy://`、`freebuddy-dev://`<br>`cursor://anysphere.cursor-deeplink/mcp/install`<br>`vscode:mcp/install`、`vscode://mcp/install`<br>`vscode-insiders:mcp/install` | 在 **设置 → MCP 服务器 → 通过链接导入** 粘贴时额外兼容 Cursor / VS Code 安装链接 |

> **说明**：系统级协议唤起仅接受 `freebuddy://` 与 `freebuddy-dev://`（生产包会忽略 `freebuddy-dev://`）；若第三方网页已有 Cursor / VS Code 链接，用户也可直接复制后在 FreeBuddy 设置页粘贴导入。

## 支持的传参格式

### 格式 1（推荐）：`name` + Base64 UTF-8 JSON `config`

与 Cursor MCP deeplink 保持兼容，最适合包含参数数组、环境变量或请求头的完整配置：

```text
freebuddy://mcp/install?name=<服务器名称>&config=<encodeURIComponent(base64(utf8(JSON)))>
```

- `config` 支持标准 Base64、Base64url（无 `=` 填充也可），也兼容 URL 编码后的原始 JSON 对象（以 `{` 开头）。
- 建议对 Base64 结果使用 `encodeURIComponent`（尤其是包含 `+`、`/`、`=` 时）；若使用 UTF-8 字符（如中文路径或说明），请先按 UTF-8 编码字节后再转 Base64，不要直接对含非 ASCII 字符的字符串调用浏览器 `btoa`。
- `config` 可以是单个服务器对象，也可以是 `{ "mcpServers": { "<name>": { ... } } }` 或 `{ "servers": { "<name>": { ... } } }` 包装格式（当包含多个服务时，必须通过外层 `?name=` 指定目标服务名）。

#### 示例 A：本地 `stdio` 服务（含机密变量占位符）

原始 JSON：

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": ""
  }
}
```

生成链接：

```text
freebuddy://mcp/install?name=github&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZXJ2ZXItZ2l0aHViIl0sImVudiI6eyJHSVRIVUJfUEVSU09OQUxfQUNDRVNTX1RPS0VOIjoiIn19
```

#### 示例 B：远程 Streamable HTTP 服务（含请求头占位符）

原始 JSON：

```json
{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": ""
  }
}
```

生成链接：

```text
freebuddy://mcp/install?name=my-http-mcp&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLmV4YW1wbGUuY29tL21jcCIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6IiJ9fQ%3D%3D
```

#### 示例 C：远程 SSE + 浏览器 OAuth 授权

原始 JSON：

```json
{
  "type": "sse",
  "url": "https://mcp.example.com/sse",
  "authType": "oauth",
  "oauthClientId": "your-client-id",
  "oauthScope": "mcp:tools"
}
```

生成链接：

```text
freebuddy://mcp/install?name=my-oauth-mcp&config=eyJ0eXBlIjoic3NlIiwidXJsIjoiaHR0cHM6Ly9tY3AuZXhhbXBsZS5jb20vc3NlIiwiYXV0aFR5cGUiOiJvYXV0aCIsIm9hdXRoQ2xpZW50SWQiOiJ5b3VyLWNsaWVudC1pZCIsIm9hdXRoU2NvcGUiOiJtY3A6dG9vbHMifQ%3D%3D
```

#### 示例 D：`mcpServers` 包装格式（使用 `${cwd}` 工作区占位符）

原始 JSON：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${cwd}"]
    }
  }
}
```

生成链接（可省略外层 `name`，将自动提取 `filesystem`）：

```text
freebuddy://mcp/install?config=eyJtY3BTZXJ2ZXJzIjp7ImZpbGVzeXN0ZW0iOnsiY29tbWFuZCI6Im5weCIsImFyZ3MiOlsiLXkiLCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2VydmVyLWZpbGVzeXN0ZW0iLCIke2N3ZH0iXX19fQ%3D%3D
```

### 格式 2：URL 编码 JSON 查询串（VS Code 兼容格式）

当不传 `config` 参数、直接把整个 JSON 编码作为 query 字符串时，FreeBuddy 同样支持解析：

```text
freebuddy://mcp/install?%7B%22name%22%3A%22memory%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-memory%22%5D%7D
```

### 格式 3：直接 Query 参数

适合极简的静态链接：

```text
freebuddy://mcp/install?name=fetch&command=uvx&arg=mcp-server-fetch
```

```text
freebuddy://mcp/install?name=remote-api&transport=http&url=https%3A%2F%2Fmcp.example.com%2Fmcp
```

支持的参数包括：`name`、`transport` / `type`、`command`、重复的 `arg`（或 `args` / JSON 数组格式的 `args`）、`url` / `serverUrl` / `httpUrl`、`authType`、`oauthClientId`、`oauthScope`、JSON 字符串格式的 `env` 与 `headers`。

## 字段与校验规则

### 配额限制

- 完整链接长度不超过 **32 KiB**（`32768` 字符）。
- 解码后的 JSON 配置不超过 **32 KiB**（`32768` 字节）。
- `args`、`env`、`headers` 各自条目数不超过 **64** 项。

### 字段说明

| 字段 | 适用传输 | 规则与说明 |
|---|---|---|
| `name` | 全部 | 保存时须匹配 `^[A-Za-z0-9_-]{1,48}$`，且不可与已有服务重名（不区分大小写）、不可用 `freebuddy` 前缀、不可用内置保留名（`office-engine` 等）。若链接中的名称含空格或特殊字符，导入预览时会自动规范化为 `-` 并给出提示，用户可在表单中修改。 |
| `transport` / `type` | 全部 | 可选 `stdio`、`http`（兼容别名 `streamable-http`、`streamable_http`、`streamablehttp`、`remote`）、`sse`。<br>未传时自动推断：仅有 `command` 推断为 `stdio`；仅有 `url` 时路径以 `/sse` 结尾推断为 `sse`，否则推断为 `http`；同时传 `command` 与 `url` 且未显式指定 `transport` 会报错 `ambiguous_transport`。 |
| `command` | `stdio` | 必填非空字符串，不能包含换行或 `\0`。 |
| `args` | `stdio` | 可选字符串数组，单项不能包含换行或 `\0`；支持 `${cwd}` 代表当前对话的工作区路径。 |
| `env` | `stdio` | 支持 `{ "KEY": "VAL" }` 对象或 `[{ "name": "KEY", "value": "VAL", "secret": true }]` 数组；键名不能包含换行、`\0` 或 `=`。键名若以 `token`、`api_key`、`api-key`、`secret`、`password`、`passwd`、`pat`、`auth`、`credential`（含复数）结尾，会自动标为机密字段。 |
| `url`（兼容 `serverUrl`、`httpUrl`） | `http` / `sse` | 必填有效的 `http:` 或 `https:` 地址，必须含主机名，不允许携带 `user:pass@` 凭据或 `#fragment`。 |
| `authType` | `http` / `sse` | 可选 `headers`（默认）或 `oauth`。选择 `oauth` 时详见 [MCP 浏览器授权](mcp-oauth.md)。 |
| `headers` | `http` / `sse` (`authType=headers`) | 支持 `{ "Header": "Val" }` 对象或 `[{ "name": "Header", "value": "Val" }]` 数组；键名须符合 HTTP header token 规则且大小写不重复，值不能含换行或控制字符。所有请求头在保存时都会加密存储。 |
| `oauthClientId`、`oauthScope` | `http` / `sse` (`authType=oauth`) | 可选字符串，长度不超过 `2048`，不能包含控制字符。 |

## 第三方一键接入示例

### 1. HTML / Markdown 按钮

```html
<a href="freebuddy://mcp/install?name=fetch&command=uvx&arg=mcp-server-fetch">
  添加到 FreeBuddy
</a>
```

```markdown
[一键安装到 FreeBuddy](freebuddy://mcp/install?name=fetch&command=uvx&arg=mcp-server-fetch)
```

### 2. TypeScript / JavaScript（浏览器与 Node 通用）

```ts
export interface FreeBuddyMcpConfig {
  name: string;
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  authType?: "headers" | "oauth";
  oauthClientId?: string;
  oauthScope?: string;
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function buildFreeBuddyMcpLink(
  input: FreeBuddyMcpConfig,
  scheme: "freebuddy" | "freebuddy-dev" = "freebuddy"
): string {
  const { name, ...config } = input;
  const encoded = encodeBase64Utf8(JSON.stringify(config));
  return `${scheme}://mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(encoded)}`;
}
```

### 3. Python

```python
import base64
import json
import urllib.parse

config = {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${cwd}"],
}
b64 = base64.b64encode(json.dumps(config, separators=(",", ":")).encode("utf-8")).decode("ascii")
url = f"freebuddy://mcp/install?name={urllib.parse.quote('filesystem')}&config={urllib.parse.quote(b64)}"
print(url)
```

### 4. Shell（macOS / Linux）

```bash
CONFIG_B64=$(printf '{"command":"npx","args":["-y","@modelcontextprotocol/server-memory"]}' | base64 | tr -d '\n')
echo "freebuddy://mcp/install?name=memory&config=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$CONFIG_B64")"
```

## 安全与交互机制

1. **绝不静默保存或执行**：任何外部 scheme 链接只会将 FreeBuddy 主窗口前置，自动打开 **设置 → MCP 服务器** 的新建表单并预填参数，必须由用户审核后点击保存。对于 `stdio` 本地命令，界面还会强制要求用户手动勾选「允许在本机运行此命令」。
2. **凭据脱敏建议**：第三方页面生成的公开安装链接不要填入真实的 API Key 或 Token；建议把需要用户自行填写的环境变量或请求头设为 `""` 空占位符，FreeBuddy 会在导入表单顶部提示用户补全空值。FreeBuddy 自身的「复制分享链接」功能也会自动移除所有已存储的机密环境变量、请求头值以及命令参数中的敏感凭据。
3. **冲突与提示**：若导入的服务名称与本地已有服务器重名（不区分大小写），导入横幅会提前提示用户改名后再保存。

## 错误码速查

当链接无效时，FreeBuddy 会在 **设置 → MCP 服务器** 显示对应的错误提示：

| 错误码 | 说明 |
|---|---|
| `empty_link` | 链接为空 |
| `too_large` | 链接或解码后的配置超过 32 KiB 上限 |
| `invalid_url` | 不是合法的 URL 格式 |
| `unsupported_scheme` | 协议不受支持（系统唤起仅支持 `freebuddy://` / `freebuddy-dev://`；设置页粘贴额外支持 `cursor://`、`vscode:`、`vscode-insiders:`） |
| `unsupported_route` | 路径不受支持（应为 `mcp/install` 或 `mcp/import`） |
| `invalid_config` | `config` Base64 解码或 JSON 解析失败，或配置对象为空 |
| `multiple_servers_unsupported` | `mcpServers` / `servers` 包含多个服务器，且未通过 `?name=` 匹配到单个目标 |
| `invalid_transport` | `transport` / `type` 不是受支持的值 |
| `ambiguous_transport` | 同时传入 `command` 和 `url`，且未显式指定 `transport` / `type` |
| `missing_target` | 既未提供 `command` 也未提供 `url` |
| `invalid_command` | `command` 缺失、为空或包含换行/`\0` |
| `invalid_args` | `args` 不是字符串数组、超出 64 项或包含换行/`\0` |
| `invalid_remote_url` | `url` 不是合法的 `http`/`https` 地址，或包含登录凭据/`#fragment` |
| `invalid_env` | `env` 格式错误、超出 64 项、键名非法或含 `\0` |
| `invalid_header` | `headers` 格式错误、超出 64 项、请求头名称非法、大小写重复或值含非法字符 |
| `invalid_auth_type` | `authType` 不是 `headers` 或 `oauth` |
| `invalid_oauth_config` | `oauthClientId` 或 `oauthScope` 包含控制字符或超过 2048 字符 |

## 本地联调建议

1. 启动本地开发模式：
   ```bash
   npm run dev
   ```
2. 使用 `freebuddy-dev://` 协议唤起当前工作区的开发实例（macOS）：
   ```bash
   open "freebuddy-dev://mcp/install?name=demo-fetch&command=uvx&arg=mcp-server-fetch"
   ```
   或者直接在 **设置 → MCP 服务器 → 通过链接导入** 中粘贴任意 `freebuddy://`、`cursor://` 或 `vscode:` 链接预览效果。
