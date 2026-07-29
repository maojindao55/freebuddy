import fs from "node:fs";
import path from "node:path";

import type { SkillSnapshot } from "./skillTypes.js";

export function buildSkillAnnouncement(
  prompt: string,
  skills: readonly SkillSnapshot[]
): string {
  if (skills.length === 0) return prompt;
  const catalog = skills
    .map((skill) => `- ${skill.name} (${skill.version}): ${skill.description}`)
    .join("\n");
  return `[FreeBuddy active skills]\n${catalog}\n\nUse the skill_list and skill_load tools to read the selected skill instructions before applying them. Use skill_read_resource for files referenced by SKILL.md. Native skill discovery may also expose the same skills.\n\n${prompt}`;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isRegisteredSkillPath(
  value: string,
  registeredRoots: readonly string[]
): boolean {
  const canonical = canonicalPath(value);
  return registeredRoots.some((root) => isInside(root, canonical));
}

export function reconcileNativeSkillLinks(
  cwd: string,
  nativeDirs: readonly string[],
  selected: readonly SkillSnapshot[],
  registeredRoots: readonly string[]
): void {
  const canonicalRegisteredRoots = registeredRoots.map(canonicalPath);
  for (const relativeDir of nativeDirs) {
    const directory = path.resolve(cwd, relativeDir);
    if (!isInside(cwd, directory)) continue;
    fs.mkdirSync(directory, { recursive: true });
    const desired = new Set(selected.map((skill) => skill.name));
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() || desired.has(entry.name)) continue;
      const link = path.join(directory, entry.name);
      try {
        const target = fs.realpathSync(link);
        if (isRegisteredSkillPath(target, canonicalRegisteredRoots)) {
          fs.unlinkSync(link);
        }
      } catch {
        // Leave links that FreeBuddy cannot prove it owns.
      }
    }
    for (const skill of selected) {
      const target = path.join(directory, skill.name);
      let shouldCreate = true;
      try {
        const existing = fs.lstatSync(target);
        if (!existing.isSymbolicLink()) {
          shouldCreate = false;
        } else {
          const currentRoot = fs.realpathSync(target);
          const desiredRoot = canonicalPath(skill.rootPath);
          if (canonicalPath(currentRoot) === desiredRoot) {
            shouldCreate = false;
          } else if (
            isRegisteredSkillPath(currentRoot, canonicalRegisteredRoots) &&
            isRegisteredSkillPath(desiredRoot, canonicalRegisteredRoots)
          ) {
            fs.unlinkSync(target);
          } else {
            shouldCreate = false;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          shouldCreate = false;
        }
      }
      if (!shouldCreate) continue;
      try {
        fs.symlinkSync(
          skill.rootPath,
          target,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch (error) {
        console.warn(`[skills] could not mount ${skill.name} in ${relativeDir}:`, error);
      }
    }
  }
}
