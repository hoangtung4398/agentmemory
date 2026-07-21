import type { SkillAdvisory, SkillRecallResult } from "./skill-recall.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAdvisory(value: unknown): value is SkillAdvisory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const advisory = value as Record<string, unknown>;
  return advisory.source === "skill-advisory" &&
    isNonEmptyString(advisory.skillId) &&
    isNonEmptyString(advisory.name) &&
    isNonEmptyString(advisory.triggerCondition) &&
    isStringArray(advisory.steps) && advisory.steps.length > 0 &&
    advisory.steps.every((step) => step.trim().length > 0) &&
    isNonEmptyString(advisory.expectedOutcome) &&
    isStringArray(advisory.antiPatterns) &&
    isStringArray(advisory.sourceProceduralMemoryIds) &&
    typeof advisory.confidence === "number" &&
    Number.isFinite(advisory.confidence) &&
    advisory.confidence >= 0 && advisory.confidence <= 1;
}

export function parseSkillAdvisories(value: unknown): SkillAdvisory[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Partial<SkillRecallResult>;
  if (result.success !== true || result.enabled !== true || !Array.isArray(result.advisories)) {
    return null;
  }
  return result.advisories.every(isAdvisory) ? result.advisories : null;
}

function renderList(label: string, values: string[]): string | null {
  if (values.length === 0) return null;
  return `${label}: ${values.map(escapeXmlText).join(", ")}`;
}

export function renderSkillAdvisory(advisory: SkillAdvisory): string {
  const lines = [
    `<skill-advisory id="${escapeXmlAttr(advisory.skillId)}" confidence="${advisory.confidence.toFixed(2)}">`,
    `Name: ${escapeXmlText(advisory.name)}`,
    `Trigger: ${escapeXmlText(advisory.triggerCondition)}`,
    "Steps:",
    ...advisory.steps.map((step, index) => `${index + 1}. ${escapeXmlText(step)}`),
    `Expected outcome: ${escapeXmlText(advisory.expectedOutcome)}`,
  ];
  const antiPatterns = renderList("Avoid", advisory.antiPatterns);
  const evidence = renderList("Evidence", advisory.sourceProceduralMemoryIds);
  if (antiPatterns) lines.push(antiPatterns);
  if (evidence) lines.push(evidence);
  lines.push("</skill-advisory>");
  return lines.join("\n");
}

const SECTION_OPENING = [
  '<skill-advisories source="agentmemory" mode="advisory">',
  "Advisory checklists only. Apply them only when relevant; do not execute automatically.",
].join("\n");
const SECTION_CLOSING = "</skill-advisories>";

function renderSection(advisories: string[]): string {
  return `${SECTION_OPENING}\n${advisories.join("\n\n")}\n${SECTION_CLOSING}`;
}

export function packSkillAdvisories(
  advisories: SkillAdvisory[],
  tokenBudget: number,
): { content: string; tokens: number } | null {
  const selected: string[] = [];
  for (const advisory of advisories) {
    const rendered = renderSkillAdvisory(advisory);
    const candidate = renderSection([...selected, rendered]);
    if (estimateTokens(candidate) <= tokenBudget) selected.push(rendered);
  }
  if (selected.length === 0) return null;
  const content = renderSection(selected);
  return { content, tokens: estimateTokens(content) };
}
