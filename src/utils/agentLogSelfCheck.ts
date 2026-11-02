import type { Conversation } from "@/services/cli/types";

export interface AgentLogSelfCheckPreview {
  environment: Record<string, unknown>;
  files: Array<{
    name: string;
    totalLines: number;
    lines: string[];
    truncated: boolean;
  }>;
}

export function buildAgentLogSelfCheckPrompt(input: {
  conversation: Conversation;
  logDirectory: string;
  language: string;
}): string {
  const { conversation, logDirectory } = input;
  const chinese = input.language.toLowerCase().startsWith("zh");
  return chinese
    ? `\u8bf7\u81ea\u67e5 FreeBuddy \u4f1a\u8bdd\u7684\u5b8c\u6574\u8bca\u65ad\u65e5\u5fd7\uff0c\u5e76\u751f\u6210\u7ed3\u6784\u5316\u62a5\u544a\u3002

\u65e5\u5fd7\u76ee\u5f55\uff1a${logDirectory}

\u8bf7\u5148\u8bfb\u53d6\u8be5\u4e34\u65f6\u76ee\u5f55\u4e2d\u7684 README.txt\u3001environment.json\u3001dsh-acp-runtime.json\u3001logs/ \u548c sessions/\u3002

\u8981\u6c42\uff1a
1. \u5148\u603b\u7ed3\u95ee\u9898\uff0c\u518d\u5217\u51fa\u7531\u65f6\u95f4\u6233\u6216\u51c6\u786e\u65e5\u5fd7\u6761\u76ee\u652f\u6301\u7684\u5173\u952e\u8bc1\u636e\u3002
2. \u533a\u5206\u5df2\u786e\u8ba4\u4e8b\u5b9e\u548c\u53ef\u80fd\u539f\u56e0\uff0c\u4e0d\u8981\u628a\u63a8\u65ad\u5199\u6210\u4e8b\u5b9e\u3002
3. \u7ed9\u51fa\u53ef\u6267\u884c\u7684\u4fee\u590d\u5efa\u8bae\uff1b\u8bc1\u636e\u4e0d\u8db3\u65f6\uff0c\u8bf4\u660e\u8fd8\u9700\u8981\u54ea\u4e9b\u4fe1\u606f\u3002
4. \u4e0d\u8981\u4fee\u6539\u6216\u5220\u9664\u4e34\u65f6\u76ee\u5f55\u4e2d\u7684\u6587\u4ef6\uff0c\u53ea\u751f\u6210\u62a5\u544a\u3002

5. \u6838\u5bf9\u5bfc\u51fa\u65f6\u95f4\u3001\u65e5\u5fd7\u8986\u76d6\u8303\u56f4\u548c\u622a\u65ad\u6807\u8bb0\uff1bdroppedLines: 0 \u4e0d\u4ee3\u8868\u5bfc\u51fa\u5b8c\u6574\u3002ACP terminal_exit \u4f7f\u7528 exit_code\uff0c\u5176\u4ed6\u4e8b\u4ef6\u53ef\u80fd\u4f7f\u7528 exitCode\uff1b\u7f3a\u5931\u9000\u51fa\u7801\u5e94\u8bb0\u4e3a\u672a\u77e5\u3002\u533a\u5206\u6210\u529f\u72b6\u6001\u3001\u901a\u77e5\u53d1\u9001\u51b3\u7b56\u548c\u5b9e\u9645\u9001\u8fbe\uff1bwillNotify:false \u8868\u793a\u6ca1\u6709\u8ba1\u5212\u53d1\u9001\u901a\u77e5\u3002

## \u4f1a\u8bdd
- \u6807\u9898\uff1a${conversation.title}
- \u4f1a\u8bdd ID\uff1a${conversation.id}
- Agent\uff1a${conversation.agentName}
- Adapter\uff1a${conversation.adapter}`
    : `Review the full diagnostic logs for this FreeBuddy conversation and produce a structured self-check report.

Log directory: ${logDirectory}

Read README.txt, environment.json, dsh-acp-runtime.json, logs/, and sessions/ from this temporary directory before writing the report.

Requirements:
1. Start with a problem summary, then list key evidence supported by timestamps or exact log entries.
2. Separate confirmed facts from possible causes; do not present inference as fact.
3. Give actionable remediation steps and say what additional data is needed when evidence is insufficient.
4. Do not modify or delete files in the temporary directory. Only produce the report.

5. Check export time, log coverage and truncation markers; droppedLines: 0 does not prove export completeness. ACP terminal_exit uses exit_code; other events may use exitCode. Treat missing exit codes as unknown. Distinguish success status, notification decisions and actual delivery; willNotify:false means no notification was planned.

## Conversation
- Title: ${conversation.title}
- Conversation ID: ${conversation.id}
- Agent: ${conversation.agentName}
- Adapter: ${conversation.adapter}`;
}
