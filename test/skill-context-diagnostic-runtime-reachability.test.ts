import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type Diagnostic = {
  phase: string;
  id: string;
  owner: string;
  callers: string[];
};

const ROOT = join(import.meta.dirname, "..");
const FUNCTIONS = join(ROOT, "src", "functions");
const diagnostics: Diagnostic[] = [
  { phase: "5A", id: "mem::skill-recall-explain", owner: "skill-recall-explain.ts", callers: [] },
  { phase: "5B", id: "mem::skill-recall-diagnostics", owner: "skill-recall-diagnostics.ts", callers: [] },
  { phase: "5C", id: "mem::skill-context-explain", owner: "skill-context-explain.ts", callers: [] },
  { phase: "5D", id: "mem::skill-context-admission-explain", owner: "skill-context-admission.ts", callers: ["skill-context-parity.ts"] },
  { phase: "5E", id: "mem::skill-context-runtime-explain", owner: "skill-context-runtime.ts", callers: ["skill-context-parity.ts"] },
  { phase: "5F", id: "mem::skill-context-parity-diagnostics", owner: "skill-context-parity.ts", callers: ["skill-context-parity-stability.ts"] },
  { phase: "5G", id: "mem::skill-context-parity-stability-diagnostics", owner: "skill-context-parity-stability.ts", callers: ["skill-context-parity-drift-attribution.ts"] },
  { phase: "5H", id: "mem::skill-context-parity-drift-attribution-diagnostics", owner: "skill-context-parity-drift-attribution.ts", callers: ["skill-context-parity-drift-scope.ts"] },
  { phase: "5I", id: "mem::skill-context-parity-drift-scope-diagnostics", owner: "skill-context-parity-drift-scope.ts", callers: ["skill-context-parity-drift-shape.ts"] },
  { phase: "5J", id: "mem::skill-context-parity-drift-shape-diagnostics", owner: "skill-context-parity-drift-shape.ts", callers: ["skill-context-parity-drift-signature.ts"] },
  { phase: "5K", id: "mem::skill-context-parity-drift-signature-diagnostics", owner: "skill-context-parity-drift-signature.ts", callers: ["skill-context-parity-drift-signature-stability.ts", "skill-context-parity-drift-signature-transition.ts"] },
  { phase: "5L", id: "mem::skill-context-parity-drift-signature-stability-diagnostics", owner: "skill-context-parity-drift-signature-stability.ts", callers: [] },
  { phase: "5M", id: "mem::skill-context-parity-drift-signature-transition-diagnostics", owner: "skill-context-parity-drift-signature-transition.ts", callers: ["skill-context-parity-drift-signature-transition-stability.ts"] },
  { phase: "5N", id: "mem::skill-context-parity-drift-signature-transition-stability-diagnostics", owner: "skill-context-parity-drift-signature-transition-stability.ts", callers: [] },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourcePath(file: string): string {
  return join(FUNCTIONS, file);
}

function readRequiredSource(file: string): string {
  const path = sourcePath(file);
  expect(existsSync(path), path).toBe(true);
  expect(statSync(path).isFile(), path).toBe(true);
  return readFileSync(path, "utf8");
}

function readTypeScriptFiles(directory: string): Map<string, string> {
  expect(existsSync(directory), directory).toBe(true);
  expect(statSync(directory).isDirectory(), directory).toBe(true);
  const sources = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) sources.set(relative(ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
    }
  };
  visit(directory);
  expect(sources.size, directory).toBeGreaterThan(0);
  return sources;
}

function registrationPattern(id: string): RegExp {
  return new RegExp(`sdk\\.registerFunction\\s*\\(\\s*["']${escapeRegExp(id)}["']`, "g");
}

function sourceReferences(source: string, id: string): number {
  return source.split(id).length - 1;
}

