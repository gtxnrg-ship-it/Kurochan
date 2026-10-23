import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const expected = "4e3ac3ca6604c75113f52c695dbddcc7af928b46";
const path = "packages/agent-catalog/vendor/agency-agents";
if (!existsSync(path) || !existsSync(`${path}/README.md`)) {
  console.error(
    "Agency Agents submodule is missing. Run: git submodule update --init --recursive",
  );
  process.exit(1);
}
const current = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (current !== expected) {
  console.error(
    `Agency Agents pin mismatch. Expected ${expected}, found ${current}. Update the pin and tests deliberately.`,
  );
  process.exit(1);
}
const license = readFileSync(`${path}/LICENSE`, "utf8");
if (!/MIT License/i.test(license)) {
  console.error(
    "Expected upstream MIT license text was not found. Re-check upstream licensing before redistribution.",
  );
  process.exit(1);
}
console.log(`Agency Agents pin verified: ${expected}`);
