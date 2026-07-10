export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

export function extractSemver(value: string | undefined): Semver | undefined {
  if (!value) return undefined;
  const match = value.match(
    /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:$|[^0-9A-Za-z.-])/
  );
  if (!match) return undefined;
  const raw = `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
    raw
  };
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return Math.sign(leftNumber - rightNumber);
  }
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

export function compareSemver(left: Semver, right: Semver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const diff = comparePrereleasePart(left.prerelease[i], right.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
