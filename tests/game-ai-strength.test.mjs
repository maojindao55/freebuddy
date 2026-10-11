import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_SIZE,
  GomokuGameInstance,
  PLAYER_BLACK,
  PLAYER_WHITE,
  createEmptyBoard
} from "../dist-electron/games/gomokuEngine.js";
import {
  XiangqiGameInstance,
  createInitialBoard
} from "../dist-electron/games/xiangqiEngine.js";
import {
  evaluateBoard,
  findBestMove,
  patternScore,
  pointScore
} from "../dist-electron/games/gomokuSearch.js";
import { findBestXiangqiMove } from "../dist-electron/games/xiangqiSearch.js";
import {
  renderGomokuBoardAscii,
  renderXiangqiBoardAscii,
  formatGameStateText
} from "../dist-electron/games/boardDisplay.js";
import {
  ENGINE_AUTO_MOVE_DELAY_MS,
  handleGetGameState,
  handlePlayerMove,
  handlePlayerResign,
  getOrCreateGame,
  initGamePersistence,
  dispatchGameAction
} from "../dist-electron/gameToolService.js";

const SEARCH_OPTS = { maxDepth: 4, timeBudgetMs: 400 };

async function waitForEngineMove(conversationId, expectedSteps) {
  const game = getOrCreateGame(conversationId);
  const deadline = Date.now() + 5_000;
  // Worker startup and the engine's safety fallback can outlast the search
  // budget on busy CI runners. Wait for the completed move with a fixed limit.
  while (game.moveHistory.length < expectedSteps && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(game.moveHistory.length, expectedSteps, `Engine move did not complete for ${conversationId}`);
  return game.getSnapshot();
}

function emptyGomokuBoard() {
  return createEmptyBoard();
}

function placeStones(board, player, cells) {
  for (const [x, y] of cells) {
    board[y][x] = player;
  }
  return board;
}

test("gomoku search finds immediate winning move", () => {
  // White has four in a row D8-G8; completing at C8 or H8 wins instantly
  const board = placeStones(emptyGomokuBoard(), PLAYER_WHITE, [
    [3, 7],
    [4, 7],
    [5, 7],
    [6, 7]
  ]);

  const best = findBestMove(board, PLAYER_WHITE, SEARCH_OPTS);

  assert.ok(best, "engine should return a move");
  assert.ok(["C8", "H8"].includes(best.actionId), `expected winning move C8/H8, got ${best.actionId}`);
});

test("gomoku search blocks opponent's four-in-a-row", () => {
  // Black has four in a row D8-G8; white must block C8 or H8
  const board = placeStones(emptyGomokuBoard(), PLAYER_BLACK, [
    [3, 7],
    [4, 7],
    [5, 7],
    [6, 7]
  ]);

  const best = findBestMove(board, PLAYER_WHITE, SEARCH_OPTS);

  assert.ok(best, "engine should return a move");
  assert.ok(
    ["C8", "H8"].includes(best.actionId),
    `expected blocking move C8/H8, got ${best.actionId}`
  );
});

test("gomoku search opens with center point on empty board", () => {
  const best = findBestMove(emptyGomokuBoard(), PLAYER_BLACK, SEARCH_OPTS);

  assert.equal(best.actionId, "H8");
});

test("gomoku search never returns an occupied cell", () => {
  const board = placeStones(emptyGomokuBoard(), PLAYER_WHITE, [
    [3, 7],
    [4, 7],
    [5, 7],
    [6, 7]
  ]);
  board[7][2] = PLAYER_BLACK;

  const best = findBestMove(board, PLAYER_WHITE, SEARCH_OPTS);

  assert.equal(best.actionId, "H8", "only remaining completion is H8");
  assert.equal(board[best.y][best.x], 0);
});

test("gomoku evaluator scores a two-ended live three as live, not sleeping", () => {
  const board = placeStones(emptyGomokuBoard(), PLAYER_BLACK, [
    [5, 7],
    [6, 7],
    [7, 7]
  ]);

  assert.ok(
    evaluateBoard(board, PLAYER_BLACK) >= patternScore(3, 2),
    "a row with both endpoints open must receive at least the live-three score"
  );
});

test("gomoku point evaluator recognizes a one-gap winning shape", () => {
  const board = placeStones(emptyGomokuBoard(), PLAYER_BLACK, [
    [6, 7],
    [8, 7],
    [9, 7]
  ]);

  assert.ok(
    pointScore(board, 5, 7, PLAYER_BLACK) > 1_000_000,
    "placing at F8 creates XX_XX and must see the chain beyond the empty gap"
  );
});

test("renderGomokuBoardAscii produces coordinate-framed grid", () => {
  const board = placeStones(emptyGomokuBoard(), PLAYER_BLACK, [[7, 7]]);

  const ascii = renderGomokuBoardAscii(board);
  const lines = ascii.split("\n");

  assert.equal(lines.length, BOARD_SIZE + 1, "header plus 15 rows");
  assert.match(lines[0], /A B C.*O$/);
  assert.match(lines[1], /^15\b/);
  assert.match(lines[15], /^ 1\b/);
  // Center stone rendered as X on row 8 (index 8 => line 15-8+1 = 8th row line)
  assert.match(lines[8], /\bX\b/);
});

test("renderXiangqiBoardAscii renders red uppercase and black lowercase pieces", () => {
  const ascii = renderXiangqiBoardAscii(createInitialBoard());
  const lines = ascii.split("\n");

  assert.equal(lines.length, 11, "header plus 10 ranks");
  assert.match(lines[0], /a b c d e f g h i$/);
  assert.match(lines[1], /\br n b a k a b n r\b/);
  assert.match(lines[10], /\bR N B A K A B N R\b/);
});

test("formatGameStateText embeds board, turn info and candidate moves", () => {
  const inst = new GomokuGameInstance("conv-format-test");
  inst.applyMove("H8", PLAYER_BLACK);
  inst.applyMove("I9", PLAYER_WHITE);
  const snapshot = inst.getSnapshot();

  const text = formatGameStateText(snapshot);

  assert.match(text, /五子棋/);
  assert.match(text, /轮到/);
  assert.match(text, /A B C/, "should embed ascii board");
  assert.match(text, /候选走法/, "should list candidate moves");
  assert.match(text, /I9/, "last move should be mentioned");
});

test("formatGameStateText warns about opponent five-threat", () => {
  const inst = new GomokuGameInstance("conv-threat-test");
  placeStones(inst.board, PLAYER_BLACK, [
    [3, 7],
    [4, 7],
    [5, 7],
    [6, 7]
  ]);
  inst.turn = PLAYER_WHITE;
  const snapshot = inst.getSnapshot();

  const text = formatGameStateText(snapshot);

  assert.match(text, /威胁/);
  assert.match(text, /C8|H8/, "threat note should name blocking points");
});

test("formatGameStateText works for xiangqi snapshots", () => {
  const inst = new XiangqiGameInstance("conv-xiangqi-format");
  const snapshot = inst.getSnapshot();

  const text = formatGameStateText(snapshot);

  assert.match(text, /象棋/);
  assert.match(text, /a b c d e f g h i/);
  assert.match(text, /候选走法/);
});

test("formatted state identifies actors correctly when the Agent has the opening side", () => {
  const gomoku = new GomokuGameInstance("agent-first-format", PLAYER_WHITE);
  const text = formatGameStateText(gomoku.getSnapshot());

  assert.match(text, /轮到 AI 执黑/);
  assert.match(text, /X=黑棋\(AI\)/);
  assert.match(text, /O=白棋\(玩家\)/);
});

test("terminal state text does not claim another side is to move", () => {
  const inst = new XiangqiGameInstance("conv-xiangqi-terminal");
  inst.status = "player_won";
  inst.winner = 1;

  const text = formatGameStateText(inst.getSnapshot());

  assert.match(text, /玩家获胜/);
  assert.doesNotMatch(text, /轮到/);
});

test("xiangqi search returns a legal move with a factual reason", () => {
  const inst = new XiangqiGameInstance("xiangqi-search");
  inst.applyMove("b2e2", 1);

  const best = findBestXiangqiMove(inst.board, 2, {
    maxDepth: 2,
    timeBudgetMs: 300,
    positionHistory: inst.positionHistory,
    recentMoves: inst.moveHistory
  });

  assert.ok(best);
  assert.ok(inst.getSnapshot().legalMoves.some((move) => move.actionId === best.actionId));
  assert.match(best.reason, /[进平退]/);
});

test("xiangqi quiescence search avoids sacrificing Rook for defended Pawn", () => {
  // Red Rook at e3, defended Black Pawn at e6 defended by Black Cannon at e7
  const board = Array.from({ length: 10 }, () => Array(9).fill(0));
  board[0][4] = 1;   // Red King e0
  board[9][4] = -1;  // Black King e9
  board[2][4] = 5;   // Red Rook e2
  board[6][4] = -7;  // Black Pawn e6
  board[7][4] = -6;  // Black Cannon e7 (defends e6)

  // Red to move: Taking e6 with Rook (e2e6) wins a pawn but loses the Rook to cannon (e7e6).
  // With Q-search, Red should NOT play e2e6 (Rook takes Pawn).
  const best = findBestXiangqiMove(board, 1, {
    maxDepth: 2,
    timeBudgetMs: 400
  });

  assert.ok(best);
  assert.notEqual(best.actionId, "e2e6", "Rook should not sacrifice itself for a defended pawn");
});


test("hard difficulty triggers automatic engine reply after player move", async () => {
  const conversationId = `conv-hard-${Date.now()}`;
  initGamePersistence(
    (id) => ({ metadata: { gameType: "gomoku", gameDifficulty: "hard" } }),
    () => {}
  );

  const res = handlePlayerMove(conversationId, "H8");
  assert.equal(res.ok, true);
  assert.equal(res.agentAutoPlayScheduled, true, "hard mode should flag auto reply");

  const state = await waitForEngineMove(conversationId, 2);
  const whiteStones = state.board.flat().filter((v) => v === PLAYER_WHITE).length;
  assert.equal(whiteStones, 1, "engine should have replied with one white stone");
  assert.equal(state.turn, PLAYER_BLACK);
});

test("hard difficulty also triggers Xiangqi engine reply", async () => {
  const conversationId = `conv-hard-xiangqi-${Date.now()}`;
  initGamePersistence(
    () => ({ metadata: { gameType: "xiangqi", gameDifficulty: "hard" } }),
    () => {}
  );

  const res = handlePlayerMove(conversationId, "b2e2");
  assert.equal(res.ok, true);
  assert.equal(res.agentAutoPlayScheduled, true);

  const state = await waitForEngineMove(conversationId, 2);
  assert.equal(state.stepCount, 2, "the Xiangqi engine should have replied once");
  assert.equal(state.turn, 1);
});

test("easy difficulty does not schedule automatic engine reply", async () => {
  const conversationId = `conv-easy-${Date.now()}`;
  initGamePersistence(
    (id) => ({ metadata: { gameType: "gomoku", gameDifficulty: "easy" } }),
    () => {}
  );

  const res = handlePlayerMove(conversationId, "H8");
  assert.equal(res.ok, true);
  assert.equal(res.agentAutoPlayScheduled, false, "easy mode must not auto reply");

  await new Promise((resolve) => setTimeout(resolve, ENGINE_AUTO_MOVE_DELAY_MS + 500));

  const state = getOrCreateGame(conversationId).getSnapshot();
  const whiteStones = state.board.flat().filter((v) => v === PLAYER_WHITE).length;
  assert.equal(whiteStones, 0, "no white stone should appear in easy mode");
  assert.equal(state.turn, PLAYER_WHITE);
});

test("player move handler rejects a second move while it is still the Agent turn", () => {
  const conversationId = `conv-turn-guard-${Date.now()}`;
  initGamePersistence(
    () => ({ metadata: { gameType: "gomoku", gameDifficulty: "easy" } }),
    () => {}
  );

  assert.equal(handlePlayerMove(conversationId, "H8").ok, true);
  const second = handlePlayerMove(conversationId, "H9");
  assert.equal(second.ok, false);

  const state = getOrCreateGame(conversationId).getSnapshot();
  assert.equal(state.stepCount, 1);
  assert.equal(state.board.flat().filter((value) => value === PLAYER_BLACK).length, 1);
});

test("Agent-first assigns the opening side to the Agent in both games", async () => {
  const metadata = new Map([
    ["agent-first-gomoku", { gameType: "gomoku", gameDifficulty: "easy", hand: "agent_first" }],
    ["agent-first-xiangqi", { gameType: "xiangqi", gameDifficulty: "easy", hand: "agent_first" }]
  ]);
  initGamePersistence((id) => ({ metadata: metadata.get(id) }), () => {});

  const gomokuBinding = {
    token: "agent-first-g",
    taskSessionId: "agent-first-g-session",
    conversationId: "agent-first-gomoku",
    gameType: "gomoku"
  };
  const gomoku = getOrCreateGame("agent-first-gomoku");
  assert.equal(gomoku.agentSide, PLAYER_BLACK);
  assert.equal(gomoku.playerSide, PLAYER_WHITE);
  assert.equal((await dispatchGameAction(gomokuBinding, "make_move", { actionId: "H8" })).ok, true);
  assert.equal(handlePlayerMove("agent-first-gomoku", "I9").ok, true);

  const xiangqiBinding = {
    token: "agent-first-x",
    taskSessionId: "agent-first-x-session",
    conversationId: "agent-first-xiangqi",
    gameType: "xiangqi"
  };
  const xiangqi = getOrCreateGame("agent-first-xiangqi");
  assert.equal(xiangqi.agentSide, 1);
  assert.equal(xiangqi.playerSide, 2);
  assert.equal((await dispatchGameAction(xiangqiBinding, "make_move", { actionId: "b2e2" })).ok, true);
  assert.equal(handlePlayerMove("agent-first-xiangqi", "b7e7").ok, true);
});

test("player resign ends the game immediately and awards the Agent", () => {
  const conversationId = `conv-player-resign-${Date.now()}`;
  initGamePersistence(
    () => ({
      metadata: {
        gameType: "xiangqi",
        gameDifficulty: "easy",
        hand: "agent_first"
      }
    }),
    () => {}
  );

  const result = handlePlayerResign(conversationId);
  assert.equal(result.ok, true);
  assert.equal(result.gameState.status, "agent_won");
  assert.equal(result.gameState.winner, result.gameState.agentSide);
  assert.equal(handlePlayerResign(conversationId).ok, false, "resign must be idempotently rejected");
});

test("hard Agent-first game starts its opening move from initial state sync", async () => {
  const conversationId = `conv-hard-agent-first-${Date.now()}`;
  initGamePersistence(
    () => ({
      metadata: {
        gameType: "gomoku",
        gameDifficulty: "hard",
        hand: "agent_first"
      }
    }),
    () => {}
  );

  const initial = handleGetGameState(conversationId);
  assert.equal(initial.turn, initial.agentSide);
  const state = await waitForEngineMove(conversationId, 1);
  assert.equal(state.stepCount, 1);
  assert.equal(state.lastMove?.player, state.agentSide);
  assert.equal(state.turn, state.playerSide);
});

test("hard engine search runs outside the main event loop", async () => {
  const conversationId = `conv-worker-responsive-${Date.now()}`;
  initGamePersistence(
    () => ({ metadata: { gameType: "gomoku", gameDifficulty: "hard" } }),
    () => {}
  );
  handlePlayerMove(conversationId, "H8");

  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ENGINE_AUTO_MOVE_DELAY_MS + 120));
  assert.ok(
    Date.now() - started < ENGINE_AUTO_MOVE_DELAY_MS + 350,
    "the 700ms search budget must not block a main-thread timer"
  );
  // Let the worker finish so it cannot leak into later tests.
  await waitForEngineMove(conversationId, 2);
});

