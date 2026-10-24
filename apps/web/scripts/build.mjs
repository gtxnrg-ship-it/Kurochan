import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(appRoot, "public");
const destination = join(appRoot, "dist");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
process.stdout.write("Kuro-chan web shell built to apps/web/dist.\n");
