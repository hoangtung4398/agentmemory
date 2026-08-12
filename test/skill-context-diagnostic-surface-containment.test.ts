import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAllTools } from "../src/mcp/tools-registry.js";

const ROOT = join(import.meta.dirname, "..");
const DIAGNOSTIC_IDS = [
  "mem::skill-recall-explain",
  "mem::skill-recall-diagnostics",
  "mem::skill-context-explain",
  "mem::skill-context-admission-explain",
  "mem::skill-context-runtime-explain",
  "mem::skill-context-parity-diagnostics",
  "mem::skill-context-parity-stability-diagnostics",
  "mem::skill-context-parity-drift-attribution-diagnostics",
  "mem::skill-context-parity-drift-scope-diagnostics",
  "mem::skill-context-parity-drift-shape-diagnostics",
  "mem::skill-context-parity-drift-signature-diagnostics",
  "mem::skill-context-parity-drift-signature-stability-diagnostics",
  "mem::skill-context-parity-drift-signature-transition-diagnostics",
  "mem::skill-context-parity-drift-signature-transition-stability-diagnostics",
] as const;

function pathFromRoot(...parts: string[]): string {
  return join(ROOT, ...parts);
}

function readRequiredFile(...parts: string[]): string {
  const path = pathFromRoot(...parts);
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).isFile(), path).toBe(true);
  return readFileSync(path, "utf8");
}

function readRequiredFiles(directoryParts: string[], extensions: string[], recursive = true): Map<string, string> {
  const directory = pathFromRoot(...directoryParts);
  expect(existsSync(directory), directory).toBe(true);
  expect(statSync(directory).isDirectory(), directory).toBe(true);

  const files = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        visit(path);
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.set(path, readFileSync(path, "utf8"));
      }
    }
  };

  visit(directory);
  expect(files.size, directory).toBeGreaterThan(0);
  return files;
}

function slug(id: string): string {
  return id.slice("mem::".length);
}

function mcpAlias(id: string): string {
  return `memory_${slug(id).replaceAll("-", "_")}`;
}

function expectAbsent(text: string, values: readonly string[], surface: string): void {
  for (const value of values) expect(text, `${surface}: ${value}`).not.toContain(value);
}

describe("skill context diagnostic public-surface containment", () => {
  it("defines the closed unique Phase 5A-5N internal-ID manifest", () => {
    expect(DIAGNOSTIC_IDS).toHaveLength(14);
    expect(new Set(DIAGNOSTIC_IDS).size).toBe(14);
    expect(DIAGNOSTIC_IDS).toEqual([
      "mem::skill-recall-explain",
      "mem::skill-recall-diagnostics",
      "mem::skill-context-explain",
      "mem::skill-context-admission-explain",
      "mem::skill-context-runtime-explain",
      "mem::skill-context-parity-diagnostics",
      "mem::skill-context-parity-stability-diagnostics",
      "mem::skill-context-parity-drift-attribution-diagnostics",
      "mem::skill-context-parity-drift-scope-diagnostics",
      "mem::skill-context-parity-drift-shape-diagnostics",
      "mem::skill-context-parity-drift-signature-diagnostics",
      "mem::skill-context-parity-drift-signature-stability-diagnostics",
      "mem::skill-context-parity-drift-signature-transition-diagnostics",
      "mem::skill-context-parity-drift-signature-transition-stability-diagnostics",
    ]);
  });

  it("keeps every closed diagnostic identity out of REST", () => {
    const api = readRequiredFile("src", "triggers", "api.ts");
    expectAbsent(api, DIAGNOSTIC_IDS.flatMap((id) => [id, slug(id)]), "src/triggers/api.ts");
  });

  it("keeps every closed diagnostic identity out of MCP", () => {
    const mcpFiles = readRequiredFiles(["src", "mcp"], [".ts"], false);
    const forbidden = DIAGNOSTIC_IDS.flatMap((id) => [id, slug(id), mcpAlias(id)]);
    for (const [path, content] of mcpFiles) expectAbsent(content, forbidden, path);
    expect(getAllTools()).toHaveLength(60);
    for (const id of DIAGNOSTIC_IDS) expect(getAllTools().map((tool) => tool.name)).not.toContain(mcpAlias(id));
  });

  it("keeps every closed diagnostic identity out of CLI, hooks, and viewer", () => {
    const forbidden = DIAGNOSTIC_IDS.flatMap((id) => [id, slug(id), mcpAlias(id)]);
    const surfaces = new Map<string, string>([
      [pathFromRoot("src", "cli.ts"), readRequiredFile("src", "cli.ts")],
      ...readRequiredFiles(["src", "cli"], [".ts"]),
      ...readRequiredFiles(["plugin", "hooks"], [".json"]),
      ...readRequiredFiles(["src", "viewer"], [".ts", ".html"]),
    ]);
    for (const [path, content] of surfaces) expectAbsent(content, forbidden, path);
  });

  it("keeps the public inventory declarations frozen", () => {
    expect(getAllTools()).toHaveLength(60);
    const skillDirectory = pathFromRoot("plugin", "skills");
    expect(existsSync(skillDirectory), skillDirectory).toBe(true);
    expect(statSync(skillDirectory).isDirectory(), skillDirectory).toBe(true);
    const skillCount = readdirSync(skillDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "_shared").length;
    expect(skillCount).toBe(15);

    const restDeclarations = [...readRequiredFile("src", "index.ts").matchAll(
      /`REST API: (\d+) endpoints at http:\/\/localhost:\$\{config\.restPort\}\/agentmemory\/\*`/g,
    )];
    expect(restDeclarations).toHaveLength(1);
    expect(restDeclarations[0][1]).toBe("135");
  });
});