describe("skill context diagnostic runtime reachability containment", () => {
  it("has the canonical unique Phase 5A-5N inbound manifest", () => {
    expect(diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    expect(diagnostics).toHaveLength(14);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.id)).size).toBe(14);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.owner)).size).toBe(14);

    const canonicalFiles = new Set(diagnostics.map((diagnostic) => diagnostic.owner));
    for (const diagnostic of diagnostics) {
      readRequiredSource(diagnostic.owner);
      for (const caller of diagnostic.callers) {
        expect(canonicalFiles.has(caller), `${diagnostic.phase}: ${caller}`).toBe(true);
        readRequiredSource(caller);
      }
    }
  });

  it("has exactly the approved production reference inventory", () => {
    const sources = readTypeScriptFiles(join(ROOT, "src"));
    for (const diagnostic of diagnostics) {
      const observed = [...sources]
        .filter(([, source]) => source.includes(diagnostic.id))
        .map(([path]) => path)
        .sort();
      const expected = [`src/functions/${diagnostic.owner}`, ...diagnostic.callers.map((caller) => `src/functions/${caller}`)].sort();
      expect(observed, diagnostic.phase).toEqual(expected);
    }
  });

  it("uses each owner identity only for its own registration", () => {
    for (const diagnostic of diagnostics) {
      const source = readRequiredSource(diagnostic.owner);
      const pattern = registrationPattern(diagnostic.id);
      const registrations = source.match(pattern) ?? [];
      expect(registrations, diagnostic.phase).toHaveLength(1);
      const withoutRegistration = source.replace(registrationPattern(diagnostic.id), "");
      expect(sourceReferences(withoutRegistration, diagnostic.id), diagnostic.phase).toBe(0);
    }
  });

  it("uses every approved inbound identity only as an sdk trigger target", () => {
    const parity = readRequiredSource("skill-context-parity.ts");
    const admission = diagnostics.find((diagnostic) => diagnostic.phase === "5D")!;
    const runtime = diagnostics.find((diagnostic) => diagnostic.phase === "5E")!;
    const typeConstraint = new RegExp(
      `type\\s+ParityRequest\\s*=\\s*\\{\\s*function_id\\s*:\\s*["']${escapeRegExp(admission.id)}["']\\s*\\|\\s*["']${escapeRegExp(runtime.id)}["']\\s*;`,
      "g",
    );
    expect(parity.match(typeConstraint)).toHaveLength(1);

    for (const diagnostic of diagnostics) {
      const propertyPattern = new RegExp(`function_id\\s*:\\s*["']${escapeRegExp(diagnostic.id)}["']`, "g");
      for (const caller of diagnostic.callers) {
        const source = readRequiredSource(caller);
        if (caller === "skill-context-parity.ts" && (diagnostic.phase === "5D" || diagnostic.phase === "5E")) {
          const requestName = diagnostic.phase === "5D" ? "direct" : "runtime";
          const concreteTarget = new RegExp(
            `${requestName}\\s*:\\s*\\{\\s*function_id\\s*:\\s*["']${escapeRegExp(diagnostic.id)}["']`,
            "g",
          );
          expect(sourceReferences(source, diagnostic.id), `${caller} -> ${diagnostic.phase}`).toBe(2);
          expect(source.match(concreteTarget), `${caller} -> ${diagnostic.phase}`).toHaveLength(1);
          expect(source, caller).toMatch(/sdk\.trigger\s*\(/);
          continue;
        }
        const targetProperties = source.match(propertyPattern) ?? [];
        expect(targetProperties.length, `${caller} -> ${diagnostic.phase}`).toBeGreaterThan(0);
        expect(targetProperties.length, `${caller} -> ${diagnostic.phase}`).toBe(sourceReferences(source, diagnostic.id));
        expect(source, caller).toMatch(/sdk\.trigger\s*\(/);
      }
    }
  });

  it("has no production entrypoint outside the closed composition graph", () => {
    const sources = readTypeScriptFiles(join(ROOT, "src"));
    const byOwner = new Map(diagnostics.map((diagnostic) => [diagnostic.owner, diagnostic]));
    const byId = new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]));
    const observed = new Set<string>();

    for (const [path, source] of sources) {
      const file = path.replace("src/functions/", "");
      for (const [id, diagnostic] of byId) {
        let references = sourceReferences(source, id);
        if (byOwner.get(file)?.id === id) references -= (source.match(registrationPattern(id)) ?? []).length;
        if (references > 0) observed.add(`${file}->${diagnostic.phase}`);
      }
    }

    expect([...observed].sort()).toEqual([
      "skill-context-parity-drift-attribution.ts->5G",
      "skill-context-parity-drift-scope.ts->5H",
      "skill-context-parity-drift-shape.ts->5I",
      "skill-context-parity-drift-signature-stability.ts->5K",
      "skill-context-parity-drift-signature-transition-stability.ts->5M",
      "skill-context-parity-drift-signature-transition.ts->5K",
      "skill-context-parity-drift-signature.ts->5J",
      "skill-context-parity-stability.ts->5F",
      "skill-context-parity.ts->5D",
      "skill-context-parity.ts->5E",
    ]);
    for (const phase of ["5A", "5B", "5C", "5L", "5N"]) {
      expect([...observed].some((entry) => entry.endsWith(`->${phase}`)), phase).toBe(false);
    }
  });
});
