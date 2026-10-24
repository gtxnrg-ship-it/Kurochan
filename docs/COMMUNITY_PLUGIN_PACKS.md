# Community Agent Skills and Plugin Packs

Kurochan now has a pinned community-pack directory and worker-side skill loader. The directory distinguishes locally usable instruction packs from external marketplaces and runtimes that require a safe adapter.

## Included skill sources

These four MIT-licensed source repositories are pinned as Git submodules:

| Pack | Source | Pinned revision | Kurochan usage |
| --- | --- | --- | --- |
| Superpowers | https://github.com/obra/superpowers | 2ce8aa15d05bd57213e6f746f953aafb7ded7a8b | Planning, TDD, debugging, review, verification |
| wshobson/agents | https://github.com/wshobson/agents | 0874a27b17a22e2b7c2e2bcd725768e0803cad06 | Skills from multi-agent specialist plugin groups |
| Matt Pocock Skills | https://github.com/mattpocock/skills | 5beb35b040e3de97e54fa9e386d7e42d15c295c2 | Debugging, codebase design, specifications, review, TDD |
| Addy Osmani Agent Skills | https://github.com/addyosmani/agent-skills | aeac41d4d005999432bb7312f7ff06383a91d59d | Engineering practices for testing, security, planning, and releases |

Initialize the pinned sources after cloning:

\`\`\`sh
git submodule update --init --recursive
pnpm check:community
\`\`\`

The verification script checks each exact revision, a representative skill document, and MIT license text. CI's checkout uses recursive submodule initialization.

## Other registered sources

The API directory also records Compound Engineering, Awesome Agent Skills, Anthropic Skills, Everything Claude Code, gstack, Graphify, claude-mem, the official Claude Code plugin marketplace, Awesome MCP Servers, Context7, Microsoft Playwright MCP, and the official GitHub MCP Server. Each record includes the repository URL, pinned revision, declared license where available, intended integration mode, and compatibility notes.

These sources are **not all bundled or executable**. Some are large runtimes, marketplace indexes, multi-harness plugin systems, or catalogues that link to other repositories with independent license terms. Anthropic Skills did not declare a license in the repository metadata checked for this pin and is reference-only pending license clarification. Kurochan must not advertise these entries as installed tools.

## Backend endpoints

- \`GET /v1/community-packs\`: list registered sources. Supports \`q\`, \`mode\`, and bounded \`limit\` query parameters. Each record includes its revision and runtime status.
- \`GET /v1/community-skills?q=debugging\`: search metadata of locally available \`SKILL.md\` files. It intentionally does not return full instruction bodies.

For each task, the worker searches the four pinned skill sources and includes at most three relevant documents, within a 12,000-character combined budget. Matching is based on task text and skill metadata. Missing submodules, inaccessible directories, or a malformed individual skill do not block the task.

## Security and trust boundaries

- Skill text is untrusted reference guidance, not a system prompt. It cannot grant permissions, bypass approvals, override Kurochan policy, or justify unsupported completion claims.
- Only the existing workspace and configured tool runtimes take actions. Imported skills are not code execution; helper scripts, hooks, plugin commands, and binaries are not invoked by the skill loader.
- The existing MCP bridge is the path for separately configured tools such as Context7 and Playwright MCP. Configure server-side credentials, least privilege, and user approval for state-changing operations.
- Marketplace indexes are discovery sources. A catalogue's license does not relicense every linked project.
- Change a source pin deliberately, review license and security changes, then run \`pnpm check\` before enabling new content.
