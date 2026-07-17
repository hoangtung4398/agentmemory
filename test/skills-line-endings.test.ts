import { describe, expect, it } from "vitest";
import { hasAutogenDrift, normalizeLineEndings } from "../scripts/skills/line-endings.js";

describe("AUTOGEN line ending comparison", () => {
  it("treats LF and CRLF renderings of the same content as current", () => {
    const generated = "<!-- AUTOGEN:tools START -->\ncontent\n<!-- AUTOGEN:tools END -->\n";
    const checkedOutOnWindows = generated.replace(/\n/g, "\r\n");

    expect(normalizeLineEndings(checkedOutOnWindows)).toBe(generated);
    expect(hasAutogenDrift(checkedOutOnWindows, generated)).toBe(false);
  });

  it("continues to detect semantic AUTOGEN drift", () => {
    expect(hasAutogenDrift("58 MCP tools\r\n", "59 MCP tools\n")).toBe(true);
  });
});
