import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkable = [join(appRoot, "src/dev-server.mjs"), join(appRoot, "scripts/build.mjs")];
const publicRoot = join(appRoot, "public");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else if ([".js", ".mjs"].includes(extname(path))) result.push(path);
  }
  return result;
}

checkable.push(...(await walk(publicRoot)));
for (const file of checkable) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Syntax check failed");
    process.exit(result.status || 1);
  }
}
const html = await readFile(join(publicRoot, "index.html"), "utf8");
for (const asset of ["app.css", "app.js", "api.mjs", "markdown.mjs", "manifest.webmanifest"]) {
  if (!html.includes(asset)) throw new Error("index.html does not reference " + asset);
}
process.stdout.write("Web JavaScript syntax and shell asset checks passed.\n");
