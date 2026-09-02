import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walks up until the frozen protocol directory is found (works from src and .tmp-test). */
function findRepoRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "protocol", "remote", "v1"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`protocol/remote/v1 not found above ${start}; run tests from the monorepo`);
}

export const REPO_ROOT = findRepoRoot(__dirname);

export const PROTOCOL_DIR = join(REPO_ROOT, "protocol", "remote", "v1");
