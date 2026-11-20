# Code walkthrough (for the Round-2 call: "explain your submission, repeat Task A live")

## One-paragraph story
VS Code extension = thin client. All reasoning happens in a TrueForge agent. The extension (1) hosts an MCP server that exposes editor capabilities, (2) opens a TrueForge session per run and streams its events into a chat panel, (3) turns TrueForge's `tool.approval_required` pauses into per-hunk review, and (4) keeps a checkpoint so a run can be undone or cancelled all-or-nothing.

## Files, in the order of a request
| Step | File | What it does |
|---|---|---|
| 1 | `src/extension.ts` | activation, commands, `run()` orchestration, status bar, wiring |
| 2 | `src/core/context.ts` + `retrieval.ts` | builds the budgeted context pack (@mentions → selection → BM25 retrieval) |
| 3 | `src/core/runner.ts` | `ForgeRunner`: session per attempt, stream events, pause/resume on approvals, cancel, retry/back-off/fallback |
| 4 | `src/core/mcpServer.ts` + `editorTools.ts` | the MCP tools the agent calls (read-only tools, and write tools that refuse without a ledger grant) |
| 5 | `src/core/review.ts` + `hunks.ts` + `ledger.ts` | hunk computation, user decision → ledger grant → `user.tool_approval` |
| 6 | `src/vscode/*` + `media/chat.js` | native diff, hunk cards / quick pick, `WorkspaceEdit` writes |
| 7 | `src/core/checkpoints.ts` | before-images per run: Undo, rollback before retry/fallback, all-or-nothing Stop |
| — | `agent/*.json` | the TrueForge agent definitions (instructions, MCP server, `require_approval_for_tools`, compaction, subagents) |

## Task A, step by step (what to say if asked to repeat it live)
1. Selection + instruction → `inlineEdit` command builds a prompt (file, lines, selected code, instruction).
2. `run(..., 'inline')` registers the MCP connector (`PUT /api/v1/settings/mcp-servers`), builds the spec from `agent/forge-agent-inline.json` (model = first of `trueforgeCoder.models`), creates a TrueForge session and sends the turn.
3. The model calls `propose_edit` → TrueForge pauses (`tool.approval_required`) because the tool is in `require_approval_for_tools`.
4. `decideApproval` calls `EditorTools.prepareEdit` (exact-once `old_text` matching) → `computeHunks` → shows native diff + hunk picker.
5. Accepted hunk ids → `composeContent` → `ApprovalLedger.grant` → `user.tool_approval: allow` → TrueForge resumes → the MCP tool `propose_edit` consumes the grant and writes through `WorkspaceEdit`.
6. `Checkpoints.record` stored the before-image → *Undo Last Agent Changes* restores it.

## Questions you should be ready for
- **Why MCP tools and not the extension doing the work?** Eligibility rule, and it keeps the decision with the agent; the extension only enforces safety.
- **What stops a silent write?** Two layers: TrueForge approval gate, and the tool itself refuses without a ledger grant (and if the file changed since review).
- **How is context chosen?** README §"How context is selected": budget, priority order, BM25 + symbol/path boosts + co-change neighbours, per-file diversity penalty, reasons recorded.
- **What happens on cancel?** `runner.cancel()` → `sessions.cancel`, pending reviews resolve as rejected, `rollbackOnCancel` reverts files already written by the run.
- **What happens on a model failure?** `ForgeRunner.run`: roll back the attempt, retry with exponential back-off, then next model in the chain, finally a clear error; workspace unchanged.
- **Which TrueForge features did you use and why?** tool approvals, MCP connector, subagents, compaction (early trigger for free-tier models), large tool-response handling.
- **Limits?** write-up §8.

## Run the tests
`npm test` (needs a running TrueForge). `FLASK_DIR=~/flask-demo npm test` also runs the golden run on the real Flask repo.
