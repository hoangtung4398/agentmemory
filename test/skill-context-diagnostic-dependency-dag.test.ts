import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Diagnostic = {
  phase: string;
  file: string;
  ownId: string;
  downstream: string[];
  triggerCalls: number;
  registration: string;
};

const diagnostics: Diagnostic[] = [
  { phase: "5A", file: "skill-recall-explain.ts", ownId: "mem::skill-recall-explain", downstream: [], triggerCalls: 0, registration: "registerSkillRecallExplainFunction(sdk, kv);" },
  { phase: "5B", file: "skill-recall-diagnostics.ts", ownId: "mem::skill-recall-diagnostics", downstream: [], triggerCalls: 0, registration: "registerSkillRecallDiagnosticsFunction(sdk, kv);" },
  { phase: "5C", file: "skill-context-explain.ts", ownId: "mem::skill-context-explain", downstream: [], triggerCalls: 0, registration: "registerSkillContextExplainFunction(sdk, kv);" },
  { phase: "5D", file: "skill-context-admission.ts", ownId: "mem::skill-context-admission-explain", downstream: [], triggerCalls: 0, registration: "registerSkillContextAdmissionExplainFunction(sdk, kv);" },
  { phase: "5E", file: "skill-context-runtime.ts", ownId: "mem::skill-context-runtime-explain", downstream: ["mem::skill-recall"], triggerCalls: 1, registration: "registerSkillContextRuntimeExplainFunction(sdk);" },
  { phase: "5F", file: "skill-context-parity.ts", ownId: "mem::skill-context-parity-diagnostics", downstream: ["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"], triggerCalls: 2, registration: "registerSkillContextParityDiagnosticsFunction(sdk);" },
  { phase: "5G", file: "skill-context-parity-stability.ts", ownId: "mem::skill-context-parity-stability-diagnostics", downstream: ["mem::skill-context-parity-diagnostics"], triggerCalls: 2, registration: "registerSkillContextParityStabilityDiagnosticsFunction(sdk);" },
  { phase: "5H", file: "skill-context-parity-drift-attribution.ts", ownId: "mem::skill-context-parity-drift-attribution-diagnostics", downstream: ["mem::skill-context-parity-stability-diagnostics"], triggerCalls: 1, registration: "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk);" },
  { phase: "5I", file: "skill-context-parity-drift-scope.ts", ownId: "mem::skill-context-parity-drift-scope-diagnostics", downstream: ["mem::skill-context-parity-drift-attribution-diagnostics"], triggerCalls: 1, registration: "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk);" },
  { phase: "5J", file: "skill-context-parity-drift-shape.ts", ownId: "mem::skill-context-parity-drift-shape-diagnostics", downstream: ["mem::skill-context-parity-drift-scope-diagnostics"], triggerCalls: 1, registration: "registerSkillContextParityDriftShapeDiagnosticsFunction(sdk);" },
  { phase: "5K", file: "skill-context-parity-drift-signature.ts", ownId: "mem::skill-context-parity-drift-signature-diagnostics", downstream: ["mem::skill-context-parity-drift-shape-diagnostics"], triggerCalls: 1, registration: "registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk);" },
  { phase: "5L", file: "skill-context-parity-drift-signature-stability.ts", ownId: "mem::skill-context-parity-drift-signature-stability-diagnostics", downstream: ["mem::skill-context-parity-drift-signature-diagnostics"], triggerCalls: 2, registration: "registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(sdk);" },
  { phase: "5M", file: "skill-context-parity-drift-signature-transition.ts", ownId: "mem::skill-context-parity-drift-signature-transition-diagnostics", downstream: ["mem::skill-context-parity-drift-signature-diagnostics"], triggerCalls: 2, registration: "registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(sdk);" },
  { phase: "5N", file: "skill-context-parity-drift-signature-transition-stability.ts", ownId: "mem::skill-context-parity-drift-signature-transition-stability-diagnostics", downstream: ["mem::skill-context-parity-drift-signature-transition-diagnostics"], triggerCalls: 2, registration: "registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction(sdk);" },
];

function source(file: string): string {
  return readFileSync(new URL(`../src/functions/${file}`, import.meta.url), "utf8");
}

function memIds(value: string): string[] {
  return [...value.matchAll(/"(mem::[a-z0-9:-]+)"/g)].map((match) => match[1]);
}

describe("skill context diagnostic dependency DAG", () => {
  it("has the canonical Phase 5A-5N source and registered-ID membership", () => {
    expect(diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N"]);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.ownId)).size).toBe(diagnostics.length);
    for (const diagnostic of diagnostics) {
      const file = new URL(`../src/functions/${diagnostic.file}`, import.meta.url);
      expect(existsSync(file), diagnostic.file).toBe(true);
      expect(source(diagnostic.file), diagnostic.file).toMatch(
        new RegExp(`sdk\\.registerFunction\\s*\\(\\s*"${diagnostic.ownId}"`),
      );
    }
  });

  it("has exactly the allowed direct downstream identifiers", () => {
    for (const diagnostic of diagnostics) {
      const downstream = new Set(memIds(source(diagnostic.file)));
      downstream.delete(diagnostic.ownId);
      expect([...downstream].sort(), diagnostic.phase).toEqual([...diagnostic.downstream].sort());
    }
  });

  it("locks direct sdk.trigger call-site counts", () => {
    for (const diagnostic of diagnostics) {
      const count = source(diagnostic.file).match(/\bsdk\.trigger\s*\(/g)?.length ?? 0;
      expect(count, diagnostic.phase).toBe(diagnostic.triggerCalls);
    }
  });

  it("forms an acyclic downward graph with one external recall leaf", () => {
    const byId = new Map(diagnostics.map((diagnostic, index) => [diagnostic.ownId, { diagnostic, index }]));
    const graph = new Map<string, string[]>();
    const externalEdges: string[] = [];

    for (const diagnostic of diagnostics) {
      const internal = diagnostic.downstream.filter((target) => byId.has(target));
      graph.set(diagnostic.ownId, internal);
      for (const target of diagnostic.downstream) {
        const targetNode = byId.get(target);
        if (!targetNode) {
          externalEdges.push(`${diagnostic.phase}->${target}`);
          continue;
        }
        expect(target, diagnostic.phase).not.toBe(diagnostic.ownId);
        expect(targetNode.index, `${diagnostic.phase}->${targetNode.diagnostic.phase}`).toBeLessThan(byId.get(diagnostic.ownId)!.index);
      }
    }

    expect(externalEdges).toEqual(["5E->mem::skill-recall"]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string): void => {
      expect(visiting.has(node), `cycle at ${node}`).toBe(false);
      if (visited.has(node)) return;
      visiting.add(node);
      for (const target of graph.get(node) ?? []) visit(target);
      visiting.delete(node);
      visited.add(node);
    };
    for (const diagnostic of diagnostics) visit(diagnostic.ownId);
    expect(visited.size).toBe(diagnostics.length);
  });

  it("registers the completed diagnostic sequence in A-to-N order", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const first = index.indexOf(diagnostics[0].registration);
    const feedback = index.indexOf("registerSkillFeedbackFunction(sdk, kv);");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(feedback).toBeGreaterThan(first);
    const block = index.slice(first, feedback);
    const registrations = [...block.matchAll(/registerSkill[A-Za-z]+Function\(sdk(?:, kv)?\);/g)].map((match) => match[0]);
    expect(registrations).toEqual(diagnostics.map((diagnostic) => diagnostic.registration));
  });
});
