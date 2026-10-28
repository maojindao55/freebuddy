(function () {
  const BOARD_SIZE = 15;
  const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
  const STAR_POINTS = [
    [3, 3], [11, 3], [7, 7], [3, 11], [11, 11]
  ];

  // State
  let board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
  let turn = 1; // 1: Black, 2: White
  let playerSide = 1;
  let agentSide = 2;
  let status = "playing";
  let winner = null;
  let lastMove = null;
  let hoverCoord = null;
  let initialized = false;

  // DOM Elements
  const canvas = document.getElementById("gomoku-canvas");
  const ctx = canvas.getContext("2d");
  const turnBadge = document.getElementById("turn-badge");
  const speechText = document.getElementById("speech-text");
  const statusText = document.getElementById("status-text");
  const restartBtn = document.getElementById("restart-btn");
  const resignBtn = document.getElementById("resign-btn");
  const retryAgentBtn = document.getElementById("retry-agent-btn");
  const playerAvatarIcon = document.getElementById("player-avatar-icon");
  const playerNameLabel = document.getElementById("player-name-label");
  const playerSideLabel = document.getElementById("player-side-label");
  const playerSideDot = document.getElementById("player-side-dot");
  const agentAvatarIcon = document.getElementById("agent-avatar-icon");
  const agentNameLabel = document.getElementById("agent-name-label");
  const agentSideLabel = document.getElementById("agent-side-label");
  const agentSideDot = document.getElementById("agent-side-dot");
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
    return side === 1 ? "黑子" : "白子";
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
      const isBlack = move.player === 1;
      actorTag.className = `actor-tag ${isBlack ? "black" : "white"}`;
      actorTag.textContent = isBlack ? "黑" : "白";

      const notation = document.createElement("span");
      notation.className = "move-notation";
      notation.textContent = move.actionId || `${move.x},${move.y}`;
      if (move.reason) {
        notation.title = move.reason;
      }

      const tagsWrap = document.createElement("span");
      tagsWrap.className = "history-tags";

      if (isLatest && (status === "player_won" || status === "agent_won")) {
        const winBadge = document.createElement("span");
        winBadge.className = "tag-badge win";
        winBadge.textContent = "绝杀";
        tagsWrap.appendChild(winBadge);
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
      const side1Name = participants?.side1?.name || (participants?.side1?.kind === "engine" ? "极智引擎" : "黑方 AI");
      const side2Name = participants?.side2?.name || (participants?.side2?.kind === "engine" ? "极智引擎" : "白方 AI");
      if (playerNameLabel) playerNameLabel.textContent = side1Name;
      if (playerSideLabel) playerSideLabel.textContent = "(黑棋)";
      if (playerSideDot) playerSideDot.className = "stone-dot black";
      renderAvatar(playerAvatarIcon, participants?.side1, "🤖");

      if (agentNameLabel) agentNameLabel.textContent = side2Name;
      if (agentSideLabel) agentSideLabel.textContent = "(白棋)";
      if (agentSideDot) agentSideDot.className = "stone-dot white";
      renderAvatar(agentAvatarIcon, participants?.side2, "🤖");
    } else {
      const isPlayerBlack = playerSide === 1;
      const playerParticipant = playerSide === 1 ? participants?.side1 : participants?.side2;
      const playerName = playerParticipant?.name || "你";
      if (playerNameLabel) playerNameLabel.textContent = playerName;
      if (playerSideLabel) playerSideLabel.textContent = isPlayerBlack ? "(黑棋)" : "(白棋)";
      if (playerSideDot) playerSideDot.className = `stone-dot ${isPlayerBlack ? "black" : "white"}`;
      renderAvatar(playerAvatarIcon, playerParticipant || { kind: "player" }, "👤");

      const agentParticipant = agentSide === 1 ? participants?.side1 : participants?.side2;
      const agName = agentParticipant?.name || (agentNameLabel?.textContent && agentNameLabel.textContent !== "AI Agent" ? agentNameLabel.textContent : "AI Agent");
      if (agentNameLabel) agentNameLabel.textContent = agName;
      if (agentSideLabel) agentSideLabel.textContent = isPlayerBlack ? "(白棋)" : "(黑棋)";
      if (agentSideDot) agentSideDot.className = `stone-dot ${isPlayerBlack ? "white" : "black"}`;
      renderAvatar(agentAvatarIcon, agentParticipant, "🤖");
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

  // 1. Crisp Stone Placement Click (云子落盘)
  function playStoneSound() {
    withAudio((ctx) => {
      const now = ctx.currentTime;
      // High-pitch stone snap
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(620, now);
      osc1.frequency.exponentialRampToValueAtTime(220, now + 0.05);
      gain1.gain.setValueAtTime(0.4, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.05);

      // Wood board resonance
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(240, now);
      osc2.frequency.exponentialRampToValueAtTime(90, now + 0.08);
      gain2.gain.setValueAtTime(0.28, now);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now);
      osc2.stop(now + 0.08);
    });
  }

  // 2. Victory Arpeggio (旗开得胜和弦)
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
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.35);
      });
    });
  }

  // 3. Defeat Tone (惜败音效)
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
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.28);
      });
    });
  }

  function coordToString(x, y) {
    const col = COLS[x] || `${x}`;
    const row = BOARD_SIZE - y;
    return `${col}${row}`;
  }

  let currentGridSize = 0;
  let currentPadding = 0;
  let currentCellSize = 0;
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
    let size = Math.floor(Math.min(availWidth, availHeight));
    if (size <= 0) {
      size = 460;
      if (!fallbackRetried && typeof window !== "undefined") {
        fallbackRetried = true;
        debouncedResizeCanvas();
      }
    } else {
      fallbackRetried = false;
    }

    const wideLayout = ((typeof window !== "undefined" && window.innerWidth) || 0) >= 640;
    if (size === currentGridSize && dpr === currentDpr && wideLayout === currentWideLayout) {
      // Skip when nothing changed: reassigning canvas.width clears the canvas
      // even for the same value, so avoid needless clears and repaints here.
      return;
    }
    currentDpr = dpr;
    currentWideLayout = wideLayout;

    currentGridSize = size;
    currentPadding = Math.max(22, Math.round(size * 0.08));
    currentCellSize = (size - currentPadding * 2) / (BOARD_SIZE - 1);

    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    if (moveHistoryPanel) {
      if ((typeof window !== "undefined" && window.innerWidth) >= 640) {
        moveHistoryPanel.style.height = `${size}px`;
      } else {
        moveHistoryPanel.style.height = "";
      }
    }

    drawBoard();
  }

  function getMouseGridCoord(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || currentGridSize <= 0 || currentCellSize <= 0) return null;

    const mouseX = (e.clientX - rect.left) * (currentGridSize / rect.width);
    const mouseY = (e.clientY - rect.top) * (currentGridSize / rect.height);

    const x = Math.round((mouseX - currentPadding) / currentCellSize);
    const y = Math.round((mouseY - currentPadding) / currentCellSize);

    if (x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE) {
      return { x, y };
    }
    return null;
  }

  function drawStone(x, y, radius, player) {
    ctx.save();
    // Drop shadow
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);

    if (player === 1) {
      // Black stone (3D gradient)
      const grad = ctx.createRadialGradient(
        x - radius * 0.3,
        y - radius * 0.3,
        radius * 0.1,
        x,
        y,
        radius
      );
      grad.addColorStop(0, "#666666");
      grad.addColorStop(0.4, "#222222");
      grad.addColorStop(1, "#0a0a0a");
      ctx.fillStyle = grad;
    } else {
      // White stone (3D gradient)
      const grad = ctx.createRadialGradient(
        x - radius * 0.3,
        y - radius * 0.3,
        radius * 0.1,
        x,
        y,
        radius
      );
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.7, "#eeeeee");
      grad.addColorStop(1, "#cccccc");
      ctx.fillStyle = grad;
    }
    ctx.fill();
    ctx.restore();
  }

  function drawBoard() {
    if (currentGridSize <= 0) {
      resizeCanvas();
      return;
    }

    const size = currentGridSize;
    const padding = currentPadding;
    const cellSize = currentCellSize;
    const stoneRadius = cellSize * 0.43;

    ctx.clearRect(0, 0, size, size);

    // Board background texture
    ctx.fillStyle = "#deb887";
    ctx.fillRect(0, 0, size, size);

    // Grid lines
    ctx.strokeStyle = "#5c3a21";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < BOARD_SIZE; i++) {
      // Horizontal
      ctx.moveTo(padding, padding + i * cellSize);
      ctx.lineTo(size - padding, padding + i * cellSize);
      // Vertical
      ctx.moveTo(padding + i * cellSize, padding);
      ctx.lineTo(padding + i * cellSize, size - padding);
    }
    ctx.stroke();

    // Coordinates labels (Subtle left & bottom)
    ctx.fillStyle = "rgba(107, 68, 35, 0.45)";
    ctx.font = `500 ${Math.max(9, cellSize * 0.28)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i < BOARD_SIZE; i++) {
      // Letters along bottom
      ctx.fillText(COLS[i], padding + i * cellSize, size - padding * 0.42);
      // Numbers along left
      ctx.fillText(`${BOARD_SIZE - i}`, padding * 0.45, padding + i * cellSize);
    }

    // Star points
    ctx.fillStyle = "#5c3a21";
    for (const [sx, sy] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(padding + sx * cellSize, padding + sy * cellSize, cellSize * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stones
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const val = board[y][x];
        if (val !== 0) {
          drawStone(padding + x * cellSize, padding + y * cellSize, stoneRadius, val);
        }
      }
    }

    // Last Move Indicator
    if (lastMove) {
      const lx = padding + lastMove.x * cellSize;
      const ly = padding + lastMove.y * cellSize;
      ctx.strokeStyle = lastMove.player === playerSide ? "#ef4444" : "#3b82f6";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(lx - stoneRadius * 0.4, ly - stoneRadius * 0.4, stoneRadius * 0.8, stoneRadius * 0.8);
    }

    // Hover stone preview & crosshair snap circle
    if (hoverCoord && status === "playing" && turn === playerSide && board[hoverCoord.y][hoverCoord.x] === 0) {
      const hx = padding + hoverCoord.x * cellSize;
      const hy = padding + hoverCoord.y * cellSize;

      // Small target ring at the exact intersection point
      ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, stoneRadius * 0.35, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.globalAlpha = 0.55;
      drawStone(hx, hy, stoneRadius, playerSide);
      ctx.restore();
    }
  }

  function handleCanvasClick(e) {
    if (!initialized) {
      statusText.textContent = "正在同步服务器棋面，请稍候...";
      window.parent.postMessage({ type: "REQUEST_SYNC" }, "*");
      return;
    }
    if (status !== "playing") {
      statusText.textContent = "本局已结束，请点击下方【重新开局】发起新一轮对战。";
      return;
    }

    if (playerSide === 0 || gameMode === "agent_vs_agent" || gameMode === "agent_vs_engine") {
      statusText.textContent = "当前为观战模式，棋子由 AI 自动落子。";
      return;
    }

    if (turn !== playerSide) {
      statusText.textContent = `当前轮到 AI Agent (${sideName(agentSide)}) 行动，请稍候或点击下方【催促 Agent】。`;
      return;
    }

    const coord = getMouseGridCoord(e);
    if (!coord) return;

    const { x, y } = coord;
    if (board[y][x] !== 0) {
      statusText.textContent = `坐标 ${coordToString(x, y)} 已有棋子，请在空白交叉点落子。`;
      return;
    }

    const actionId = coordToString(x, y);

    // Local optimistic update
    board[y][x] = playerSide;
    lastMove = { x, y, player: playerSide, actionId };
    turn = agentSide;
    hoverCoord = null;
    playStoneSound();
    updateMoveHistory([...moveHistory, lastMove]);
    updateUI();
    drawBoard();

    // Post message to FreeBuddy host
    window.parent.postMessage({
      type: "PLAYER_MOVE",
      payload: { actionId, x, y }
    }, "*");
  }

  function handleMouseMove(e) {
    if (status !== "playing" || playerSide === 0) {
      if (hoverCoord) {
        hoverCoord = null;
        drawBoard();
      }
      return;
    }

    const coord = getMouseGridCoord(e);
    if (coord && board[coord.y][coord.x] === 0) {
      if (!hoverCoord || hoverCoord.x !== coord.x || hoverCoord.y !== coord.y) {
        hoverCoord = coord;
        drawBoard();
      }
    } else if (hoverCoord) {
      hoverCoord = null;
      drawBoard();
    }
  }

  function updateUI() {
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
          ? (participants?.side1?.name || "黑方 AI")
          : (participants?.side2?.name || "白方 AI");
        turnBadge.className = "turn-indicator win";
        turnBadge.textContent = `🏆 ${winnerName} 获胜`;
        statusText.textContent = `🎉 ${winnerName} 完成五连珠获胜！棋盘已完整保留供复盘截图。`;
      } else if (status === "player_won") {
        turnBadge.className = "turn-indicator win";
        turnBadge.textContent = "🏆 旗开得胜！你赢了";
        statusText.textContent = "🎉 恭喜你完成五连珠！棋盘已完整保留供复盘截图。";
      } else {
        const agentName = agentNameLabel?.textContent || "AI Agent";
        turnBadge.className = "turn-indicator lose";
        turnBadge.textContent = "🤖 Agent 抢先连珠获胜";
        statusText.textContent = `${agentName} 获胜！对战结束，棋盘已完整保留供复盘截图。`;
      }

      restartBtn.className = "btn primary";
      restartBtn.textContent = "再来一局";
      resignBtn.style.display = "none";
      if (retryAgentBtn) retryAgentBtn.style.display = "none";
    } else if (status === "draw") {
      turnBadge.className = "turn-indicator draw";
      turnBadge.textContent = "🤝 双方握手言和 (平局)";
      statusText.textContent = "棋盘已走满 225 步。点击【再来一局】开启新对决。";
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
          ? (participants?.side1?.name || "黑棋 AI")
          : (participants?.side2?.name || "白棋 AI");
        turnBadge.className = "turn-indicator active-agent";
        turnBadge.textContent = `${curSideName} 思考中... (${sideName(turn)})`;
        statusText.textContent = `【观战中】${curSideName} 正在思考并落子...`;
        if (retryAgentBtn) retryAgentBtn.style.display = "none";
      } else if (turn === playerSide) {
        turnBadge.className = "turn-indicator active-player";
        turnBadge.textContent = `轮到你行动 (${sideName(playerSide)})`;
        statusText.textContent = "请在棋盘上点击落子";
        if (retryAgentBtn) retryAgentBtn.style.display = "none";
      } else {
        turnBadge.className = "turn-indicator active-agent";
        turnBadge.textContent = `Agent 正在思考中... (${sideName(agentSide)})`;
        statusText.textContent = "AI Agent 正在思考并落子中...";
      }
    }
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
      const latestAgentChat = [...snapshot.chatHistory].reverse().find(c => c.sender === "agent");
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

    // Only play sound if this is a new move arriving after initialization
    if (initialized && lastMove && (!prevMove || prevMove.actionId !== lastMove.actionId)) {
      playStoneSound();
    }
    initialized = true;

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
      statusText.textContent =
        "⚠ 落子被拒绝：" + (data.payload?.error || "非法落子") + " 正在恢复服务器棋面...";
      // The gomoku board applies an optimistic local update on click; ask the
      // host for the authoritative state so the stone is removed again.
      window.parent.postMessage({ type: "REQUEST_SYNC" }, "*");
    } else if (data.type === "AGENT_STALLED") {
      const isStalled = Boolean(data.payload?.stalled);
      if (isStalled && turn === agentSide && status === "playing") {
        if (retryAgentBtn) retryAgentBtn.style.display = "inline-block";
        statusText.textContent = "AI 回复结束但未落子，请点击【重试】";
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
      statusText.textContent = "已向 AI 重新发送落子请求...";
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
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", () => {
    hoverCoord = null;
    drawBoard();
  });

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
    const cardHeight = 880;
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
    const aura = sCtx.createRadialGradient(cardWidth / 2, 220, 10, cardWidth / 2, 220, 360);
    aura.addColorStop(0, "rgba(59, 130, 246, 0.15)");
    aura.addColorStop(1, "rgba(0, 0, 0, 0)");
    sCtx.fillStyle = aura;
    sCtx.fillRect(0, 0, cardWidth, cardHeight);
    sCtx.restore();

    // 2. Card Header
    sCtx.font = "bold 20px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    sCtx.fillStyle = "#38bdf8";
    sCtx.fillText("FreeBuddy 对战大厅", 40, 52);

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    sCtx.font = "14px -apple-system, sans-serif";
    sCtx.fillStyle = "#94a3b8";
    sCtx.textAlign = "right";
    sCtx.fillText(dateStr, cardWidth - 40, 52);
    sCtx.textAlign = "left";

    // 3. Match Title & Status Badge
    sCtx.font = "bold 28px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    sCtx.fillStyle = "#ffffff";
    sCtx.fillText("五子棋 · 赛后复盘战报", 40, 98);

    // Outcome Badge
    let outcomeText = "对局进行中";
    let badgeColor = "#3b82f6";
    if (status === "player_won") {
      outcomeText = "🏆 玩家胜出 (五连珠)";
      badgeColor = "#10b981";
    } else if (status === "agent_won") {
      outcomeText = "🤖 AI Agent 获胜";
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
    const playerStone = playerSide === 1 ? "⚫" : "⚪";
    const agentStone = agentSide === 1 ? "⚫" : "⚪";
    sCtx.fillText(`${playerStone} 玩家 (${playerSide === 1 ? "黑" : "白"})  VS  ${agentStone} ${agentDisplay} (${agentSide === 1 ? "黑" : "白"})`, cardWidth - 40, 138);
    sCtx.textAlign = "left";

    // 4. Draw Chessboard
    const boardSize = 580;
    const boardX = (cardWidth - boardSize) / 2;
    const boardY = 175;

    sCtx.save();
    sCtx.shadowColor = "rgba(0, 0, 0, 0.6)";
    sCtx.shadowBlur = 24;
    sCtx.shadowOffsetY = 12;
    sCtx.drawImage(canvas, boardX, boardY, boardSize, boardSize);
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
      link.download = `FreeBuddy_五子棋战报_${timestamp}.png`;
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
