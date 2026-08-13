import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Diagnostic = {
  phase: string;
  file: string;
  gate: "recallEnabled" | "contextEnabled";
};

const ROOT = join(import.meta.dirname, "..");
const FUNCTIONS = join(ROOT, "src", "functions");
const diagnostics: Diagnostic[] = [
  { phase: "5A", file: "skill-recall-explain.ts", gate: "recallEnabled" },
  { phase: "5B", file: "skill-recall-diagnostics.ts", gate: "recallEnabled" },
  { phase: "5C", file: "skill-context-explain.ts", gate: "contextEnabled" },
  { phase: "5D", file: "skill-context-admission.ts", gate: "contextEnabled" },
  { phase: "5E", file: "skill-context-runtime.ts", gate: "contextEnabled" },
  { phase: "5F", file: "skill-context-parity.ts", gate: "contextEnabled" },
  { phase: "5G", file: "skill-context-parity-stability.ts", gate: "contextEnabled" },
  { phase: "5H", file: "skill-context-parity-drift-attribution.ts", gate: "contextEnabled" },
  { phase: "5I", file: "skill-context-parity-drift-scope.ts", gate: "contextEnabled" },
  { phase: "5J", file: "skill-context-parity-drift-shape.ts", gate: "contextEnabled" },
  { phase: "5K", file: "skill-context-parity-drift-signature.ts", gate: "contextEnabled" },
  { phase: "5L", file: "skill-context-parity-drift-signature-stability.ts", gate: "contextEnabled" },
  { phase: "5M", file: "skill-context-parity-drift-signature-transition.ts", gate: "contextEnabled" },
  { phase: "5N", file: "skill-context-parity-drift-signature-transition-stability.ts", gate: "contextEnabled" },
];

function source(file: string): string {
  const path = join(FUNCTIONS, file);
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).isFile(), path).toBe(true);
  return readFileSync(path, "utf8");
}

function matches(value: string, pattern: RegExp): RegExpMatchArray[] {
  return [...value.matchAll(pattern)];
}

describe("skill context diagnostic default-off enablement boundary", () => {
  it("has the closed A-N enablement gate manifest", () => {
    expect(diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    expect(diagnostics).toHaveLength(14);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.file)).size).toBe(14);
    expect(diagnostics.filter((diagnostic) => diagnostic.gate === "recallEnabled").map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B"]);
    expect(diagnostics.filter((diagnostic) => diagnostic.gate === "contextEnabled").map((diagnostic) => diagnostic.phase)).toEqual(["5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    for (const diagnostic of diagnostics) source(diagnostic.file);
  });

  it("uses only the centralized skill configuration loader", () => {
    for (const diagnostic of diagnostics) {
      const value = source(diagnostic.file);
      expect(matches(value, /import\s+\{\s*loadSkillConfig\s*\}\s+from\s+["']\.\.\/config\.js["']/g), diagnostic.phase).toHaveLength(1);
      expect(matches(value, /from\s+["']\.\.\/config\.js["']/g), diagnostic.phase).toHaveLength(1);
      expect(matches(value, /loadSkillConfig\s*\(/g), diagnostic.phase).toHaveLength(1);
      expect(matches(value, /\b(?:load[A-Za-z_$][\w$]*Config|getEnvVar)\s*\(/g).map((match) => match[0]), diagnostic.phase).toEqual(["loadSkillConfig("]);
      expect(value, diagnostic.phase).not.toMatch(/\bprocess\.env\b|\bimport\.meta\.env\b|AGENTMEMORY_[A-Z0-9_]+/);
    }
  });

  it("uses exactly its authorized boolean enablement gate", () => {
    for (const diagnostic of diagnostics) {
      const value = source(diagnostic.file);
      const properties = matches(value, /(?:config|loadSkillConfig\(\))\.([A-Za-z_$][\w$]*Enabled)\b/g)
        .map((match) => match[1]);
      expect(properties, diagnostic.phase).toEqual([diagnostic.gate]);
      const guard = new RegExp(`if\\s*\\(\\s*!\\s*(?:config\\.${diagnostic.gate}|loadSkillConfig\\(\\)\\.${diagnostic.gate})\\s*\\)`);
      expect(matches(value, new RegExp(guard.source, "g")), diagnostic.phase).toHaveLength(1);
      const guardedProperties = matches(
        value,
        /if\s*\(\s*!\s*(?:(?:[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\(\))\s*\.\s*)?([A-Za-z_$][\w$]*Enabled)\b/g,
      ).map((match) => match[1]);
      expect(guardedProperties, diagnostic.phase).toEqual([diagnostic.gate]);
    }
  });

  it("places the disabled gate before direct diagnostic work", () => {
    for (const diagnostic of diagnostics) {
      const value = source(diagnostic.file);
      const registration = value.indexOf("sdk.registerFunction");
      const gate = value.search(new RegExp(`if\\s*\\(\\s*!\\s*(?:config\\.${diagnostic.gate}|loadSkillConfig\\(\\)\\.${diagnostic.gate})\\s*\\)`));
      const work = [value.search(/\bkv\.[A-Za-z_$][\w$]*(?:\s*<[^>]*>)?\s*\(/), value.search(/\bsdk\.trigger\s*\(/)]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      expect(matches(value, /sdk\.registerFunction\s*\(/g), diagnostic.phase).toHaveLength(1);
      expect(registration, diagnostic.phase).toBeGreaterThanOrEqual(0);
      expect(gate, diagnostic.phase).toBeGreaterThan(registration);
      expect(work, diagnostic.phase).toBeGreaterThan(gate);
    }
  });

  it("keeps the central skill, recall, and context chain default-off", () => {
    const config = readFileSync(join(ROOT, "src", "config.ts"), "utf8");
    expect(config).toMatch(/const\s+enabled\s*=\s*parseBooleanEnv\(\s*env\[["']AGENTMEMORY_SKILLS["']\]\s*,\s*false\s*,?\s*\)/);
    expect(config).toMatch(/const\s+recallEnabled\s*=\s*enabled\s*&&\s*parseBooleanEnv\(\s*env\[["']AGENTMEMORY_SKILL_RECALL["']\]\s*,\s*false\s*,?\s*\)/);
    expect(config).toMatch(/const\s+contextEnabled\s*=\s*recallEnabled\s*&&\s*parseBooleanEnv\(\s*env\[["']AGENTMEMORY_SKILL_CONTEXT["']\]\s*,\s*false\s*,?\s*\)/);
    expect(matches(config, /\brecallEnabled\s*,/g)).toHaveLength(1);
    expect(matches(config, /\bcontextEnabled\s*,/g)).toHaveLength(1);
  });
});
