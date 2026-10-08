# 文件变更内容存储

ACP 文件变更在 `acpRuntime.ts` 发出流事件前写入 SQLite 的 `file_edit_blobs` 表。正文保存修改当时的 `oldText`、`newText` 和 `patch`，流消息只保存文件信息及 `blobKey`。现有 12K 字符串截断和 400K 消息预算保持不变。

同机运行的 agy-acp 可通过初始化能力 `_meta.freebuddy.localDiffFiles: 1` 协商大 diff 传输。小消息直接上报；大 diff 写入系统临时目录中的私有文件，ACP 只携带路径、SHA-256 和字节数，每条通知连同 JSON-RPC 信封最多 64 KiB。FreeBuddy 仅为 `agy-acp` 导入该引用，校验临时目录命名及归属、普通文件类型（拒绝符号链接）、文件大小、校验和与正文结构，单文件最多 8 MiB、4096 条差异。导入后沿用 SQLite 正文存储和前端按需读取，成功写入后删除临时文件；导入失败显示不完整提示，存储失败也不会将大段正文传给 renderer。旧版或未声明能力的客户端会收到受限且明确标记的记录。agy-acp 和 FreeBuddy 两端需同时包含此协议实现，历史截断记录不会因此补全。

每个引用包含会话、运行、工具调用、条目位置及内容的身份信息。相同事件重放会复用引用，内容更新生成新引用；已有引用对应的正文不会被覆盖。当前条目和工具执行状态单独更新，失败或未完成的工具不会出现在历史文件变更列表中。删除会话时，数据库外键级联删除对应正文。

`cli:listMessageFileEdits` 按消息关联的运行读取轻量索引，每页最多 100 条，即使流消息中的文件变更已被总预算淘汰，仍可恢复卡片。`cli:readFileEditBlob` 校验会话归属，按最多 64 KiB 的字节块返回 UTF-8 JSON，正文不会重新写回会话消息。

加载历史详情时，日志中的文件变更先按原会话、运行、工具条目及内容恢复为已保存的引用，再交给前端合并。恢复只读数据库，不会重新激活旧版本或覆盖索引；无法匹配的旧内嵌记录仍保留，不按文件路径粗暴去重。

转接或分享会话时，在生成独立历史快照的过程中读取引用对应的正文，再应用原有脱敏和容量限制，不把正文写回聊天消息。每个正文字段最多截取 16K 字符，每条消息补回正文的总量也有限制；超限或缺失会标记快照不完整。生成后的快照不依赖源会话的正文表，因此删除源会话不会使已生成的快照失效。旧快照不会自动补全，需重新转接或分享。

卡片加载时仅查询索引。点击文件后才读取正文，前端合并分块、计算差异并缓存结果，统计在读取后更新。快速切换文件时忽略过期响应；读取失败或内容缺失可以重试。正文缓存最多 32 项，并受 8 MiB 内存预算约束；单次预览最多读取 8 MiB 的序列化内容，超限会显示大文件提示。数据库保存正文不受这一预览限制影响。

此实现覆盖 ACP 已上报的结构化文件变更。旧会话中已经截断且没有独立存储的正文无法自动恢复。现有差异算法对字符数、行数和计算规模的限制继续生效；超大文件展示和其他适配器的快照采集不包含在本次变更中。

Markdown 差异默认以 14px 字号自动换行，可切换为横向滚动。文件选择与该文件的修改记录分别展示，上一条/下一条及 Alt+↑/↓ 只在当前文件内切换。全宽阅读使用原生 dialog，Esc 返回侧栏，保留当前预览版本及展开状态。

完整的 Markdown 正文可切换源码差异与修改前/修改后预览；局部片段、仅有补丁、截断或超限的记录不提供完整文档预览。Antigravity 上游文本末尾的 `<truncated N bytes>` / `<truncated N lines>` 也会识别为不完整内容，即使正文已独立存储；此类记录不显示增删统计，可展开查看已捕获的原始内容，不尝试补造丢失的文本。

Markdown 阅读手动验证页面为 `http://127.0.0.1:5189/tests/fixtures/markdown-diff-preview.html`，使用模拟记录检查文件内历史切换、按需正文读取、任务列表及表格预览、窄面板换行、全宽/Esc、深浅主题与截断提示。

验证命令：

```sh
npm run typecheck
npm run build:electron
node --test tests/file-edit-content.test.mjs tests/file-diff.test.mjs tests/stream-media.test.mjs tests/remote-channel-policy.test.mjs
node --test tests/acp-local-diff.test.mjs tests/acp.test.mjs
node --test tests/message-details.test.mjs tests/handoff-transcript.test.mjs tests/handoff-context-mcp.test.mjs tests/handoff-transfer-wiring.test.mjs
npm run test:file-edit-db
```

浏览器手动验证：运行 `npm exec vite -- --host 127.0.0.1 --port 5189`，打开 `http://127.0.0.1:5189/tests/fixtures/file-edit-lazy-preview.html`。该页面使用模拟接口，不会修改真实会话；可检查首次打开零正文请求、长文件分块加载、失败重试、缺失提示、缓存复用及会话切换。
