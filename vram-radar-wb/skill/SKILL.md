---
name: vram-radar
description: GPU Radar answers which processes currently hold the GPU and VRAM, which model or job that memory belongs to, and whether another model can be started. Use when the user mentions VRAM, GPU usage, VRAM hogs, out-of-memory/OOM, how large a model still fits, freeing VRAM, which weights ComfyUI or Ollama has resident, per-project VRAM budgets, or GPU usage curves. Triggers: GPU radar, VRAM radar, GPU usage, VRAM, who is using the GPU, out of memory, OOM, how big a model fits, free VRAM, ComfyUI VRAM, vram radar.
agent_created: true
---

# GPU Radar — input-box skill

Engine directory (called `$RADAR` below): the root of this repository; substitute the local path when the skill is installed.

First confirm `$RADAR\engine\snapshot.mjs` exists. If it does not, say plainly that the GPU Radar engine is missing at that path — never make up numbers.

## 1. Default action

When the user just says "GPU radar", "check VRAM", "who is using the GPU" or "how is the GPU doing", run:

```bash
cd "$RADAR" && node engine/snapshot.mjs --brief --samples 3 --deadline 20000
```

Allow 30 seconds (the first line takes about 6.5s cold: first WMI class load plus hundreds of GPU Engine instances).

Paste the terminal output **verbatim** into the answer — it is already laid out for humans — then add one sentence of judgement: can another model start, and should something be freed first. Do not explain how the tool works.

## 2. Route by intent

| User says | Run | Return |
|---|---|---|
| Check VRAM / who is using the GPU / how is the GPU | `--brief` | Output verbatim plus one-sentence verdict |
| Leaderboard / ranking / top projects / all projects | `--brief`, then `--json` for `projects[]` if needed | Table of the top 8–10: project / task / VRAM / share |
| Detail `<project>` | `--json`, fuzzy-match `projects[].label` | Process list, workload attribution, resident weights (`detail.items` / `detail.models`) |
| How large a model fits / will it OOM | `--brief`, read "allocatable" | Direct verdict: XG allocatable means what fits and what does not |
| Budget `<project>` `<MiB>` | Edit `budgets["<project key>"]` in `%USERPROFILE%\.workbuddy\vram-radar\state.json` | Confirm the new budget and whether it is currently exceeded |
| Panel / curves / web page | `node web/server.mjs` (default 4711) | Give `http://127.0.0.1:4711` |
| Archive a snapshot | `--emit-web` (writes the page data) or `--json --out <path>` | The file path |

`--json` shape: `gpu{totalMiB,usedMiB,utilPct,tempC,powerW}`, `cpu{utilPct,cores[],ram{}}`, `headroomMiB`, `reservedMiB`, `pressure(ok|warn|crit|idle)`, `projects[]{key,label,memMiB,share,cpuPct,taskLabel,detail{kind,items[],models[]},processes[]}`, `history[]`, `workloads{flowedge,comfy,ollama}`.

## 3. Answer shape (three fixed parts, do not change)

1. **One-line verdict**: `VRAM X.XG / YY.YG (ZZ%) · pressure normal/tight/critical · allocatable N.NG`
2. **Who is using it**: at most 8 lines, `index project · task · VRAM · share`, marking anything over budget
3. **What can be done**: at most 2 actions (what to free / how much is still missing / what not to start)

No "let me look that up for you" preamble, no disclaimers, no numbers that were not measured.

## 4. Hard boundaries

- **Read-only by default**: never kill or suspend a process. When the user explicitly says "stop X": first report `PID / process name / VRAM held`, wait for one confirmation, then run
  `powershell -NoProfile -File engine/manage.ps1 -Action suspend -ProcessId <pid>` (use `-Action resume` to restore).
- **Pause ≠ release**: suspend only yields compute, VRAM stays held; freeing VRAM means ending the process. Say this in the recommendation.
- **Path redaction**: `C:\Users\<user>` becomes `C:\Users\you` by default; only add `--raw` when the user asks for the original, and warn that it exposes the local account name.
- **No GPU means say so**: when `gpu === null`, do not dress CPU/RAM numbers up as a GPU report.
- **No files by default**: report in the conversation; write under `out/` only when the user asks to archive.
- The collector is a one-shot "spawn PowerShell, collect enough samples, kill it" action: leave no resident process behind and never start two collectors at once.

## 5. Common follow-ups

- "Why does this differ from Task Manager?" → Task Manager counts per GPU engine and double counts; this deduplicates per process, then groups into projects.
- "What is that 20G in ComfyUI?" → Point at `detail.items` (`resident`, the weight list) and `vramUsage` (weight total vs resident).
- "Can it alert me?" → There is no push channel; the fixed rule is "free something when allocatable drops below the threshold", and the threshold is `reservedMiB` in `state.json`.
