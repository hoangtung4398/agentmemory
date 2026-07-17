import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyBuildAssets } from "../scripts/copy-build-assets.js";

const tempRoots: string[] = [];

async function createFixture(): Promise<{ root: string; dist: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentmemory build assets "));
  const dist = join(root, "dist");
  await mkdir(join(root, "src", "viewer"), { recursive: true });
  await mkdir(dist);
  await Promise.all([
    writeFile(join(root, "iii-config.yaml"), "engine"),
    writeFile(join(root, "iii-config.docker.yaml"), "docker-engine"),
    writeFile(join(root, "docker-compose.yml"), "services"),
    writeFile(join(root, ".env.example"), "KEY=value"),
    writeFile(join(root, "src", "viewer", "index.html"), "<main>viewer</main>"),
    writeFile(join(root, "src", "viewer", "favicon.svg"), "<svg />"),
  ]);
  tempRoots.push(root);
  return { root, dist };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("copyBuildAssets", () => {
  it("copies the required release assets into dist using platform-safe paths", async () => {
    const { root, dist } = await createFixture();

    await copyBuildAssets(root, dist);

    await expect(readFile(join(dist, "iii-config.yaml"), "utf8")).resolves.toBe("engine");
    await expect(readFile(join(dist, "iii-config.docker.yaml"), "utf8")).resolves.toBe("docker-engine");
    await expect(readFile(join(dist, "docker-compose.yml"), "utf8")).resolves.toBe("services");
    await expect(readFile(join(dist, ".env.example"), "utf8")).resolves.toBe("KEY=value");
    await expect(readFile(join(dist, "viewer", "index.html"), "utf8")).resolves.toBe("<main>viewer</main>");
    await expect(readFile(join(dist, "viewer", "favicon.svg"), "utf8")).resolves.toBe("<svg />");
  });

  it("fails when a required asset is missing", async () => {
    const { root, dist } = await createFixture();
    await rm(join(root, "iii-config.yaml"));

    await expect(copyBuildAssets(root, dist)).rejects.toThrow();
  });
});
