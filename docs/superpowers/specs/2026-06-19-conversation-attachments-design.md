# Conversation Attachments Design

## Goal

FreeBuddy conversations should let users attach local files to a message. CLI agents receive the original local file paths in the prompt, while the conversation UI keeps user messages readable and shows attachment metadata.

This is path-based attachment support. FreeBuddy will not upload, copy, encode, or read file contents during send.

## Scope

- Support selected local files with these extensions:
  - Images: `png`, `jpg`, `jpeg`, `webp`, `gif`
  - Documents/text: `pdf`, `txt`, `md`, `json`, `csv`, `log`
  - Code/config: `ts`, `tsx`, `js`, `jsx`, `py`, `rs`, `go`, `java`, `php`, `html`, `css`, `scss`, `yaml`, `yml`, `toml`, `xml`, `sh`
- Allow up to 10 attachments per message.
- Reject attachments larger than 50 MB.
- Store only attachment metadata: id, kind, name, path, mime type, extension, and size.
- Show pending attachments above the composer before send.
- Let users remove pending attachments before send.
- Show sent attachments in user message bubbles.
- Allow text-only, attachment-only, and text-plus-attachment messages.
- Preserve existing text-only conversation behavior.

Out of scope:

- Server upload.
- Copying files into app data.
- Reading file bytes into the prompt.
- Multimodal API payloads.
- Drag-and-drop and paste attachments.
- Image thumbnail rendering in this first pass, because Electron would need an additional safe local-file URL bridge.

## Message Model

Add a shared `ChatAttachment` type:

```ts
export interface ChatAttachment {
  id: string;
  kind: "image" | "document" | "code";
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  extension?: string;
}
```

Add optional `attachments?: ChatAttachment[]` to `ConversationMessage` and `AppendMessageInput`.

Database compatibility:

- Add a nullable `attachments` JSON column to `conversation_messages`.
- Existing rows load as messages with no attachments.
- User message `content` stays the human-authored text, not the composed agent prompt.

## UX Behavior

The existing `Attach` buttons become functional in both active conversations and the new-task home. Selecting files opens a multi-file dialog. Valid files appear in a compact pending tray with filename, type/size, path, and a remove button.

Send is enabled when either text or attachments exist. When a message is sent, pending attachments clear immediately. User message bubbles render the text and a compact attachment list below it. Attachment-only messages show no artificial text in the bubble, but the agent still receives a fallback prompt body.

Errors are shown through the existing preflight warning area:

- Unsupported file type: skip the file and show a concise warning.
- File too large: skip the file and show a concise warning.
- Too many files: keep the first 10 unique paths and show a concise warning.
- Dialog cancellation: no-op.

## Agent Prompt

The store sends a composed prompt to the CLI runtime:

```text
用户消息：
请分析这个截图和日志

附件：
- screenshot.png (image/png, 1.2 MB): /Users/me/Desktop/screenshot.png
- error.log (text/plain, 45 KB): /Users/me/Desktop/error.log
```

For attachment-only messages:

```text
用户消息：
请查看这些附件。

附件：
- screenshot.png (image/png, 1.2 MB): /Users/me/Desktop/screenshot.png
```

The composed prompt is used only for the runtime task prompt and task history. The persisted user message content remains the user's visible text.

## Architecture

- `src/utils/chatAttachments.ts` owns attachment classification, validation, formatting, and prompt composition.
- `electron/cli/ipc.ts` adds `cli:selectAttachments`, using Electron's `showOpenDialog` with `openFile` and `multiSelections`, returning stat-based metadata.
- `electron/preload.ts`, `src/types/freebuddy.d.ts`, and `src/services/cli/client.ts` expose the new IPC method.
- `src/services/cli/types.ts`, `electron/cli/conversations.ts`, and `electron/cli/runtimeShared.ts` carry attachment metadata through the UI, persistence, and task records.
- `src/store/conversationStore.ts` accepts attachments, persists them on user messages, and composes the runtime prompt.
- `src/components/CLI/ChatView.tsx` tracks pending attachments for active and new conversations.
- `src/components/CLI/MessageBubble.tsx` renders sent user attachments.
- `styles.css` adds compact attachment tray and message attachment styles.

## Testing

Unit/static tests cover:

- Attachment classification for supported and unsupported extensions.
- Size formatting and prompt composition.
- `sendMessage` uses a composed runtime prompt while storing visible text and attachments separately.
- IPC/preload/client type surface exposes `selectAttachments`.
- Composer has a pending attachment tray and enables send for attachment-only messages.
- Message bubbles render user attachments.

Manual verification:

- Attach a supported file to an existing conversation and send it.
- Attach a file with no text and send it.
- Confirm the user bubble remains readable.
- Confirm the agent prompt includes local paths.
- Reload and confirm sent attachments remain visible.
