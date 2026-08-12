import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Diagnostic = {
  phase: string;
  file: string;
  registration: string;
  stateReader: boolean;
};

const ROOT = join(import.meta.dirname, "..");
const FUNCTIONS = join(ROOT, "src", "functions");
const diagnostics: Diagnostic[] = [
  { phase: "5A", file: "skill-recall-explain.ts", registration: "registerSkillRecallExplainFunction", stateReader: true },
  { phase: "5B", file: "skill-recall-diagnostics.ts", registration: "registerSkillRecallDiagnosticsFunction", stateReader: true },
  { phase: "5C", file: "skill-context-explain.ts", registration: "registerSkillContextExplainFunction", stateReader: true },
  { phase: "5D", file: "skill-context-admission.ts", registration: "registerSkillContextAdmissionExplainFunction", stateReader: true },
  { phase: "5E", file: "skill-context-runtime.ts", registration: "registerSkillContextRuntimeExplainFunction", stateReader: false },
  { phase: "5F", file: "skill-context-parity.ts", registration: "registerSkillContextParityDiagnosticsFunction", stateReader: false },
  { phase: "5G", file: "skill-context-parity-stability.ts", registration: "registerSkillContextParityStabilityDiagnosticsFunction", stateReader: false },
  { phase: "5H", file: "skill-context-parity-drift-attribution.ts", registration: "registerSkillContextParityDriftAttributionDiagnosticsFunction", stateReader: false },
  { phase: "5I", file: "skill-context-parity-drift-scope.ts", registration: "registerSkillContextParityDriftScopeDiagnosticsFunction", stateReader: false },
  { phase: "5J", file: "skill-context-parity-drift-shape.ts", registration: "registerSkillContextParityDriftShapeDiagnosticsFunction", stateReader: false },
  { phase: "5K", file: "skill-context-parity-drift-signature.ts", registration: "registerSkillContextParityDriftSignatureDiagnosticsFunction", stateReader: false },
  { phase: "5L", file: "skill-context-parity-drift-signature-stability.ts", registration: "registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction", stateReader: false },
  { phase: "5M", file: "skill-context-parity-drift-signature-transition.ts", registration: "registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction", stateReader: false },
  { phase: "5N", file: "skill-context-parity-drift-signature-transition-stability.ts", registration: "registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction", stateReader: false },
];

function sourcePath(file: string): string {
  return join(FUNCTIONS, file);
}

function source(file: string): string {
  const path = sourcePath(file);
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).isFile(), path).toBe(true);
  return readFileSync(path, "utf8");
}

function stateImports(value: string): string[] {
  return [...value.matchAll(/from\s+["'](\.\.\/state\/[^"']+)["']/g)].map((match) => match[1]);
}

function kvMethods(value: string): string[] {
  return [...value.matchAll(/\bkv\.([A-Za-z_$][\w$]*)(?:\s*<[^>]*>)?\s*\(/g)].map((match) => match[1]);
}

function kvScopes(value: string): string[] {
  return [...value.matchAll(/\bKV\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

describe("skill context diagnostic read-only state boundary", () => {
  it("has the canonical A-N state-access manifest", () => {
    expect(diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    expect(diagnostics).toHaveLength(14);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.file)).size).toBe(14);
    expect(diagnostics.filter((diagnostic) => diagnostic.stateReader).map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B", "5C", "5D"]);
    expect(diagnostics.filter((diagnostic) => !diagnostic.stateReader).map((diagnostic) => diagnostic.phase)).toEqual(["5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    for (const diagnostic of diagnostics) source(diagnostic.file);
  });

  it("keeps direct state imports limited to the four readers", () => {
    for (const diagnostic of diagnostics) {
      const imports = stateImports(source(diagnostic.file));
      expect(imports, diagnostic.phase).toEqual(
        diagnostic.stateReader ? ["../state/schema.js", "../state/kv.js"] : [],
      );
    }
  });

  it("allows only one direct read-only kv.list operation on each reader", () => {
    for (const diagnostic of diagnostics) {
      const methods = kvMethods(source(diagnostic.file));
      expect(methods, diagnostic.phase).toEqual(diagnostic.stateReader ? ["list"] : []);
    }
  });

  it("contains direct storage access to one KV.skills list and no state triggers", () => {
    for (const diagnostic of diagnostics) {
      const value = source(diagnostic.file);
      expect(kvScopes(value), diagnostic.phase).toEqual(diagnostic.stateReader ? ["skills"] : []);
      expect(value.match(/\bkv\.list(?:\s*<[^>]*>)?\s*\(\s*KV\.skills\s*\)/g) ?? [], diagnostic.phase).toHaveLength(
        diagnostic.stateReader ? 1 : 0,
      );
      expect(value, diagnostic.phase).not.toMatch(/state::[A-Za-z0-9:_-]+/);
    }
  });

  it("injects the state capability only into the four reader registrations", () => {
    const index = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    for (const diagnostic of diagnostics) {
      const value = source(diagnostic.file);
      const signature = new RegExp(
        `export\\s+function\\s+${diagnostic.registration}\\s*\\(\\s*sdk\\s*:\\s*ISdk${diagnostic.stateReader ? "\\s*,\\s*kv\\s*:\\s*StateKV" : ""}\\s*\\)`,
      );
      expect(value, diagnostic.phase).toMatch(signature);
      const call = `${diagnostic.registration}(sdk${diagnostic.stateReader ? ", kv" : ""});`;
      expect(index, diagnostic.phase).toContain(call);
      expect(index, diagnostic.phase).not.toContain(
        `${diagnostic.registration}(sdk${diagnostic.stateReader ? "" : ", kv"});`,
      );
    }
  });
});