test("state polling does not postpone an already scheduled hard-mode reply", async () => {
  const conversationId = `conv-worker-poll-${Date.now()}`;
  initGamePersistence(
    () => ({ metadata: { gameType: "gomoku", gameDifficulty: "hard" } }),
    () => {}
  );
  handlePlayerMove(conversationId, "H8");

  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    handleGetGameState(conversationId);
  }
  await new Promise((resolve) => setTimeout(resolve, 950));

  const state = getOrCreateGame(conversationId).getSnapshot();
  assert.equal(state.stepCount, 2, "polling getState must reuse rather than restart the pending job");
  assert.equal(state.turn, state.playerSide);
});

test("auto-move lifecycle is independent from MCP session unregister", () => {
  const service = fs.readFileSync(
    new URL("../electron/gameToolService.ts", import.meta.url),
    "utf8"
  );
  const unregister = service.slice(
    service.indexOf("export function unregisterGameToolSession"),
    service.indexOf("export async function handleGameToolHttpRequest")
  );
  assert.doesNotMatch(unregister, /cancelAgentAutoMove/);
  assert.match(service, /new Worker\(/);
});

test("make_move emits its reason as an agent chat message", async () => {
  const conversationId = `conv-reason-${Date.now()}`;
  initGamePersistence(
    (id) => ({ metadata: { gameType: "gomoku", gameDifficulty: "easy" } }),
    () => {}
  );
  const binding = {
    token: "reason-token",
    taskSessionId: `reason-session-${Date.now()}`,
    conversationId,
    gameType: "gomoku"
  };

  handlePlayerMove(conversationId, "H8");
  const res = await dispatchGameAction(binding, "make_move", {
    actionId: "I9",
    reason: "抢占斜线要点，构建活三"
  });

  assert.equal(res.ok, true);
  assert.ok(res.chat, "result should carry the emitted chat");
  assert.equal(res.chat.sender, "agent");
  assert.equal(res.chat.message, "抢占斜线要点，构建活三");

  const state = getOrCreateGame(conversationId).getSnapshot();
  const lastChat = state.chatHistory[state.chatHistory.length - 1];
  assert.ok(lastChat);
  assert.equal(lastChat.message, "抢占斜线要点，构建活三");
});

test("make_move without reason emits no chat message", async () => {
  const conversationId = `conv-noreason-${Date.now()}`;
  initGamePersistence(
    (id) => ({ metadata: { gameType: "gomoku", gameDifficulty: "easy" } }),
    () => {}
  );
  const binding = {
    token: "noreason-token",
    taskSessionId: `noreason-session-${Date.now()}`,
    conversationId,
    gameType: "gomoku"
  };

  handlePlayerMove(conversationId, "H8");
  const res = await dispatchGameAction(binding, "make_move", {
    actionId: "I9"
  });

  assert.equal(res.ok, true);
  assert.equal(res.chat, undefined);
  const state = getOrCreateGame(conversationId).getSnapshot();
  assert.equal(state.chatHistory.length, 0);
});

test("game lobby persists difficulty into conversation metadata", () => {
  const modal = fs.readFileSync(
    new URL("../src/components/Games/GameSetupModal.tsx", import.meta.url),
    "utf8"
  );
  assert.match(modal, /gameDifficulty/);

  const canvas = fs.readFileSync(
    new URL("../src/components/Browser/BrowserCanvas.tsx", import.meta.url),
    "utf8"
  );
  assert.match(canvas, /agentAutoPlayScheduled/);
  assert.match(canvas, /gameDifficulty === "hard"\s*&&\s*snapshot\.lastMove\.player === snapshot\.agentSide/);

  const gomokuBoard = fs.readFileSync(
    new URL("../public/games/gomoku/game.js", import.meta.url),
    "utf8"
  );
  const xiangqiBoard = fs.readFileSync(
    new URL("../public/games/xiangqi/game.js", import.meta.url),
    "utf8"
  );
  assert.match(gomokuBoard, /snapshot\.playerSide/);
  assert.match(xiangqiBoard, /snapshot\.playerSide/);
});
