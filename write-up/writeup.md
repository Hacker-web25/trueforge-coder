---
title: "TrueForge Coder — Round 1 write-up"
subtitle: "TrueFoundry Forge-a-thon, Techfest IIT Bombay 2026-27"
---

**Repository:** https://github.com/Hacker-web25/trueforge-coder · **Demo video:** [FILL: link]

## 1. Team

Solo entry. **Aryan Bansal** (team leader), GitHub: @Hacker-web25.

## 2. Starting point

**From scratch.** No upstream repository was forked. Dependencies only: `@truefoundry/trueforge-sdk` (TrueForge client), `@modelcontextprotocol/sdk` (MCP server), `diff`, `zod`. TrueForge itself is run unmodified from `npx @truefoundry/trueforge@latest`.

## 3. Architecture on TrueForge

The extension is a **client of a local TrueForge** (HTTP API via the TypeScript SDK) and never calls a model provider. For each run it creates a session with an inline agent definition (also saved in `agent/`), sends the user turn, and renders the streamed events (text deltas, tool calls and results, subagent threads, compaction events) in a chat panel.

**Editor capabilities are MCP tools.** The extension hosts a Streamable-HTTP MCP server on `127.0.0.1:8791`, registered in TrueForge as the connector `vscode-editor`: `find_relevant_code`, `read_file`, `list_dir`, `search_code` (read-only) and `propose_edit`, `write_new_file`, `run_command` (write tools). The agent, not the extension, decides what to read and change.

**TrueForge tool approval drives the diff review.** The three write tools are listed in `require_approval_for_tools`. When the agent calls one, the turn pauses with `tool.approval_required`; the extension computes the hunks (a per-file diff split into independent hunks), shows a card with one checkbox per hunk and a live native VS Code diff, and sends `user.tool_approval` allow/deny. The accepted hunks are recorded in an in-process approval ledger, and the MCP tool applies exactly those hunks. As defence in depth the tool itself refuses to write without a matching ledger grant, and refuses if the file changed after review, so no silent write is possible. Every run keeps a checkpoint, which gives **Undo last run** and an all-or-nothing **Stop**.

**TrueForge features used and why:** tool approvals (safe diff review without custom plumbing); MCP connector (editor tools); **subagents** (`create_sub_agent`): the agent instructions send read-only exploration to subagents so raw file contents stay out of the main context; **context compaction** with an early trigger (16k input tokens, configurable) because free-tier models slow down and hit rate limits on long contexts; large-tool-response handling for big reads/searches. TrueForge's SSRF guard blocks loopback MCP servers by default, so the README starts it with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`.

## 4. How context is selected

Hard budget: **6,000 tokens** (setting; chars/4 estimate). Priority: (1) explicit `@file` / `@symbol` mentions (up to 60% of the budget); (2) the selection or active file; (3) **automatic retrieval** over the whole workspace for the remainder. Retrieval cuts every file into function/class-sized chunks (headings for docs), ranks them with **BM25** (symbol name ×3, path ×2, identifiers split on snake_case/camelCase, query terms weighted by type), applies a file-level coverage multiplier, adds **co-change neighbours** (the test file and doc page sharing a module name with a hit, e.g. `cli.py` → `test_cli.py`, `cli.rst`), and packs greedily into the budget with a per-file diversity penalty. Each snippet carries the reason it was chosen. The panel shows the pack ("N items, used/budget tokens"), the same pack is in the user message (so it is visible in the TrueForge session), and the agent is told to state a file-by-file plan before editing. The agent can also call `find_relevant_code`, `search_code` and `read_file` for anything the pack missed. On Flask 3.1.3 (205 files, ~2,300 chunks) indexing takes ~150 ms and a query ~20 ms.

## 5. Model setup

Models run through **TrueForge as an OpenAI-compatible custom provider** named `nvidia` (base URL `https://integrate.api.nvidia.com/v1`, NVIDIA build.nvidia.com **free tier**, hosted by NVIDIA). Primary: NVIDIA Nemotron 3.5 Lightning (`nvidia/nemotron-3.5-lightning-30b-a3b`, 3B-active MoE tuned for fast tool-calling loops); automatic fallback: NVIDIA Nemotron 3 Ultra (`nvidia/nemotron-3-ultra-550b-a55b`, strongest reasoning). Approximate cost: **$0** (rate-limited free tier). Switching: command **TrueForge Coder: Choose Model / Fallback Chain**, the `trueforgeCoder.models` setting, or TrueForge → Settings → Models. `scripts/setup-trueforge.mjs` registers everything from `NVIDIA_API_KEY` (read from the environment; no key is committed).

## 6. Scorecard

| Criterion | Where in video | Claim |
|---|---|---|
| A1 Inline edit | Task A | Select `get_debug_flag`, `Cmd+Alt+K`, native diff beside a hunk list; untick a hunk to reject it, Enter applies. |
| A2 Agent mode | Task B | One request, no files named; the agent finds the relevant files itself and the diff is shown hunk by hunk. |
| A3 Streaming and cancellation | Tasks B and C | Tokens stream from TrueForge events; Stop is immediate, nothing pending is written and files already changed are reverted. |
| B1 Context assembly | Task B | Budgeted retrieval; the pack card lists each snippet with its reason; the agent states its plan. |
| B2 Diff safety | Task B | Per-hunk accept/reject with live diff; **Undo last run** restores the files (shown with `git status`). |
| B3 Resilience (Task C) | Task C | Invalid key: clear message, fallback to second model, `git status` clean. |
| B4 TrueForge integration | Task B | MCP tools and approval-driven review are visible in the TrueForge session shown during Task B. |
| C1 Video | Whole video | Tasks A, B, C in order, each verified on screen. |
| C2 Write-up | n/a | This document. |

## 7. Tools used

VS Code, TrueForge (local mode), NVIDIA NIM free-tier models, Node.js/TypeScript, esbuild, `@vscode/vsce`. **AI coding assistant: Claude (Anthropic)** was used to design, write and test most of the code under the author's direction. Automated tests (23) run against a real local TrueForge with a scripted stand-in model: unit tests, end-to-end runs, a headless run of the bundled extension and its chat panel, and a golden run of Tasks A and B on the real Flask 3.1.3 repo.

## 8. Known limitations and what another month would add

- **Model-bound quality:** free-tier models sometimes fail to copy `old_text` exactly or ignore the plan step; the tool returns precise errors and the agent retries, but a stronger model would help. Subagent use depends on the model's choice.
- **Retrieval is lexical** (BM25 plus structure); there are no embeddings or call graph, so paraphrased concepts with no shared identifiers can be missed. Chunking is symbol-aware for Python and JS/TS only.
- **Edits are search/replace** on one file per call; very large or binary files are out of scope.
- **Verification:** the logic and panel are covered by automated tests, but VS Code UI behaviour was exercised by hand only for the recorded tasks, on macOS; Windows is untested. One run at a time, one workspace folder.
- **Local MCP server has no auth token** (it binds to loopback only; write tools still refuse without an approval grant).
- **With another month:** tree-sitter symbol graph and LSP-backed `@symbol`, embeddings for hybrid retrieval, inline ghost-text diff decorations, an auth token on the MCP server, TrueForge skills/Code Mode for repeated workflows, and an evaluation harness over a set of repository tasks to tune the budget and compaction threshold.
