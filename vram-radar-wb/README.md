# VRAM Radar — standalone web panel

A dependency-free web page that answers the same question as the DSH plugin: **which process is holding the GPU, and which model or job that memory belongs to.** No DSH host required — useful for screenshots, sharing a snapshot, or inspecting a machine where DSH is not installed.

It shows more than "GPU at 92%":

```
01 ComfyUI-H3  FlowEdge · idle               22.2G  79%
   └ python.exe PID 75512  →  ComfyUI 0.41.0  →  minimax_h3_fl2va 19.5G / qwen3vl_32b 14.6G …
02 GameViewer                                4.1G  15%
03 Windows     Desktop Window Manager (dwm)  1.3G   5%
```

## Two ways to use it

| Channel | How | For |
|---|---|---|
| **Web page** | `node web/server.mjs` → http://127.0.0.1:4711, or open `web/index.html` directly | Curves, drill-down, screenshots |
| **Skill** (WorkBuddy) | Type `/vram-radar` in the input box | Day-to-day "can I start another model?" |

The skill source is `skill/SKILL.md`; install it under `~/.workbuddy/skills/vram-radar/SKILL.md` and restart WorkBuddy once.

## Layout

```
vram-radar-wb/
├─ engine/                  collect → normalize → snapshot (Node + PowerShell, no dependencies)
│  ├─ collector.ps1         one JSON line per 1.2s: GPU / CPU / RAM plus per-process VRAM
│  ├─ collect.mjs           spawns the collector and stops it once enough samples are in
│  ├─ normalize.mjs         groups into projects, resolves task identity and workload attribution
│  ├─ snapshot.mjs          CLI: --brief / --json / --emit-web
│  └─ manage.ps1            suspend / resume (NtSuspendProcess, explicit confirmation only)
├─ web/                     the panel itself: zero dependencies, zero external requests
│  ├─ index.html · assets/{app.css,app.js,i18n.js} · data/snapshot.js
│  └─ server.mjs            local live server: /api/snapshot resamples on demand
├─ skill/SKILL.md           input-box skill definition
└─ tools/check-i18n.mjs     dictionary self-check: key parity and key references
```

## Languages

- **English is the default.** The globe menu in the top right (`#langbtn`) switches the whole page to Chinese.
- The choice is stored in `localStorage` under `vram-radar/lang/v1` and survives a reload.
- All copy lives in `web/assets/i18n.js` (`en` and `zh` kept in parity). Panel code only references keys such as `T("hero.gpu")`; do not hardcode strings into `app.js`.
- Static nodes in `index.html` are marked with `data-i18n`, `data-i18n-html`, `data-i18n-placeholder` or `data-i18n-aria-label`; JS-generated blocks repaint on a language switch.
- **Data is never translated**: project names, task names, process names, paths and weight names come from the collector and display verbatim in both languages.

## Commands

```bash
cd vram-radar-wb

node engine/snapshot.mjs --brief            # one-line verdict + ranking (default, 3 samples)
node engine/snapshot.mjs --json             # full snapshot
node engine/snapshot.mjs --emit-web         # write into the panel (paths redacted by default)
node engine/snapshot.mjs --brief --raw      # no redaction
node engine/snapshot.mjs --samples 8 --deadline 30000

node web/server.mjs                         # local live panel on :4711
node web/server.mjs --once                  # sample once, then serve as a static page
node web/server.mjs --port 4800 --interval 5000
```

## Where the data comes from

- **VRAM**: `nvidia-smi --query-gpu` → total / used / utilisation / temperature / power
- **Per-process VRAM**: `Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory` (under WDDM the per-process column of `nvidia-smi` is all `N/A`)
- **CPU**: `Win32_PerfFormattedData_PerfOS_Processor` (`_Total`) plus per core
- **RAM**: `Win32_OperatingSystem`
- **Workload attribution**: probes FlowEdge on `:8080`, ComfyUI on `:8189` and Ollama on `:11434`, turning "python.exe" into "ComfyUI-H3 · running job · 4 weights"

Grouping evidence priority: **script path > executable > launch arguments**; only when all three buckets miss does it fall back to the process name. That logic is not duplicated here — it imports the `__test` helpers from the plugin host half at `../lib/index.js`, then falls back to the installed copy under `~/.dsh/plugins`, and when neither is present it degrades to grouping by executable directory and says so explicitly in `snapshot.warnings`.

## Boundaries

- **Read-only by default**: no kill, no suspend; `manage.ps1` is used only when the user asks for it explicitly and confirms twice.
- **Pause ≠ release**: suspend yields compute, VRAM stays held; freeing VRAM means ending the process.
- **Path redaction**: `C:\Users\<you>` becomes `C:\Users\you` by default, so shared screenshots and public pages never leak an account name.
- **No GPU, no fake report**: when `gpu === null` the panel does not dress CPU and RAM numbers up as a GPU report.
- **The public page is a snapshot**: a cloud host cannot read your GPU, so `web/data/snapshot.js` is one real captured sample; live data needs `node web/server.mjs` locally.

## Verification

```bash
node engine/snapshot.mjs --brief          # 0.9–1.6s once warm
node engine/snapshot.mjs --emit-web       # rewrites web/data/snapshot.js
node tools/check-i18n.mjs                 # dictionary self-check, run after any copy change
```

Panel checklist after a UI change:

1. Dial readings do not clip the ring or overflow; the 36-segment halo lights up segment by segment, the needle springs into place, and the red tick breathes above 78%; live refresh only updates the target, it never replays the ignition.
2. Clicking the first ranking row opens four stat cells plus workload attribution, weights, processes and budget.
3. Searching `comfy` leaves a single group; all three sort modes change the order.
4. Setting a budget below current usage turns the row red ("over budget") and the verdict card reports how much could be freed.
5. No horizontal scrolling at 1200px, 720px or 390px.
6. **Language**: English by default; switching to Chinese translates the title, dials, ranking, detail card, search hit count and notes, and the choice survives a reload.

## License

MIT
