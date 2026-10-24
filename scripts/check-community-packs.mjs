import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sources = [
  {
    path: "vendor/community/superpowers",
    commit: "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b",
    skill: "skills/brainstorming/SKILL.md",
  },
  {
    path: "vendor/community/wshobson-agents",
    commit: "0874a27b17a22e2b7c2e2bcd725768e0803cad06",
    skill: "plugins/developer-essentials/skills/debugging-strategies/SKILL.md",
  },
  {
    path: "vendor/community/mattpocock-skills",
    commit: "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    skill: "skills/engineering/diagnosing-bugs/SKILL.md",
  },
  {
    path: "vendor/community/addyosmani-agent-skills",
    commit: "aeac41d4d005999432bb7312f7ff06383a91d59d",
    skill: "skills/debugging-and-error-recovery/SKILL.md",
  },
];

for (const source of sources) {
  if (
    !existsSync(join(source.path, "README.md")) ||
    !existsSync(join(source.path, source.skill)) ||
    !existsSync(join(source.path, "LICENSE"))
  ) {
    console.error(
      "Community skill source is missing files. Run: git submodule update --init --recursive",
    );
    process.exit(1);
  }
  const current = execFileSync(
    "git",
    ["-C", source.path, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (current !== source.commit) {
    console.error(
      "Community skill pin mismatch at " +
        source.path +
        ". Update the revision deliberately.",
    );
    process.exit(1);
  }
  const license = readFileSync(join(source.path, "LICENSE"), "utf8");
  if (!/MIT License/i.test(license)) {
    console.error(
      "Expected MIT license text was not found at " +
        source.path +
        ". Re-check its license before redistribution.",
    );
    process.exit(1);
  }
}
console.log(
  "Community skill source pins, sample files, and MIT license text verified.",
);
