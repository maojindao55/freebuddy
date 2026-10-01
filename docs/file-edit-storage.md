# 文件变更内容存储

ACP 文件变更在 `acpRuntime.ts` 发出流事件前写入 SQLite 的 `file_edit_blobs` 表。正文保存修改当时的 `oldText`、`newText` 和 `patch`，流消息只保存文件信息及 `blobKey`。现有 12K 字符串截断和 400K 消息预算保持不变。

每个引用包含会话、运行、工具调用、条目位置及内容的身份信息。相同事件重放会复用引用，内容更新生成新引用；已有引用对应的正文不会被覆盖。当前条目和工具执行状态单独更新，失败或未完成的工具不会出现在历史文件变更列表中。删除会话时，数据库外键级联删除对应正文。

`cli:listMessageFileEdits` 按消息关联的运行读取轻量索引，每页最多 100 条，即使流消息中的文件变更已被总预算淘汰，仍可恢复卡片。`cli:readFileEditBlob` 校验会话归属，按最多 64 KiB 的字节块返回 UTF-8 JSON，正文不会重新写回会话消息。

加载历史详情时，日志中的文件变更先按原会话、运行、工具条目及内容恢复为已保存的引用，再交给前端合并。恢复只读数据库，不会重新激活旧版本或覆盖索引；无法匹配的旧内嵌记录仍保留，不按文件路径粗暴去重。

转接或分享会话时，在生成独立历史快照的过程中读取引用对应的正文，再应用原有脱敏和容量限制，不把正文写回聊天消息。每个正文字段最多截取 16K 字符，每条消息补回正文的总量也有限制；超限或缺失会标记快照不完整。生成后的快照不依赖源会话的正文表，因此删除源会话不会使已生成的快照失效。旧快照不会自动补全，需重新转接或分享。

卡片加载时仅查询索引。点击文件后才读取正文，前端合并分块、计算差异并缓存结果，统计在读取后更新。快速切换文件时忽略过期响应；读取失败或内容缺失可以重试。正文缓存最多 32 项，并受 8 MiB 内存预算约束；单次预览最多读取 8 MiB 的序列化内容，超限会显示大文件提示。数据库保存正文不受这一预览限制影响。

此实现覆盖 ACP 已上报的结构化文件变更。旧会话中已经截断且没有独立存储的正文无法自动恢复。现有差异算法对字符数、行数和计算规模的限制继续生效；超大文件展示和其他适配器的快照采集不包含在本次变更中。

验证命令：

```sh
npm run typecheck
npm run build:electron
node --test tests/file-edit-content.test.mjs tests/file-diff.test.mjs tests/stream-media.test.mjs tests/remote-channel-policy.test.mjs
node --test tests/message-details.test.mjs tests/handoff-transcript.test.mjs tests/handoff-context-mcp.test.mjs tests/handoff-transfer-wiring.test.mjs
npm run test:file-edit-db
```

浏览器手动验证：运行 `npm exec vite -- --host 127.0.0.1 --port 5189`，打开 `http://127.0.0.1:5189/tests/fixtures/file-edit-lazy-preview.html`。该页面使用模拟接口，不会修改真实会话；可检查首次打开零正文请求、长文件分块加载、失败重试、缺失提示、缓存复用及会话切换。
