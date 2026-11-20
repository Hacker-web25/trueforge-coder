# Demo video script (max 4:00) — Tasks A → B → C, each verified on screen

Rehearse as often as you like; the wording of the three instructions is fixed by the organisers. Record in one take per task and cut only model waiting time (use a visible "3× speed" caption instead of cutting if you can). **Do not cut between pressing Enter on an instruction and the first diff appearing.**

## Pre-flight (once, ~25 min)

1. `node -v` must be ≥ 22.14 (`brew install node` or nvm).
2. `npm install && npm run package && code --install-extension trueforge-coder-0.1.0.vsix` (or *Extensions → … → Install from VSIX*). Reload VS Code.
3. Terminal 1 — TrueForge: `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest` (leave running; UI at http://localhost:8790).
4. Terminal 2 — models, **typing the key yourself** (so it never touches chat or history):
   ```bash
   read -s NVIDIA_API_KEY; export NVIDIA_API_KEY
   node scripts/setup-trueforge.mjs --broken
   unset NVIDIA_API_KEY
   ```
   Note the "Model chain" it prints; if it differs from `["nvidia/nemotron-3-5-lightning","nvidia/nemotron-3-ultra"]` (a third entry, `nvidia/llama-3-3-70b`, is fine), set `trueforgeCoder.models` accordingly (and fix write-up §5).
5. Demo repo: `demo/prepare-flask.sh ~/flask-demo` (clones Flask, checks out 3.1.3 = `22d92470`, creates `.venv`, installs `pytest==8.4.2` (works on the macOS system Python 3.9), runs the baseline: 58 tests pass, `FLASK_DEBUG=off` prints `True`).
6. VS Code: open `~/flask-demo`; Settings → `trueforgeCoder.commandPreamble` = `. .venv/bin/activate &&`; open an integrated terminal and run `. .venv/bin/activate`.
7. Make it legible: zoom in 2 steps (Cmd+=), close all tabs, turn on Do Not Disturb, 1080p recording (Cmd+Shift+5 or OBS).
8. Dry run Tasks A, B, C once off-camera. If the agent panel says TrueForge is unreachable, re-check step 3.

## Timeline (target 3:55)

| Time | Scene | What to do / say |
|---|---|---|
| 0:00–0:15 | **Intro** (VS Code open on Flask, agent panel visible) | "Coding agents either drown in a big repo or write to your disk without asking. TrueForge Coder is a VS Code extension whose whole agent loop runs on TrueForge: the editor is exposed as MCP tools, every write is a per-hunk approval, and context is retrieved under a token budget. Flask 3.1.3, three tasks." |
| 0:15–1:10 | **Task A — inline edit** | Open `src/flask/helpers.py`, select the whole `get_debug_flag` function (lines 28–33). `Cmd+Alt+K`. Type exactly: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* Enter. Show the progress toast, then the native diff + hunk list. Untick a hunk, re-tick it ("per-hunk"), Enter to accept. Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → **False**. Then `Cmd+Shift+P` → *TrueForge Coder: Undo Last Agent Changes* → `git status` → clean ("applied change is undoable"). |
| 1:10–3:00 | **Task B — agent mode** | Close all editor tabs (so no file is "active"). Open the panel (`Cmd+Alt+L`). Paste exactly: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.* Send. Expand the **Context pack** card (retrieved files + reasons + token budget). Optional 10 s: press **Stop** once tokens are streaming → "Stopped", then send again. Show the plan, tool calls, subagent/compaction notices. Review each file card (toggle a hunk, watch the live diff), **Apply**. Approve the `pytest` command. Click **TrueForge session ↗** and show turns / tool calls / subagent thread or compaction for ~10 s. Terminal: `pytest tests/test_cli.py -q` (passes), `flask --help` (shows `config`), `cd ~/trueforge-coder/demo/demoapp && flask --app app config` (masked JSON), `git status --short` (3 files). Then `git checkout -- .` (3 s, off-camera is fine). |
| 3:00–3:50 | **Task C — resilience** | `Cmd+Shift+P` → *TrueForge Coder: Choose Model / Fallback Chain* → primary `nvidia-broken/nemotron-3-5-lightning` → "Fall back to the other configured models". Repeat Task A (same selection, same instruction). Show the warning toast ("Model nvidia-broken/nemotron-3-5-lightning failed … falling back to nvidia/nemotron-3-5-lightning"), the editor staying responsive (type in a file / scroll), the second model's diff appearing, then **Esc** (reject) → `git status` → *nothing to commit*. If you have 10 s left: choose "Only this model (no fallback)" and show the clear "Every model in the chain failed … Nothing was changed" message. Restore the normal chain afterwards. |
| 3:50–3:58 | **Outro** | Caption: repo link + write-up link. |

## Timestamp sheet (fill while editing; paste into write-up §6)

| Row | What must be on screen | Video time |
|---|---|---|
| A1 | diff + per-hunk list appear, accepted | |
| A2 | Task B finishes; `git status` shows ≥ 3 files | |
| A3 | tokens streaming; Stop pressed; "Stopped" notice | |
| B1 | Context pack card expanded; plan names files | |
| B2 | per-hunk toggle + Undo + clean `git status` | |
| B3 | Task C: failure message, fallback, clean `git status` | |
| B4 | TrueForge session: tool calls + subagent thread / compaction event | |
| C1 | whole video (0:00 – end) | |

## If something goes wrong

- **"TrueForge is not reachable"**: start it with the allow-list env var (step 3); the extension registers its tool server automatically on the first run.
- **Agent never uses a subagent / no compaction in the session**: lower `trueforgeCoder.compactionTriggerTokens` to `8000` and re-record Task B (compaction then fires visibly); update write-up §3/§6 to say which one you show.
- **`old_text` not found / repeated edit errors**: free-tier model slip; the agent retries on its own, otherwise rerun. For Task A you can switch primary model via *Choose Model*.
- **429 rate limit**: the runner retries with back-off; if it persists, wait a minute between takes.
- **A model id is unavailable on your key**: re-run `setup-trueforge.mjs`; it only registers models your key can see.
- **Public links**: open the YouTube/Drive link in a private window before submitting.
