# Workspace code search

Kuro-chan's workspace search uses a bounded, run-scoped SQLite FTS5 index. It is a retrieval aid for the coding agent, not a claim that the repository has complete semantic or language-server indexing.

## How it works

1. The workspace enumerator walks the run workspace, rejects symlinks, and skips common generated/dependency directories such as `node_modules`, `dist`, `.next`, `build`, and `coverage`.
2. Indexing prioritizes source code, then documentation and configuration, within a maximum file count and byte budget.
3. A file fingerprint uses filesystem device, inode, size, modification time, and change time. Files with unchanged fingerprints are not reread for search indexing.
4. Changed text is transactionally synchronized into FTS5; removed or changed files lose stale index entries.
5. Search terms are tokenized and results are ordered using BM25 relevance. Kuro-chan returns bounded line excerpts with paths and line numbers to the agent.
6. The index lives in the configured local SQLite database and is scoped by run ID. It does not upload code or call an embedding service.

## Explicit limits

- Only configured/indexable source, config and text files are considered; binary files and symlinks are excluded.
- The initial implementation caps a single indexing pass at 2,000 files, 25 MB of workspace file metadata/contents, and a configurable runtime indexing budget (20 MB by default). Individual indexed files are bounded by workspace file limits.
- The current index is run-workspace scoped. Persistent repository-level indexes that survive new runs, per-branch content addressing, Tree-sitter symbol extraction, and embeddings are not yet implemented.
- FTS matches are lexical rather than semantic. They improve retrieval over naive first-match substring scans, but should be evaluated against a representative repository/task dataset before adding embeddings or a vector database.
- Code references returned from search are untrusted workspace content. Tool authorization remains enforced by Kuro-chan's backend policy, not by search results or agent instructions.

## Upstream design reference

Continue's open-source indexing approach uses content-addressed/incremental updates and supports SQLite FTS5, structured code snippets, and embedding-backed chunks: https://github.com/continuedev/continue/blob/main/core/indexing/README.md. Kuro-chan adopts the incremental full-text-search foundation without importing Continue's VS Code extension or its larger indexing stack, keeping the backend's run-scoped data boundary explicit.
