(function () {
  const BOARD_COLS = 9;
  const BOARD_ROWS = 10;
  const COL_LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

  // Piece Definitions
  const PIECE_NAMES = {
    1: "帥", 2: "仕", 3: "相", 4: "傌", 5: "俥", 6: "炮", 7: "兵",
    "-1": "將", "-2": "士", "-3": "象", "-4": "馬", "-5": "車", "-6": "砲", "-7": "卒"
  };

  // State
  let board = createInitialBoard();
  let turn = 1; // 1: Red, 2: Black
  let playerSide = 1;
  let agentSide = 2;
  let status = "playing";
  let lastMove = null;
  let selectedCoord = null;
  let legalTargets = [];
  let hoverCoord = null;
  let initialized = false;
  let winner = null;
  let playerWasInCheck = false;
  let agentWasInCheck = false;

  // DOM Elements
  const canvas = document.getElementById("xiangqi-canvas");
  const ctx = canvas.getContext("2d");
  const turnBadge = document.getElementById("turn-badge");
  const speechText = document.getElementById("speech-text");
  const statusText = document.getElementById("status-text");
  const restartBtn = document.getElementById("restart-btn");
  const resignBtn = document.getElementById("resign-btn");
  const retryAgentBtn = document.getElementById("retry-agent-btn");
  const playerCapturedContainer = document.getElementById("player-captured");
  const agentCapturedContainer = document.getElementById("agent-captured");
  const playerAvatarIcon = document.getElementById("player-avatar-icon");
  const playerNameLabel = document.getElementById("player-name-label");
  const playerSideLabel = document.getElementById("player-side-label");
  const playerPieceIndicator = document.getElementById("player-piece-indicator");
  const agentAvatarIcon = document.getElementById("agent-avatar-icon");
  const agentNameLabel = document.getElementById("agent-name-label");
  const agentSideLabel = document.getElementById("agent-side-label");
  const agentPieceIndicator = document.getElementById("agent-piece-indicator");
  const playerBadge = document.getElementById("player-badge");
  const agentBadge = document.getElementById("agent-badge");
  const speechAvatar = document.getElementById("speech-avatar");
  const moveHistoryPanel = document.getElementById("move-history-panel");
  const moveHistoryList = document.getElementById("move-history-list");
  const historyStepCount = document.getElementById("history-step-count");
  const historyEmpty = document.getElementById("history-empty");
  const historyListWrapper = document.getElementById("history-list-wrapper");
  const toggleHistoryBtn = document.getElementById("toggle-history-btn");
  const closeHistoryBtn = document.getElementById("close-history-btn");

  let participants = null;
  let gameMode = "player_vs_agent";
  let moveHistory = [];

  function sideName(side) {
    return side === 1 ? "红方" : "黑方";
  }

  function setHistoryPanelVisible(visible) {
    if (!moveHistoryPanel) return;
    if (visible) {
      moveHistoryPanel.classList.remove("collapsed");
      if (toggleHistoryBtn) {
        toggleHistoryBtn.classList.add("active-toggle");
      }
    } else {
      moveHistoryPanel.classList.add("collapsed");
      if (toggleHistoryBtn) {
        toggleHistoryBtn.classList.remove("active-toggle");
      }
    }
    resizeCanvas();
  }

  function updateMoveHistory(history) {
    moveHistory = history || [];
    if (toggleHistoryBtn) {
      toggleHistoryBtn.textContent = moveHistory.length > 0
        ? `📜 对弈谱 (${moveHistory.length}手)`
        : "📜 对弈谱";
    }
    if (!moveHistoryList) return;

    if (historyStepCount) {
      historyStepCount.textContent = `${moveHistory.length} 手`;
    }

    if (moveHistory.length === 0) {
      if (historyEmpty) historyEmpty.style.display = "block";
      moveHistoryList.innerHTML = "";
      return;
    }

    if (historyEmpty) historyEmpty.style.display = "none";
    moveHistoryList.innerHTML = "";

    moveHistory.forEach((move, idx) => {
      const isLatest = idx === moveHistory.length - 1;
      const li = document.createElement("li");
      li.className = `history-item${isLatest ? " latest" : ""}`;

      const stepNum = document.createElement("span");
      stepNum.className = "step-num";
      stepNum.textContent = `${String(idx + 1).padStart(2, "0")}.`;

      const avatarMini = document.createElement("span");
      avatarMini.className = "history-avatar-mini";
      const participant = move.player === 1 ? participants?.side1 : participants?.side2;
      const defaultEmoji = move.player === 1 ? (playerSide === 1 ? "👤" : "🤖") : (playerSide === 2 ? "👤" : "🤖");
      renderAvatar(avatarMini, participant, defaultEmoji);

      const actorTag = document.createElement("span");
      const isRed = move.player === 1;
      actorTag.className = `actor-tag ${isRed ? "red" : "black"}`;
      actorTag.textContent = isRed ? "红" : "黑";

      const notation = document.createElement("span");
      notation.className = "move-notation";
      notation.textContent = move.chineseMove
        ? `${move.chineseMove}`
        : move.actionId;
      if (move.reason) {
        notation.title = move.reason;
      }

      const tagsWrap = document.createElement("span");
      tagsWrap.className = "history-tags";

      if (move.capturedPieceName) {
        const eatBadge = document.createElement("span");
        eatBadge.className = "tag-badge";
        eatBadge.textContent = `吃${move.capturedPieceName}`;
        tagsWrap.appendChild(eatBadge);
      }

      if (move.checkmate || (isLatest && (status === "player_won" || status === "agent_won"))) {
        const winBadge = document.createElement("span");
        winBadge.className = "tag-badge win";
        winBadge.textContent = "绝杀";
        tagsWrap.appendChild(winBadge);
      } else if (move.givesCheck) {
        const checkBadge = document.createElement("span");
        checkBadge.className = "tag-badge check";
        checkBadge.textContent = "将军";
        tagsWrap.appendChild(checkBadge);
      }

      li.appendChild(stepNum);
      li.appendChild(avatarMini);
      li.appendChild(actorTag);
      li.appendChild(notation);
      li.appendChild(tagsWrap);

      moveHistoryList.appendChild(li);
    });

    if (historyListWrapper) {
      historyListWrapper.scrollTop = historyListWrapper.scrollHeight;
    }
  }

  function renderAvatar(el, participant, fallbackEmoji = "🤖") {
    if (!el) return;
    const isHistoryMini = el.classList.contains("history-avatar-mini");
    const baseClass = isHistoryMini ? "history-avatar-mini" : "agent-avatar-mini";
    if (participant?.avatarUrl) {
      el.className = baseClass;
      el.innerHTML = `<img src="${participant.avatarUrl}" alt="avatar" class="agent-avatar-img" />`;
    } else if (participant?.kind === "engine") {
      el.className = baseClass;
      el.textContent = "🧠";
    } else if (participant?.kind === "player") {
      const initial = (participant?.initial || (participant?.name && participant.name !== "你" ? participant.name[0] : "你") || "你").toUpperCase();
      el.className = `${baseClass} user-avatar`;
      el.innerHTML = `<span class="user-avatar-initial">${initial}</span>`;
    } else {
      el.className = baseClass;
      el.textContent = fallbackEmoji;
    }
  }

  function updateSideLabels() {
    if (gameMode === "agent_vs_agent" || gameMode === "agent_vs_engine" || playerSide === 0) {
      const side1Name = participants?.side1?.name || (participants?.side1?.kind === "engine" ? "极智引擎" : "红方 AI");
      const side2Name = participants?.side2?.name || (participants?.side2?.kind === "engine" ? "极智引擎" : "黑方 AI");
      if (playerBadge) playerBadge.className = "player-badge red";
      if (agentBadge) agentBadge.className = "player-badge black";
      if (playerPieceIndicator) {
        playerPieceIndicator.className = "piece-indicator red";
        playerPieceIndicator.textContent = "帥";
      }
      if (agentPieceIndicator) {
        agentPieceIndicator.className = "piece-indicator black";
        agentPieceIndicator.textContent = "將";
      }
      if (playerNameLabel) playerNameLabel.textContent = side1Name;
      if (playerSideLabel) playerSideLabel.textContent = "(红方)";
      renderAvatar(playerAvatarIcon, participants?.side1, "🤖");

      if (agentNameLabel) agentNameLabel.textContent = side2Name;
      if (agentSideLabel) agentSideLabel.textContent = "(黑方)";
      renderAvatar(agentAvatarIcon, participants?.side2, "🤖");

      if (playerCapturedContainer) playerCapturedContainer.title = `${side1Name}吃掉的黑子`;
      if (agentCapturedContainer) agentCapturedContainer.title = `${side2Name}吃掉的红子`;
    } else {
      const playerIsRed = playerSide === 1;
      const playerParticipant = playerSide === 1 ? participants?.side1 : participants?.side2;
      const playerName = playerParticipant?.name || "你";
      if (playerBadge) playerBadge.className = `player-badge ${playerIsRed ? "red" : "black"}`;
      if (agentBadge) agentBadge.className = `player-badge ${playerIsRed ? "black" : "red"}`;
      if (playerPieceIndicator) {
        playerPieceIndicator.className = `piece-indicator ${playerIsRed ? "red" : "black"}`;
        playerPieceIndicator.textContent = playerIsRed ? "帥" : "將";
      }
      if (agentPieceIndicator) {
        agentPieceIndicator.className = `piece-indicator ${playerIsRed ? "black" : "red"}`;
        agentPieceIndicator.textContent = playerIsRed ? "將" : "帥";
      }
      if (playerNameLabel) playerNameLabel.textContent = playerName;
      if (playerSideLabel) playerSideLabel.textContent = `(${sideName(playerSide)})`;
      renderAvatar(playerAvatarIcon, playerParticipant || { kind: "player" }, "👤");

      const agentParticipant = agentSide === 1 ? participants?.side1 : participants?.side2;
      const agName = agentParticipant?.name || (agentNameLabel?.textContent && agentNameLabel.textContent !== "AI Agent" ? agentNameLabel.textContent : "AI Agent");
      if (agentNameLabel) agentNameLabel.textContent = agName;
      if (agentSideLabel) agentSideLabel.textContent = `(${sideName(agentSide)})`;
      renderAvatar(agentAvatarIcon, agentParticipant, "🤖");

      if (playerCapturedContainer) playerCapturedContainer.title = `你吃掉的${sideName(agentSide).slice(0, 1)}子`;
      if (agentCapturedContainer) agentCapturedContainer.title = `AI 吃掉的${sideName(playerSide).slice(0, 1)}子`;
    }
  }

  function updateSpeechBanner(message, speakerPlayer) {
    if (speechText) speechText.textContent = message || "";
    if (!speechAvatar) return;
    let participant = null;
    if (gameMode === "player_vs_agent") {
      participant = agentSide === 1 ? participants?.side1 : participants?.side2;
    } else if (speakerPlayer === 1) {
      participant = participants?.side1;
    } else if (speakerPlayer === 2) {
      participant = participants?.side2;
    } else {
      participant = turn === 1 ? participants?.side1 : participants?.side2;
    }
    renderAvatar(speechAvatar, participant, "🤖");
  }

  function updateAgentInfo(info) {
    if (!info) return;
    const displayName = info.modelName || info.agentName || "AI Agent";
    if (agentNameLabel && (!participants || gameMode === "player_vs_agent")) {
      agentNameLabel.textContent = displayName;
      agentNameLabel.title = info.agentName ? `${info.agentName} (${info.modelName || "AI"})` : displayName;
    }
    if (info.avatarUrl) {
      if (gameMode === "player_vs_agent") {
        if (agentAvatarIcon && (!participants?.side2?.avatarUrl)) {
          agentAvatarIcon.innerHTML = `<img src="${info.avatarUrl}" alt="agent" class="agent-avatar-img" />`;
        }
        if (speechAvatar && (!participants?.side2?.avatarUrl)) {
          speechAvatar.innerHTML = `<img src="${info.avatarUrl}" alt="agent" class="speech-avatar-img" />`;
        }
      }
    }
  }

  const INITIAL_RED_COUNTS = { 5: 2, 6: 2, 4: 2, 3: 2, 2: 2, 7: 5 };
  const INITIAL_BLACK_COUNTS = { "-5": 2, "-6": 2, "-4": 2, "-3": 2, "-2": 2, "-7": 5 };
  const BLACK_ORDER = [-5, -6, -4, -3, -2, -7];
  const RED_ORDER = [5, 6, 4, 3, 2, 7];

  function updateCapturedTray() {
    if (!playerCapturedContainer || !agentCapturedContainer) return;

    // Count live pieces on board
    const liveCounts = {};
    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        const p = board[y][x];
        if (p !== 0) {
          liveCounts[p] = (liveCounts[p] || 0) + 1;
        }
      }
    }

    const isLeftRed = (gameMode === "agent_vs_agent" || gameMode === "agent_vs_engine" || playerSide === 0)
      ? true
      : playerSide === 1;

    const playerCapturedOrder = isLeftRed ? BLACK_ORDER : RED_ORDER;
    const agentCapturedOrder = isLeftRed ? RED_ORDER : BLACK_ORDER;

    // Pieces captured by the player (missing opponent pieces).
    playerCapturedContainer.innerHTML = "";
    for (const p of playerCapturedOrder) {
      const init = (p > 0 ? INITIAL_RED_COUNTS : INITIAL_BLACK_COUNTS)[p] || 0;
      const live = liveCounts[p] || 0;
      const capturedCount = init - live;
      for (let i = 0; i < capturedCount; i++) {
        const badge = document.createElement("span");
        badge.className = `mini-piece-badge ${p > 0 ? "red" : "black"}`;
        badge.textContent = PIECE_NAMES[p] || "";
        badge.title = PIECE_NAMES[p] || "";
        playerCapturedContainer.appendChild(badge);
      }
    }

    // Pieces captured by the Agent (missing player pieces).
    agentCapturedContainer.innerHTML = "";
    for (const p of agentCapturedOrder) {
      const init = (p > 0 ? INITIAL_RED_COUNTS : INITIAL_BLACK_COUNTS)[p] || 0;
      const live = liveCounts[p] || 0;
      const capturedCount = init - live;
      for (let i = 0; i < capturedCount; i++) {
        const badge = document.createElement("span");
        badge.className = `mini-piece-badge ${p > 0 ? "red" : "black"}`;
        badge.textContent = PIECE_NAMES[p] || "";
        badge.title = PIECE_NAMES[p] || "";
        agentCapturedContainer.appendChild(badge);
      }
    }
  }

  function createInitialBoard() {
    const b = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(0));
    // Red Side (bottom, y = 0..3)
    b[0][0] = 5; b[0][1] = 4; b[0][2] = 3; b[0][3] = 2; b[0][4] = 1;
    b[0][5] = 2; b[0][6] = 3; b[0][7] = 4; b[0][8] = 5;
    b[2][1] = 6; b[2][7] = 6;
    b[3][0] = 7; b[3][2] = 7; b[3][4] = 7; b[3][6] = 7; b[3][8] = 7;

    // Black Side (top, y = 6..9)
    b[9][0] = -5; b[9][1] = -4; b[9][2] = -3; b[9][3] = -2; b[9][4] = -1;
    b[9][5] = -2; b[9][6] = -3; b[9][7] = -4; b[9][8] = -5;
    b[7][1] = -6; b[7][7] = -6;
    b[6][0] = -7; b[6][2] = -7; b[6][4] = -7; b[6][6] = -7; b[6][8] = -7;
    return b;
  }

  let isMuted = false;
  try {
    isMuted = window.localStorage?.getItem("freebuddy_game_muted") === "true";
  } catch {}
  let audioCtx = null;
  let gameOverSoundPlayed = false;

  const muteBtn = document.getElementById("mute-btn");
  function updateMuteButtonUI() {
    if (!muteBtn) return;
    if (isMuted) {
      muteBtn.textContent = "🔇 静音";
      muteBtn.classList.add("muted");
      muteBtn.title = "音效已静音（点击开启）";
    } else {
      muteBtn.textContent = "🔊 音效";
      muteBtn.classList.remove("muted");
      muteBtn.title = "音效已开启（点击静音）";
    }
  }
  if (muteBtn) {
    updateMuteButtonUI();
    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      try {
        window.localStorage?.setItem("freebuddy_game_muted", String(isMuted));
      } catch {}
      updateMuteButtonUI();
    });
  }

  function withAudio(callback) {
    if (isMuted) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().then(() => {
          if (audioCtx && audioCtx.state === "running") {
            callback(audioCtx);
          }
        }).catch(() => {});
      } else if (audioCtx.state === "running") {
        callback(audioCtx);
      }
    } catch {}
  }

  // Global user interaction unlock
  const unlockAudio = () => {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
      }
    } catch {}
  };
  window.addEventListener("pointerdown", unlockAudio, { passive: true });
  window.addEventListener("keydown", unlockAudio, { passive: true });

  // 1. Move Sound: Solid Wood Strike (实木落子)
  function playPieceSound(isCapture = false) {
    withAudio((ctx) => {
      const now = ctx.currentTime;
      if (isCapture) {
        // Heavy impact capture
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "sawtooth";
        osc1.frequency.setValueAtTime(260, now);
        osc1.frequency.exponentialRampToValueAtTime(45, now + 0.15);
        gain1.gain.setValueAtTime(0.5, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(140, now);
        osc2.frequency.exponentialRampToValueAtTime(30, now + 0.13);
        gain2.gain.setValueAtTime(0.38, now);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now);
        osc2.stop(now + 0.13);
      } else {
        // Solid wood placement
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "triangle";
        osc1.frequency.setValueAtTime(340, now);
        osc1.frequency.exponentialRampToValueAtTime(80, now + 0.09);
        gain1.gain.setValueAtTime(0.42, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.09);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(120, now);
        osc2.frequency.exponentialRampToValueAtTime(45, now + 0.1);
        gain2.gain.setValueAtTime(0.28, now);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now);
        osc2.stop(now + 0.1);
      }
    });
  }

  // 2. Select Piece Sound: Soft wood tap (选子轻触)
  function playSelectSound() {
    withAudio((ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(560, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.04);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.04);
    });
  }

  // 3. Check Sound: Ancient East Asian Zither / Chime Strike (将军！金石之声)
  function playCheckSound() {
    withAudio((ctx) => {
      const freqs = [440.0, 554.37, 659.25, 880.0]; // A4, C#5, E5, A5
      const now = ctx.currentTime;
      freqs.forEach((freq, i) => {
        const start = now + i * 0.04;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.28, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.45);
      });
    });
  }

  // 4. Victory Sound (旗开得胜)
  function playVictorySound() {
    withAudio((ctx) => {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      const now = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const start = now + idx * 0.1;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.38);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.38);
      });
    });
  }

  // 5. Defeat Sound (惜败)
  function playDefeatSound() {
    withAudio((ctx) => {
      const notes = [392.0, 349.23, 311.13, 261.63]; // G4, F4, Eb4, C4
      const now = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const start = now + idx * 0.14;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.24, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.3);
      });
    });
  }

  function coordToString(x, y) {
    const col = COL_LETTERS[x] || `${x}`;
    return `${col}${y}`;
  }

  function moveToString(fromX, fromY, toX, toY) {
    return `${coordToString(fromX, fromY)}${coordToString(toX, toY)}`;
  }

  let cellWidth = 0;
  let cellHeight = 0;
  let paddingX = 0;
  let paddingY = 0;
  let pieceRadius = 0;
  let appliedWidth = 0;
  let appliedHeight = 0;
  let currentDpr = 0;
  let currentWideLayout = null;
  let fallbackRetried = false;
  let resizeRafId = null;

  function debouncedResizeCanvas() {
    if (typeof window === "undefined") return;
    if (resizeRafId) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(resizeRafId);
      } else {
        clearTimeout(resizeRafId);
      }
      resizeRafId = null;
    }
    const schedule = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    resizeRafId = schedule(() => {
      resizeRafId = null;
      resizeCanvas();
    });
  }

  function resizeCanvas() {
    const parent = canvas.parentElement || (typeof document.querySelector === "function" ? document.querySelector(".board-wrapper") : null) || (typeof document !== "undefined" ? document.body : null);
    const parentRect = parent && typeof parent.getBoundingClientRect === "function" ? parent.getBoundingClientRect() : null;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;

    const availWidth = parentRect && parentRect.width > 12
      ? parentRect.width - 12
      : Math.max(0, ((typeof window !== "undefined" && window.innerWidth) || 600) - 280);
    const availHeight = parentRect && parentRect.height > 12
      ? parentRect.height - 12
      : Math.max(0, ((typeof window !== "undefined" && window.innerHeight) || 600) - 140);

    // 9:10 aspect ratio
    let width = availWidth;
    let height = (width * 10) / 9;

    if (height > availHeight) {
      height = availHeight;
      width = (height * 9) / 10;
    }

    width = Math.floor(width);
    height = Math.floor(height);
    if (width <= 0 || height <= 0) {
      width = 450;
      height = 500;
      if (!fallbackRetried && typeof window !== "undefined") {
        fallbackRetried = true;
        debouncedResizeCanvas();
      }
    } else {
      fallbackRetried = false;
    }

    const wideLayout = ((typeof window !== "undefined" && window.innerWidth) || 0) >= 640;
    if (width === appliedWidth && height === appliedHeight
      && dpr === currentDpr && wideLayout === currentWideLayout) {
      // Skip when nothing changed: reassigning canvas.width clears the canvas
      // even for the same value, so avoid needless clears and repaints here.
      return;
    }
    appliedWidth = width;
    appliedHeight = height;
    currentDpr = dpr;
    currentWideLayout = wideLayout;

    paddingX = Math.max(22, Math.round(width * 0.08));
    paddingY = Math.max(22, Math.round(height * 0.075));
    cellWidth = (width - paddingX * 2) / (BOARD_COLS - 1);
    cellHeight = (height - paddingY * 2) / (BOARD_ROWS - 1);
    pieceRadius = Math.min(cellWidth, cellHeight) * 0.46;

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    if (moveHistoryPanel) {
      if ((typeof window !== "undefined" && window.innerWidth) >= 640) {
        moveHistoryPanel.style.height = `${height}px`;
      } else {
        moveHistoryPanel.style.height = "";
      }
    }

    drawBoard();
  }

  function getMouseGridCoord(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || cellWidth <= 0 || cellHeight <= 0) return null;

    const mouseX = (e.clientX - rect.left) * (canvas.width / ((typeof window !== "undefined" && window.devicePixelRatio) || 1) / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / ((typeof window !== "undefined" && window.devicePixelRatio) || 1) / rect.height);

    // Find closest intersection
    const x = Math.round((mouseX - paddingX) / cellWidth);
    const y = Math.round((mouseY - paddingY) / cellHeight);

    // Invert display Y so Red (y=0) is visually at the bottom
    const gridY = BOARD_ROWS - 1 - y;

    if (x >= 0 && x < BOARD_COLS && gridY >= 0 && gridY < BOARD_ROWS) {
      return { x, y: gridY };
    }
    return null;
  }

  function getPixelCoord(gridX, gridY) {
    const displayY = BOARD_ROWS - 1 - gridY;
    const px = paddingX + gridX * cellWidth;
    const py = paddingY + displayY * cellHeight;
    return { px, py };
  }

  // Draw corner markers (折角)
  function drawCornerMarker(gx, gy) {
    const { px, py } = getPixelCoord(gx, gy);
    const len = cellWidth * 0.16;
    const dist = cellWidth * 0.08;

    ctx.strokeStyle = "rgba(92, 58, 33, 0.75)";
    ctx.lineWidth = 1.5;

    const drawCorner = (dirX, dirY) => {
      ctx.beginPath();
      ctx.moveTo(px + dirX * dist, py + dirY * (dist + len));
      ctx.lineTo(px + dirX * dist, py + dirY * dist);
      ctx.lineTo(px + dirX * (dist + len), py + dirY * dist);
      ctx.stroke();
    };

    if (gx > 0) {
      drawCorner(-1, -1);
      drawCorner(-1, 1);
    }
    if (gx < BOARD_COLS - 1) {
      drawCorner(1, -1);
      drawCorner(1, 1);
    }
  }

  // Draw 3D Wooden Chinese Chess Piece
  function drawPiece(gx, gy, piece, isSelected = false) {
    const { px, py } = getPixelCoord(gx, gy);
    const isRed = piece > 0;
    const name = PIECE_NAMES[piece] || "";
    const radius = pieceRadius;

    ctx.save();

    // 1. Drop Shadow
    ctx.shadowColor = isSelected ? "rgba(245, 158, 11, 0.7)" : "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = isSelected ? 12 : 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;

    // 2. Outer Wood Circle with Radial Gradient
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    const woodGrad = ctx.createRadialGradient(
      px - radius * 0.3,
      py - radius * 0.3,
      radius * 0.1,
      px,
      py,
      radius
    );
    woodGrad.addColorStop(0, "#fef3c7");
    woodGrad.addColorStop(0.7, "#fde68a");
    woodGrad.addColorStop(1, "#d97706");
    ctx.fillStyle = woodGrad;
    ctx.fill();

    // 3. Outer Rim Border
    ctx.strokeStyle = isSelected ? "#f59e0b" : "#92400e";
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.stroke();

    // 4. Inset Ring Line
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.82, 0, Math.PI * 2);
    ctx.strokeStyle = isRed ? "rgba(220, 38, 38, 0.4)" : "rgba(30, 41, 59, 0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 5. Piece Calligraphic Character
    ctx.font = `bold ${Math.round(radius * 1.05)}px "Kaiti", "STKaiti", "KaiTi_GB2312", "SimSun", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = isRed ? "#b91c1c" : "#0f172a";
    ctx.shadowColor = isRed ? "rgba(254, 202, 202, 0.8)" : "rgba(226, 232, 240, 0.6)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    ctx.fillText(name, px, py + 1);

    ctx.restore();
  }

  // Render complete Xiangqi Canvas
  function drawBoard() {
    if (cellWidth <= 0 || cellHeight <= 0) {
      resizeCanvas();
      return;
    }
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);

    // 1. Board Background Texture
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, "#f5dfb8");
    bgGrad.addColorStop(1, "#e6c896");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Outer double wooden frame
    ctx.strokeStyle = "#5c3a21";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(paddingX - 6, paddingY - 6, (BOARD_COLS - 1) * cellWidth + 12, (BOARD_ROWS - 1) * cellHeight + 12);
    ctx.lineWidth = 1;
    ctx.strokeRect(paddingX - 10, paddingY - 10, (BOARD_COLS - 1) * cellWidth + 20, (BOARD_ROWS - 1) * cellHeight + 20);

    // 2. Grid lines
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 1.2;

    // Horizontal Lines (all 10 rows connected)
    for (let r = 0; r < BOARD_ROWS; r++) {
      const y = paddingY + r * cellHeight;
      ctx.beginPath();
      ctx.moveTo(paddingX, y);
      ctx.lineTo(paddingX + (BOARD_COLS - 1) * cellWidth, y);
      ctx.stroke();
    }

    // Vertical Lines (outer columns 0 & 8 connected through river; middle columns broken at river)
    for (let c = 0; c < BOARD_COLS; c++) {
      const x = paddingX + c * cellWidth;

      if (c === 0 || c === BOARD_COLS - 1) {
        // Outer borders go all the way
        ctx.beginPath();
        ctx.moveTo(x, paddingY);
        ctx.lineTo(x, paddingY + (BOARD_ROWS - 1) * cellHeight);
        ctx.stroke();
      } else {
        // Top half (Black side: row 0 to 4)
        ctx.beginPath();
        ctx.moveTo(x, paddingY);
        ctx.lineTo(x, paddingY + 4 * cellHeight);
        ctx.stroke();

        // Bottom half (Red side: row 5 to 9)
        ctx.beginPath();
        ctx.moveTo(x, paddingY + 5 * cellHeight);
        ctx.lineTo(x, paddingY + 9 * cellHeight);
        ctx.stroke();
      }
    }

    // 3. Palace Diagonals (九宫格斜线)
    // Black Palace (top)
    ctx.beginPath();
    ctx.moveTo(paddingX + 3 * cellWidth, paddingY + 0 * cellHeight);
    ctx.lineTo(paddingX + 5 * cellWidth, paddingY + 2 * cellHeight);
    ctx.moveTo(paddingX + 5 * cellWidth, paddingY + 0 * cellHeight);
    ctx.lineTo(paddingX + 3 * cellWidth, paddingY + 2 * cellHeight);
    // Red Palace (bottom)
    ctx.moveTo(paddingX + 3 * cellWidth, paddingY + 7 * cellHeight);
    ctx.lineTo(paddingX + 5 * cellWidth, paddingY + 9 * cellHeight);
    ctx.moveTo(paddingX + 5 * cellWidth, paddingY + 7 * cellHeight);
    ctx.lineTo(paddingX + 3 * cellWidth, paddingY + 9 * cellHeight);
    ctx.stroke();

    // 4. River Calligraphy (楚河 漢界)
    const riverY = paddingY + 4.5 * cellHeight;
    ctx.font = `bold ${Math.round(cellHeight * 0.42)}px "Kaiti", "STKaiti", "KaiTi_GB2312", "Microsoft YaHei", serif`;
    ctx.fillStyle = "rgba(120, 53, 15, 0.75)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillText("楚  河", paddingX + 2 * cellWidth, riverY);
    ctx.fillText("漢  界", paddingX + 6 * cellWidth, riverY);

    // 4.5 Subtle Coordinate Labels (Only Left & Bottom)
    ctx.fillStyle = "rgba(120, 53, 15, 0.45)";
    ctx.font = `500 ${Math.max(9, Math.round(cellWidth * 0.24))}px "Segoe UI", "PingFang SC", -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Column Letters (a - i) along bottom only
    for (let c = 0; c < BOARD_COLS; c++) {
      const x = paddingX + c * cellWidth;
      ctx.fillText(COL_LETTERS[c], x, height - paddingY * 0.42);
    }

    // Row Numbers (0 - 9) along left only (0 at Red bottom, 9 at Black top)
    for (let r = 0; r < BOARD_ROWS; r++) {
      const y = paddingY + r * cellHeight;
      const rowNum = `${BOARD_ROWS - 1 - r}`;
      ctx.fillText(rowNum, paddingX * 0.46, y);
    }

    // 5. Star / Cross Markers (兵/炮位十字花)
    const starMarkers = [
      // Red cannon & pawns
      [1, 2], [7, 2], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
      // Black cannon & pawns
      [1, 7], [7, 7], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]
    ];
    for (const [sx, sy] of starMarkers) {
      drawCornerMarker(sx, sy);
    }

    // 6. Last Move Highlights
    if (lastMove && lastMove.fromX !== undefined && lastMove.toX !== undefined) {
      const fromPos = getPixelCoord(lastMove.fromX, lastMove.fromY);
      const toPos = getPixelCoord(lastMove.toX, lastMove.toY);
      const r = pieceRadius * 1.08;

      ctx.save();
      ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(fromPos.px - r, fromPos.py - r, r * 2, r * 2);
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
      ctx.strokeRect(toPos.px - r, toPos.py - r, r * 2, r * 2);
      ctx.restore();
    }

    // 7. Render Pieces
    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        const piece = board[y][x];
        if (piece !== 0) {
          const isSelected = selectedCoord && selectedCoord.x === x && selectedCoord.y === y;
          drawPiece(x, y, piece, isSelected);
        }
      }
    }

    // 8. Render Legal Move Target Indicators
    if (selectedCoord && legalTargets.length > 0) {
      for (const target of legalTargets) {
        const { px, py } = getPixelCoord(target.toX, target.toY);
        const targetPiece = board[target.toY][target.toX];

        ctx.save();
        if (targetPiece !== 0) {
          // Capture Ring
          ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(px, py, pieceRadius * 1.15, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // Empty Move Dot
          ctx.fillStyle = "rgba(16, 185, 129, 0.85)";
          ctx.beginPath();
          ctx.arc(px, py, pieceRadius * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  function isSameSide(pieceA, pieceB) {
    return pieceA !== 0 && pieceB !== 0 && (pieceA > 0) === (pieceB > 0);
  }

  // Generate piece-rule moves for either side. King safety is filtered by
  // getClientLegalMoves below so the instant UI matches the backend rules.
  function getClientPseudoLegalMoves(fromX, fromY) {
    const piece = board[fromY][fromX];
    if (piece === 0) return [];
    const isRed = piece > 0;
    const absPiece = Math.abs(piece);
    const moves = [];

    const addIfValid = (tx, ty) => {
      if (tx < 0 || tx >= BOARD_COLS || ty < 0 || ty >= BOARD_ROWS) return;
      if (isSameSide(piece, board[ty][tx])) return;
      moves.push({ toX: tx, toY: ty });
    };

    switch (absPiece) {
      case 1: { // 帥/將 King
        const minY = isRed ? 0 : 7;
        const maxY = isRed ? 2 : 9;
        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (const [dx, dy] of dirs) {
          const nx = fromX + dx;
          const ny = fromY + dy;
          if (nx >= 3 && nx <= 5 && ny >= minY && ny <= maxY) {
            addIfValid(nx, ny);
          }
        }
        // Flying general
        const stepY = isRed ? 1 : -1;
        const opponentKing = isRed ? -1 : 1;
        let cy = fromY + stepY;
        while (cy >= 0 && cy < BOARD_ROWS) {
          const p = board[cy][fromX];
          if (p !== 0) {
            if (p === opponentKing) moves.push({ toX: fromX, toY: cy });
            break;
          }
          cy += stepY;
        }
        break;
      }
      case 2: { // 仕/士 Advisor
        const minY = isRed ? 0 : 7;
        const maxY = isRed ? 2 : 9;
        const dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (const [dx, dy] of dirs) {
          const nx = fromX + dx;
          const ny = fromY + dy;
          if (nx >= 3 && nx <= 5 && ny >= minY && ny <= maxY) {
            addIfValid(nx, ny);
          }
        }
        break;
      }
      case 3: { // 相/象 Bishop
        const minY = isRed ? 0 : 5;
        const maxY = isRed ? 4 : 9;
        const dirs = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
        for (const [dx, dy] of dirs) {
          const nx = fromX + dx;
          const ny = fromY + dy;
          const ex = fromX + dx / 2;
          const ey = fromY + dy / 2;
          if (nx >= 0 && nx < BOARD_COLS && ny >= minY && ny <= maxY) {
            if (board[ey][ex] === 0) addIfValid(nx, ny);
          }
        }
        break;
      }
      case 4: { // 傌/馬 Knight
        const km = [
          { dx: 1, dy: 2, lx: 0, ly: 1 }, { dx: -1, dy: 2, lx: 0, ly: 1 },
          { dx: 1, dy: -2, lx: 0, ly: -1 }, { dx: -1, dy: -2, lx: 0, ly: -1 },
          { dx: 2, dy: 1, lx: 1, ly: 0 }, { dx: 2, dy: -1, lx: 1, ly: 0 },
          { dx: -2, dy: 1, lx: -1, ly: 0 }, { dx: -2, dy: -1, lx: -1, ly: 0 }
        ];
        for (const m of km) {
          const nx = fromX + m.dx;
          const ny = fromY + m.dy;
          if (nx >= 0 && nx < BOARD_COLS && ny >= 0 && ny < BOARD_ROWS) {
            if (board[fromY + m.ly][fromX + m.lx] === 0) addIfValid(nx, ny);
          }
        }
        break;
      }
      case 5: { // 俥/車 Rook
        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (const [dx, dy] of dirs) {
          let nx = fromX + dx, ny = fromY + dy;
          while (nx >= 0 && nx < BOARD_COLS && ny >= 0 && ny < BOARD_ROWS) {
            const t = board[ny][nx];
            if (t === 0) {
              moves.push({ toX: nx, toY: ny });
            } else {
              if (!isSameSide(piece, t)) moves.push({ toX: nx, toY: ny });
              break;
            }
            nx += dx; ny += dy;
          }
        }
        break;
      }
      case 6: { // 炮/砲 Cannon
        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (const [dx, dy] of dirs) {
          let nx = fromX + dx, ny = fromY + dy;
          let jumped = false;
          while (nx >= 0 && nx < BOARD_COLS && ny >= 0 && ny < BOARD_ROWS) {
            const t = board[ny][nx];
            if (!jumped) {
              if (t === 0) moves.push({ toX: nx, toY: ny });
              else jumped = true;
            } else {
              if (t !== 0) {
                if (!isSameSide(piece, t)) moves.push({ toX: nx, toY: ny });
                break;
              }
            }
            nx += dx; ny += dy;
          }
        }
        break;
      }
      case 7: { // 兵/卒 Pawn
        addIfValid(fromX, fromY + (isRed ? 1 : -1));
        const crossedRiver = isRed ? fromY >= 5 : fromY <= 4;
        if (crossedRiver) {
          addIfValid(fromX - 1, fromY);
          addIfValid(fromX + 1, fromY);
        }
        break;
      }
    }

    return moves;
  }

  function isClientKingInCheck(redSide) {
    const kingPiece = redSide ? 1 : -1;
    let king = null;
    for (let y = 0; y < BOARD_ROWS && !king; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        if (board[y][x] === kingPiece) {
          king = { x, y };
          break;
        }
      }
    }
    if (!king) return true;

    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        const piece = board[y][x];
        if (piece === 0 || (piece > 0) === redSide) continue;
        const attacks = getClientPseudoLegalMoves(x, y);
        if (attacks.some((move) => move.toX === king.x && move.toY === king.y)) {
          return true;
        }
      }
    }
    return false;
  }

  // Player-facing targets must also resolve check. Previously this returned
  // pseudo-legal moves, so the UI offered moves that the backend rejected and
  // the optimistically moved piece appeared to bounce back.
  function getClientLegalMoves(fromX, fromY) {
    const piece = board[fromY][fromX];
    const playerIsRed = playerSide === 1;
    if (piece === 0 || (piece > 0) !== playerIsRed) return [];

    return getClientPseudoLegalMoves(fromX, fromY).filter((move) => {
      const captured = board[move.toY][move.toX];
      board[move.toY][move.toX] = piece;
      board[fromY][fromX] = 0;
      const safe = !isClientKingInCheck(playerIsRed);
      board[fromY][fromX] = piece;
      board[move.toY][move.toX] = captured;
      return safe;
    });
  }

  function getClientKingSafetyRejectedMoves(fromX, fromY, legalMoves) {
    const legalKeys = new Set(
      legalMoves.map((move) => `${move.toX},${move.toY}`)
    );
    return getClientPseudoLegalMoves(fromX, fromY).filter(
      (move) => !legalKeys.has(`${move.toX},${move.toY}`)
    );
  }

  function describeKingSafetyRejection(piece, fromY, rejectedMoves) {
    if (rejectedMoves.length === 0) return "";
    const kingName = playerSide === 1 ? "帅" : "将";
    const isPawnSideways = Math.abs(piece) === 7
      && rejectedMoves.some((move) => move.toY === fromY);
    return isPawnSideways
      ? `兵的横走会让己方${kingName}被将军，不能走。`
      : `另有 ${rejectedMoves.length} 个着法会让己方${kingName}被将军，不能走。`;
  }

  function handleCanvasClick(e) {
    if (!initialized) {
      statusText.textContent = "正在同步服务器棋面，请稍候...";
      window.parent.postMessage({ type: "REQUEST_SYNC" }, "*");
      return;
    }
    if (status !== "playing") {
      statusText.textContent = "本局已结束，请点击下方【重新开局】。";
      return;
    }

    if (playerSide === 0 || gameMode === "agent_vs_agent" || gameMode === "agent_vs_engine") {
      statusText.textContent = "当前为观战模式，棋子由 AI 自动走子。";
      return;
    }

    if (turn !== playerSide) {
      statusText.textContent = `当前轮到 AI Agent (${sideName(agentSide)}) 走子，请稍候...`;
      return;
    }

    const coord = getMouseGridCoord(e);
    if (!coord) return;

    const { x, y } = coord;
    const clickedPiece = board[y][x];

    // Case 1: Clicking a piece controlled by the player -> select it.
    if (clickedPiece !== 0 && (clickedPiece > 0) === (playerSide === 1)) {
      selectedCoord = { x, y };
      legalTargets = getClientLegalMoves(x, y);
      const rejectedMoves = getClientKingSafetyRejectedMoves(x, y, legalTargets);
      const rejectionHint = describeKingSafetyRejection(clickedPiece, y, rejectedMoves);
      statusText.textContent = legalTargets.length > 0
        ? `已选择【${PIECE_NAMES[clickedPiece]}】，点击绿色标记点移动。${rejectionHint ? ` ${rejectionHint}` : ""}`
        : isClientKingInCheck(playerSide === 1)
          ? `【${PIECE_NAMES[clickedPiece]}】当前没有能解除将军的合法着法。`
          : rejectionHint || `【${PIECE_NAMES[clickedPiece]}】当前没有合法着法。`;
      playSelectSound();
      drawBoard();
      return;
    }

    // Case 2: Clicking destination with a piece selected
    if (selectedCoord) {
      const isLegal = legalTargets.some((t) => t.toX === x && t.toY === y);
      if (isLegal) {
        const fromX = selectedCoord.x;
        const fromY = selectedCoord.y;
        const actionId = moveToString(fromX, fromY, x, y);
        const movingPiece = board[fromY][fromX];
        const isCapture = board[y][x] !== 0 && (board[y][x] > 0) !== (movingPiece > 0);

        // Apply local optimistic update
        board[y][x] = movingPiece;
        board[fromY][fromX] = 0;
        lastMove = { fromX, fromY, toX: x, toY: y, actionId, player: playerSide };
        turn = agentSide;
        selectedCoord = null;
        legalTargets = [];

        playPieceSound(isCapture);
        updateMoveHistory([...moveHistory, lastMove]);
        updateUI();
        drawBoard();

        // Notify Host
        window.parent.postMessage({
          type: "PLAYER_MOVE",
          payload: { actionId, fromX, fromY, toX: x, toY: y }
        }, "*");
      } else {
        const pseudoTarget = getClientPseudoLegalMoves(
          selectedCoord.x,
          selectedCoord.y
        ).some((move) => move.toX === x && move.toY === y);
        if (pseudoTarget) {
          const kingName = playerSide === 1 ? "帅" : "将";
          statusText.textContent = `这步会让己方${kingName}被将军，不能走。`;
          drawBoard();
          return;
        }
        selectedCoord = null;
        legalTargets = [];
        drawBoard();
      }
    }
  }

  function updateUI() {
    const playerInCheck =
      status === "playing" && turn === playerSide && isClientKingInCheck(playerSide === 1);
    const agentInCheck =
      status === "playing" && turn === agentSide && isClientKingInCheck(agentSide === 1);
    statusText.className = "status-text";

    if ((playerInCheck && !playerWasInCheck) || (agentInCheck && !agentWasInCheck)) {
      playCheckSound();
    }
    playerWasInCheck = playerInCheck;
    agentWasInCheck = agentInCheck;

    if (status === "player_won" || status === "agent_won") {
      if (!gameOverSoundPlayed) {
        gameOverSoundPlayed = true;
        if (playerSide === 0 || winner === playerSide) {
          playVictorySound();
        } else {
          playDefeatSound();
        }
      }

      if (playerSide === 0 || gameMode === "agent_vs_agent" || gameMode === "agent_vs_engine") {
        const winSide = winner ?? (status === "player_won" ? 1 : 2);
        const winnerName = winSide === 1
          ? (participants?.side1?.name || "红方 AI")
          : (participants?.side2?.name || "黑方 AI");
        turnBadge.className = "turn-indicator win";
        turnBadge.textContent = `🏆 ${winnerName} 获胜`;
        statusText.textContent = `🎉 ${winnerName} 绝杀获胜！棋局已完整保留供复盘截图。`;
      } else if (status === "player_won") {
        turnBadge.className = "turn-indicator win";
        turnBadge.textContent = "🏆 旗开得胜！你赢了";
        statusText.textContent = "🎉 恭喜你绝杀获胜！棋局已完整保留供复盘截图。";
      } else {
        const agentName = agentNameLabel?.textContent || "AI Agent";
        turnBadge.className = "turn-indicator lose";
        turnBadge.textContent = "🤖 Agent 绝杀获胜";
        statusText.textContent = `${agentName} 绝杀获胜！棋局已完整保留供复盘截图。`;
      }

      restartBtn.className = "btn primary";
      restartBtn.textContent = "再来一局";
      resignBtn.style.display = "none";
      if (retryAgentBtn) retryAgentBtn.style.display = "none";
    } else if (status === "draw") {
      turnBadge.className = "turn-indicator draw";
      turnBadge.textContent = "🤝 双方握手言和 (平局)";
      statusText.textContent = "双方握手言和。点击【再来一局】开启新对决。";
      restartBtn.className = "btn primary";
      restartBtn.textContent = "再来一局";
      resignBtn.style.display = "none";
      if (retryAgentBtn) retryAgentBtn.style.display = "none";
    } else {
      gameOverSoundPlayed = false;
      restartBtn.className = "btn";
      restartBtn.textContent = "重新开局";
      resignBtn.style.display = playerSide === 0 ? "none" : "inline-block";
      if (playerSide === 0) {
        const curSideName = turn === 1
          ? (participants?.side1?.name || "红方 AI")
          : (participants?.side2?.name || "黑方 AI");
        const sideInCheck = isClientKingInCheck(turn === 1);
        if (sideInCheck) {
          turnBadge.className = "turn-indicator in-check";
          turnBadge.textContent = `⚠️ 将军！${curSideName} 正在应将`;
          statusText.className = "status-text in-check";
          statusText.textContent = `【观战中】${curSideName} 正被攻击，必须应将解除威胁。`;
        } else {
          turnBadge.className = "turn-indicator active-agent";
          turnBadge.textContent = `${curSideName} 思考中... (${sideName(turn)})`;
          statusText.textContent = `【观战中】${curSideName} 正在思考走子方案...`;
        }
        if (retryAgentBtn) retryAgentBtn.style.display = "none";
      } else if (turn === playerSide) {
        if (playerInCheck) {
          turnBadge.className = "turn-indicator in-check";
          turnBadge.textContent = "⚠️ 将军！请立即应将";
          statusText.className = "status-text in-check";
          statusText.textContent = `${playerSide === 1 ? "红帅" : "黑将"}正被攻击，只能选择能够解除将军的绿色目标点。`;
        } else {
          turnBadge.className = "turn-indicator active-player";
          turnBadge.textContent = `轮到你行动 (${sideName(playerSide)})`;
          statusText.textContent = "点击己方棋子，再点击目标位置移动";
        }
        if (retryAgentBtn) retryAgentBtn.style.display = "none";
      } else {
        if (agentInCheck) {
          turnBadge.className = "turn-indicator in-check";
          turnBadge.textContent = "⚔️ 你已将军！等待 Agent 应将";
          statusText.className = "status-text in-check";
          statusText.textContent = `${agentSide === 1 ? "红帅" : "黑将"}正被攻击，Agent 本回合必须解除将军。`;
        } else {
          turnBadge.className = "turn-indicator active-agent";
          turnBadge.textContent = `Agent 正在思考中... (${sideName(agentSide)})`;
          statusText.textContent = "AI Agent 正在思考走子方案...";
        }
      }
    }

    updateCapturedTray();
  }

  function syncState(rawSnapshot) {
    if (!rawSnapshot) return;
    const snapshot = rawSnapshot.gameState || rawSnapshot;
    const prevMove = lastMove;
    board = snapshot.board || board;
    turn = snapshot.turn ?? turn;
    playerSide = snapshot.playerSide ?? playerSide;
    agentSide = snapshot.agentSide ?? agentSide;
    status = snapshot.status || status;
    winner = snapshot.winner ?? (snapshot.status === "player_won" ? snapshot.playerSide : snapshot.status === "agent_won" ? snapshot.agentSide : winner);
    lastMove = snapshot.lastMove || null;
    gameMode = snapshot.gameMode || (playerSide === 0 ? "agent_vs_agent" : "player_vs_agent");
    if (snapshot.participants) {
      participants = {
        side1: {
          ...(participants?.side1 || {}),
          ...snapshot.participants.side1,
          avatarUrl: snapshot.participants.side1?.avatarUrl || participants?.side1?.avatarUrl
        },
        side2: {
          ...(participants?.side2 || {}),
          ...snapshot.participants.side2,
          avatarUrl: snapshot.participants.side2?.avatarUrl || participants?.side2?.avatarUrl
        }
      };
    }

    if (snapshot.chatHistory && snapshot.chatHistory.length > 0) {
      const latestAgentChat = [...snapshot.chatHistory].reverse().find((c) => c.sender === "agent");
      if (latestAgentChat) {
        const speakerPlayer = latestAgentChat.player || (gameMode === "player_vs_agent" ? agentSide : snapshot.lastMove?.player);
        updateSpeechBanner(latestAgentChat.message, speakerPlayer);
      }
    }

    if (snapshot.moveHistory) {
      updateMoveHistory(snapshot.moveHistory);
    } else if (snapshot.lastMove) {
      const alreadyHas = moveHistory.some(m => m.actionId === snapshot.lastMove.actionId && m.player === snapshot.lastMove.player);
      if (!alreadyHas) {
        updateMoveHistory([...moveHistory, snapshot.lastMove]);
      }
    } else if (snapshot.stepCount === 0 || snapshot.status === "waiting") {
      updateMoveHistory([]);
    }

    if (initialized && lastMove && (!prevMove || prevMove.actionId !== lastMove.actionId)) {
      playPieceSound(Boolean(lastMove.capturedPiece));
    }
    initialized = true;

    selectedCoord = null;
    legalTargets = [];
    updateSideLabels();
    updateUI();
    drawBoard();
  }

  // Host Message Listener
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "FREEBUDDY_GAME_SYNC" || data.type === "GAME_STATE_UPDATE") {
      debouncedResizeCanvas();
      syncState(data.payload);
      if (data.payload?.agentInfo) {
        updateAgentInfo(data.payload.agentInfo);
      }
    } else if (data.type === "AGENT_INFO_UPDATE") {
      updateAgentInfo(data.payload);
    } else if (data.type === "AGENT_CHAT") {
      const speakerPlayer = data.payload?.player || (gameMode === "player_vs_agent" ? agentSide : turn);
      updateSpeechBanner(data.payload?.message || "", speakerPlayer);
    } else if (data.type === "MOVE_REJECTED") {
      selectedCoord = null;
      legalTargets = [];
      statusText.textContent =
        "⚠ 着法被拒绝：" + (data.payload?.error || "非法着法") + " 棋面已恢复为服务器状态。";
      drawBoard();
    } else if (data.type === "AGENT_STALLED") {
      const isStalled = Boolean(data.payload?.stalled);
      if (isStalled && turn === agentSide && status === "playing") {
        if (retryAgentBtn) retryAgentBtn.style.display = "inline-block";
        statusText.textContent = "AI 回复结束但未走子，请点击【重试】";
      } else {
        if (retryAgentBtn) retryAgentBtn.style.display = "none";
      }
    }
  });

  // Action Buttons
  restartBtn.addEventListener("click", () => {
    window.parent.postMessage({ type: "GAME_RESET" }, "*");
  });

  resignBtn.addEventListener("click", () => {
    if (confirm("确定要认输吗？")) {
      window.parent.postMessage({ type: "GAME_RESIGN" }, "*");
    }
  });

  if (retryAgentBtn) {
    retryAgentBtn.addEventListener("click", () => {
      window.parent.postMessage({ type: "REMIND_AGENT" }, "*");
      retryAgentBtn.style.display = "none";
      statusText.textContent = "已向 AI 重新发送走子请求...";
    });
  }

  if (toggleHistoryBtn) {
    toggleHistoryBtn.addEventListener("click", () => {
      const isCollapsed = moveHistoryPanel?.classList.contains("collapsed");
      setHistoryPanelVisible(isCollapsed);
    });
  }

  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener("click", () => {
      setHistoryPanelVisible(false);
    });
  }

  canvas.addEventListener("click", handleCanvasClick);

  const boardContainer = canvas.parentElement || (typeof document.querySelector === "function" ? document.querySelector(".board-wrapper") : null) || (typeof document !== "undefined" ? document.body : null);

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", debouncedResizeCanvas);
    window.addEventListener("focus", debouncedResizeCanvas);
  }

  if (typeof window !== "undefined" && typeof window.ResizeObserver === "function" && boardContainer) {
    try {
      const ro = new window.ResizeObserver(() => {
        debouncedResizeCanvas();
      });
      ro.observe(boardContainer);
    } catch (e) {
      // In case ResizeObserver throws
    }
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        resizeCanvas();
        debouncedResizeCanvas();
      }
    });
  }

  // Share Card Generation
  const shareBtn = document.getElementById("share-btn");
  const shareModal = document.getElementById("share-modal");
  const closeShareBtn = document.getElementById("close-share-btn");
  const shareImagePreview = document.getElementById("share-image-preview");
  const copyShareBtn = document.getElementById("copy-share-btn");
  const downloadShareBtn = document.getElementById("download-share-btn");
  const shareToast = document.getElementById("share-toast");

  function showToast(msg) {
    if (!shareToast) return;
    shareToast.textContent = msg;
    shareToast.style.display = "block";
    setTimeout(() => {
      shareToast.style.display = "none";
    }, 2000);
  }

  function generateShareImageCanvas() {
    const cardCanvas = document.createElement("canvas");
    const cardWidth = 720;
    const cardHeight = 920;
    cardCanvas.width = cardWidth;
    cardCanvas.height = cardHeight;
    const sCtx = cardCanvas.getContext("2d");

    // 1. Background Gradient
    const bgGrad = sCtx.createLinearGradient(0, 0, 0, cardHeight);
    bgGrad.addColorStop(0, "#0f172a");
    bgGrad.addColorStop(0.5, "#1e293b");
    bgGrad.addColorStop(1, "#090d16");
    sCtx.fillStyle = bgGrad;
    sCtx.fillRect(0, 0, cardWidth, cardHeight);

    // Decorative aura
    sCtx.save();
    const aura = sCtx.createRadialGradient(cardWidth / 2, 240, 10, cardWidth / 2, 240, 380);
    aura.addColorStop(0, "rgba(220, 38, 38, 0.15)");
    aura.addColorStop(1, "rgba(0, 0, 0, 0)");
    sCtx.fillStyle = aura;
    sCtx.fillRect(0, 0, cardWidth, cardHeight);
    sCtx.restore();

    // 2. Card Header
    sCtx.font = "bold 20px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    sCtx.fillStyle = "#f87171";
    sCtx.fillText("FreeBuddy 对战大厅", 40, 52);

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    sCtx.font = "14px -apple-system, sans-serif";
    sCtx.fillStyle = "#94a3b8";
    sCtx.textAlign = "right";
    sCtx.fillText(dateStr, cardWidth - 40, 52);
    sCtx.textAlign = "left";

    // 3. Match Title & Status Badge
    sCtx.font = "bold 28px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    sCtx.fillStyle = "#ffffff";
    sCtx.fillText("中国象棋 · 赛后复盘战报", 40, 98);

    // Outcome Badge
    let outcomeText = "对局进行中";
    let badgeColor = "#3b82f6";
    if (status === "player_won") {
      outcomeText = "🏆 玩家绝杀胜出";
      badgeColor = "#10b981";
    } else if (status === "agent_won") {
      outcomeText = "🤖 AI Agent 绝杀获胜";
      badgeColor = "#ef4444";
    } else if (status === "draw") {
      outcomeText = "🤝 双方握手言和 (平局)";
      badgeColor = "#94a3b8";
    }

    sCtx.font = "bold 15px -apple-system, sans-serif";
    const textWidth = sCtx.measureText(outcomeText).width;
    const badgeX = 40;
    const badgeY = 118;
    sCtx.fillStyle = "rgba(255, 255, 255, 0.08)";
    sCtx.strokeStyle = badgeColor;
    sCtx.lineWidth = 1.5;
    sCtx.beginPath();
    if (typeof sCtx.roundRect === "function") {
      sCtx.roundRect(badgeX, badgeY, textWidth + 24, 30, 15);
    } else {
      sCtx.rect(badgeX, badgeY, textWidth + 24, 30);
    }
    sCtx.fill();
    sCtx.stroke();

    sCtx.fillStyle = badgeColor;
    sCtx.fillText(outcomeText, badgeX + 12, badgeY + 20);

    // Players Info
    const agentDisplay = agentNameLabel?.textContent || "AI Agent";
    sCtx.font = "14px -apple-system, sans-serif";
    sCtx.fillStyle = "#e2e8f0";
    sCtx.textAlign = "right";
    const playerDot = playerSide === 1 ? "🔴" : "⚫";
    const agentDot = agentSide === 1 ? "🔴" : "⚫";
    sCtx.fillText(`${playerDot} 玩家 (${playerSide === 1 ? "红" : "黑"})  VS  ${agentDot} ${agentDisplay} (${agentSide === 1 ? "红" : "黑"})`, cardWidth - 40, 138);
    sCtx.textAlign = "left";

    // 4. Draw Chessboard (9:10 ratio)
    const boardW = 540;
    const boardH = 600;
    const boardX = (cardWidth - boardW) / 2;
    const boardY = 175;

    sCtx.save();
    sCtx.shadowColor = "rgba(0, 0, 0, 0.6)";
    sCtx.shadowBlur = 24;
    sCtx.shadowOffsetY = 12;
    sCtx.drawImage(canvas, boardX, boardY, boardW, boardH);
    sCtx.restore();

    // 5. Footer Watermark
    sCtx.font = "13px -apple-system, sans-serif";
    sCtx.fillStyle = "#64748b";
    sCtx.textAlign = "center";
    sCtx.fillText("由 FreeBuddy AI 智能体对战引擎驱动 · Powered by FreeBuddy", cardWidth / 2, cardHeight - 36);

    return cardCanvas;
  }

  function openShareModal() {
    const shareCanvas = generateShareImageCanvas();
    const dataUrl = shareCanvas.toDataURL("image/png");
    if (shareImagePreview) {
      shareImagePreview.src = dataUrl;
    }
    if (shareModal) {
      shareModal.style.display = "flex";
    }
  }

  function closeShareModal() {
    if (shareModal) {
      shareModal.style.display = "none";
    }
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", openShareModal);
  }

  if (closeShareBtn) {
    closeShareBtn.addEventListener("click", closeShareModal);
  }

  if (shareModal) {
    shareModal.addEventListener("click", (e) => {
      if (e.target === shareModal) closeShareModal();
    });
  }

  if (copyShareBtn) {
    copyShareBtn.addEventListener("click", async () => {
      try {
        const shareCanvas = generateShareImageCanvas();
        shareCanvas.toBlob(async (blob) => {
          if (!blob) return;
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob })
            ]);
            showToast("✓ 图片已复制到剪贴板！");
          } catch {
            showToast("复制失败，请使用保存图片");
          }
        }, "image/png");
      } catch {
        showToast("复制失败，请使用保存图片");
      }
    });
  }

  if (downloadShareBtn) {
    downloadShareBtn.addEventListener("click", () => {
      const shareCanvas = generateShareImageCanvas();
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      link.download = `FreeBuddy_象棋战报_${timestamp}.png`;
      link.href = shareCanvas.toDataURL("image/png");
      link.click();
      showToast("✓ 战报图片已下载！");
    });
  }

  // Initialize
  resizeCanvas();
  updateUI();

  // Notify host that canvas is ready
  window.parent.postMessage({ type: "GAME_CANVAS_READY" }, "*");
})();
