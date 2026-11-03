const OUTPUT_LIMIT = 16 * 1024;

export async function withTemporaryDirectory(fs, path, os, prefix, work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await work(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export function waitFor(predicate, timeoutMs = 15_000, description = "condition") {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(interval);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${description}`)), timeoutMs);
    const interval = setInterval(() => {
      try { if (predicate()) finish(); } catch (error) { finish(error); }
    }, 25);
  });
}

export function nextFrame(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, frame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener("message", onMessage);
      error ? reject(error) : resolve(frame);
    };
    const onMessage = value => {
      try { finish(undefined, JSON.parse(value.toString())); } catch (error) { finish(error); }
    };
    const timeout = setTimeout(() => finish(new Error("timed out waiting for relay frame")), timeoutMs);
    socket.once("message", onMessage);
  });
}

export function createBoundedRedactedOutput(secrets = [], limit = OUTPUT_LIMIT) {
  let value = "";
  const redact = text => secrets.reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, text);
  return {
    append(chunk) {
      value = `${value}${redact(String(chunk))}`;
      if (value.length > limit) value = `[output truncated]\n${value.slice(-limit)}`;
    },
    read() { return value; }
  };
}

export function childExited(child) { return child.exitCode !== null || child.signalCode !== null; }

export function describeChildExit(child) {
  if (!child) return "was not started";
  if (child.signalCode) return `was terminated by ${child.signalCode}`;
  if (typeof child.exitCode === "number") return `exited with code ${child.exitCode}`;
  return "is still running";
}

/**
 * Wait for a child-backed HTTP endpoint to be ready, failing early if its
 * process exits.  A successful spawn or startup log is not sufficient: the
 * caller must not open a dependent WebSocket until the listener is accepting
 * requests.
 */
export async function waitForHttpOk(url, child, { timeoutMs = 10_000, intervalMs = 50, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "endpoint was not probed";
  while (Date.now() <= deadline) {
    if (childExited(child)) throw new Error(`child ${describeChildExit(child)} before ${url} became ready (${lastProblem})`);
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))) });
      await response.arrayBuffer();
      if (response.ok) return;
      lastProblem = `received HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : "request failed";
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  if (childExited(child)) throw new Error(`child ${describeChildExit(child)} before ${url} became ready (${lastProblem})`);
  throw new Error(`timed out waiting for ${url} to become ready (${lastProblem})`);
}

export async function waitForExit(child, timeoutMs) {
  if (childExited(child)) return true;
  return new Promise(resolve => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const finish = result => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    child.once("exit", onExit);
  });
}

/** Stop only the child supplied by this test and wait for its actual exit. */
export async function stopChild(child, { stdinValue, gracefulMs = 3_000, termMs = 3_000, killMs = 3_000 } = {}) {
  if (!child || childExited(child)) return;
  if (stdinValue && child.stdin && !child.stdin.destroyed) {
    try { child.stdin.write(`${JSON.stringify(stdinValue)}\n`); } catch { /* Escalate to signals below. */ }
  }
  if (await waitForExit(child, gracefulMs)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, termMs)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, killMs)) throw new Error("test child did not exit after SIGKILL");
}
