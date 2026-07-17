import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootAssets = [
  "iii-config.yaml",
  "iii-config.docker.yaml",
  "docker-compose.yml",
  ".env.example",
];

export async function copyBuildAssets(root: string, dist: string): Promise<void> {
  await Promise.all(rootAssets.map((asset) => copyFile(join(root, asset), join(dist, asset))));
  await mkdir(join(dist, "viewer"), { recursive: true });
  await Promise.all([
    copyFile(join(root, "src", "viewer", "index.html"), join(dist, "viewer", "index.html")),
    copyFile(join(root, "src", "viewer", "favicon.svg"), join(dist, "viewer", "favicon.svg")),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyBuildAssets(process.cwd(), join(process.cwd(), "dist"));
}
