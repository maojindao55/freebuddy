// Reduced from the reported Claude ACP transcript; paths and tool identities are anonymized.
export const claudeTurnBefore = "# 星际战机 (Star Fighter)\n\n一个基于 H5 Canvas 的太空射击闯关小游戏。玩家驾驶战机穿越陨石带、消灭敌机、收集能量星，逐关挑战越来越强的敌人。\n\n## 运行方式\n\n直接使用浏览器打开 `index.html` 即可开始游戏。\n\n也可以在当前目录启动本地静态服务：\n\n```bash\npython3 -m http.server 4173\n```\n\n然后访问：\n\n```text\nhttp://localhost:4173\n```\n\n## 操作\n\n- **移动**：`A` / `←` 左移，`D` / `→` 右移\n- **射击**：`空格` 键开火（按住可连续射击）\n- **暂停**：`P` 键暂停/继续\n- **快速开始**：游戏结束后按 `Enter`\n- **桌面端**：鼠标/触控板在画布上拖动控制战机，按下自动射击\n- **移动端**：点击/拖动游戏画布移动+射击，底部左右按钮移动，🔥 按钮射击\n\n## 玩法\n\n- **闯关机制**：每关需要消灭一定数量的敌机，然后击败 Boss 进入下一关\n- **敌人类型**：\n  - 无人机（Drone）：左右摇摆移动，会发射红色子弹\n  - Boss：高血量，在屏幕顶部左右移动，弹幕密集\n- **能量星**：收集可增加得分，并有小概率回复生命值\n- **陨石**：触碰扣血，需躲避\n- **关卡递增**：每关敌人更多、更强、射击更频繁\n- **进度条**：屏幕底部显示当前关卡击杀进度\n\n## 说明\n\n- 最高分保存在浏览器本地存储中；若浏览器禁用了本地存储，游戏仍可正常运行。\n- 暂停会显示中间遮罩层，按 P 或点击按钮恢复。\n\n## 文件\n\n- `index.html`：页面结构。\n- `styles.css`：界面布局和视觉样式。\n- `game.js`：游戏逻辑、绘制和交互控制。";
export const claudeTurnChanges = [
  {
    "oldString": "# 星际战机 (Star Fighter)",
    "newString": "# 星际战机 (Star Fighter) DX",
    "oldText": "# 星际战机 (Star Fighter)\n\n一个基于 H5 Canvas 的太空射击闯关小游戏。玩家驾驶战机穿越陨石带、消灭敌机、收集能量星，逐关挑战越来越强的敌人。\n",
    "newText": "# 星际战机 (Star Fighter) DX\n\n一个基于 H5 Canvas 的太空射击闯关小游戏。玩家驾驶战机穿越陨石带、消灭敌机、收集能量星，逐关挑战越来越强的敌人。\n",
    "structuredPatch": [
      {
        "oldStart": 1,
        "oldLines": 4,
        "newStart": 1,
        "newLines": 4,
        "lines": [
          "-# 星际战机 (Star Fighter)",
          "+# 星际战机 (Star Fighter) DX",
          " ",
          " 一个基于 H5 Canvas 的太空射击闯关小游戏。玩家驾驶战机穿越陨石带、消灭敌机、收集能量星，逐关挑战越来越强的敌人。",
          " "
        ]
      }
    ]
  },
  {
    "oldString": "直接使用浏览器打开 `index.html` 即可开始游戏。",
    "newString": "直接使用现代浏览器（Chrome / Safari / Edge / Firefox）打开 `index.html` 即可开始游戏。",
    "oldText": "\n## 运行方式\n\n直接使用浏览器打开 `index.html` 即可开始游戏。\n\n也可以在当前目录启动本地静态服务：\n",
    "newText": "\n## 运行方式\n\n直接使用现代浏览器（Chrome / Safari / Edge / Firefox）打开 `index.html` 即可开始游戏。\n\n也可以在当前目录启动本地静态服务：\n",
    "structuredPatch": [
      {
        "oldStart": 4,
        "oldLines": 7,
        "newStart": 4,
        "newLines": 7,
        "lines": [
          " ",
          " ## 运行方式",
          " ",
          "-直接使用浏览器打开 `index.html` 即可开始游戏。",
          "+直接使用现代浏览器（Chrome / Safari / Edge / Firefox）打开 `index.html` 即可开始游戏。",
          " ",
          " 也可以在当前目录启动本地静态服务：",
          " "
        ]
      }
    ]
  },
  {
    "oldString": "- `game.js`：游戏逻辑、绘制和交互控制。",
    "newString": "- `game.js`：游戏逻辑、绘制、交互控制以及移动端触控支持。",
    "oldText": "\n- `index.html`：页面结构。\n- `styles.css`：界面布局和视觉样式。\n- `game.js`：游戏逻辑、绘制和交互控制。\n No newline at end of file\n No newline at end of file",
    "newText": "\n- `index.html`：页面结构。\n- `styles.css`：界面布局和视觉样式。\n No newline at end of file\n- `game.js`：游戏逻辑、绘制、交互控制以及移动端触控支持。\n No newline at end of file",
    "structuredPatch": [
      {
        "oldStart": 47,
        "oldLines": 4,
        "newStart": 47,
        "newLines": 4,
        "lines": [
          " ",
          " - `index.html`：页面结构。",
          " - `styles.css`：界面布局和视觉样式。",
          "-- `game.js`：游戏逻辑、绘制和交互控制。",
          "\\ No newline at end of file",
          "+- `game.js`：游戏逻辑、绘制、交互控制以及移动端触控支持。",
          "\\ No newline at end of file"
        ]
      }
    ]
  }
];
export const claudeTurnAfter = claudeTurnChanges.reduce((text, change) => text.replace(change.oldString, change.newString), claudeTurnBefore);

export function claudeTurnUpdates(index, file = "README.md") {
  const change = claudeTurnChanges[index];
  const toolCallId = `claude-edit-${index}`;
  const _meta = { claudeCode: { toolName: "Edit" } };
  const originalFile = claudeTurnChanges.slice(0, index).reduce((text, edit) => text.replace(edit.oldString, edit.newString), claudeTurnBefore);
  return [
    { sessionUpdate: "tool_call", toolCallId, status: "pending", title: "Edit", kind: "edit", rawInput: {}, content: [], locations: [], _meta },
    { sessionUpdate: "tool_call_update", toolCallId, title: `Edit ${file}`, kind: "edit", _meta,
      content: [{ type: "diff", path: file, oldText: change.oldString, newText: change.newString }], locations: [{ path: file }] },
    { sessionUpdate: "tool_call_update", toolCallId,
      _meta: { claudeCode: { toolName: "Edit", toolResponse: { filePath: file, originalFile, oldString: change.oldString, newString: change.newString,
        structuredPatch: change.structuredPatch, userModified: false, replaceAll: false } } },
      content: [{ type: "diff", path: file, oldText: change.oldText, newText: change.newText }], locations: [{ path: file, line: change.structuredPatch[0].oldStart }] },
    { sessionUpdate: "tool_call_update", toolCallId, status: "completed", _meta,
      rawOutput: `The file ${file} has been updated successfully. (file state is current in your context — no need to Read it back)` }
  ];
}
