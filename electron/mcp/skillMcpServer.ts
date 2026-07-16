import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { SkillSnapshot } from "../cli/skillTypes.js";

function loadManifest(): SkillSnapshot[] {
  const manifest = process.env.FREEBUDDY_SKILL_MANIFEST?.trim();
  if (!manifest) throw new Error("FreeBuddy Skill manifest is missing");
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error("FreeBuddy Skill manifest is invalid");
  }
  return parsed.skills.filter(
    (skill: unknown): skill is SkillSnapshot =>
      Boolean(skill) &&
      typeof skill === "object" &&
      typeof (skill as SkillSnapshot).id === "string" &&
      typeof (skill as SkillSnapshot).rootPath === "string"
  );
}

function result(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function readAllowedFile(skill: SkillSnapshot, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Skill resource path must be relative");
  }
  const root = fs.realpathSync(skill.rootPath);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill resource path escapes the active skill");
  }
  const real = fs.realpathSync(candidate);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Skill resource link escapes the active skill");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
    throw new Error("Skill resource is unavailable or too large");
  }
  return fs.readFileSync(real, "utf8");
}

export function createSkillMcpServer(): McpServer {
  const skills = loadManifest();
  const byName = new Map(skills.flatMap((skill) => [
    [skill.id, skill] as const,
    [skill.name, skill] as const
  ]));
  const server = new McpServer({
    name: "freebuddy-skills",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });
  server.registerTool(
    "skill_list",
    {
      title: "List Active Skills",
      description: "List the skills selected for this FreeBuddy conversation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const catalog = skills.map(({ id, name, description, version, contentHash }) => ({
        id, name, description, version, contentHash
      }));
      return result(JSON.stringify(catalog, null, 2), { skills: catalog });
    }
  );
  server.registerTool(
    "skill_load",
    {
      title: "Load Skill Instructions",
      description: "Load the SKILL.md instructions for one active skill.",
      inputSchema: { name: z.string().trim().min(1).max(120) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ name }) => {
      const skill = byName.get(name);
      if (!skill) return { ...result(`Skill is not active: ${name}`), isError: true };
      try {
        return result(readAllowedFile(skill, "SKILL.md"), {
          skill: { id: skill.id, name: skill.name, version: skill.version, contentHash: skill.contentHash }
        });
      } catch (error) {
        return { ...result((error as Error).message), isError: true };
      }
    }
  );
  server.registerTool(
    "skill_read_resource",
    {
      title: "Read Skill Resource",
      description: "Read a text file referenced by an active SKILL.md. Paths are confined to that skill snapshot.",
      inputSchema: {
        name: z.string().trim().min(1).max(120),
        relativePath: z.string().trim().min(1).max(500)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ name, relativePath }) => {
      const skill = byName.get(name);
      if (!skill) return { ...result(`Skill is not active: ${name}`), isError: true };
      try {
        return result(readAllowedFile(skill, relativePath), {
          skill: { id: skill.id, name: skill.name },
          relativePath
        });
      } catch (error) {
        return { ...result((error as Error).message), isError: true };
      }
    }
  );
  return server;
}

export async function runSkillMcpServer(): Promise<void> {
  await createSkillMcpServer().connect(new StdioServerTransport());
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runSkillMcpServer().catch((error) => {
    console.error("[FreeBuddy Skill MCP]", error);
    process.exitCode = 1;
  });
}
