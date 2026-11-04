# 显存雷达 · VRAM Radar（WorkBuddy 版）

> 2026-11-04 · 增加**中英双语**（默认英文，右上角小菜单切换，选择记进浏览器）
> 2026-10-30 · 从 DSH 插件 `dsh-gpu-governor` v3.0.0 适配到 WorkBuddy：
> **输入框一句话查显存** + **可发布的归因看板**。
> 原型：`~/.dsh/plugins/dsh-gpu-governor`（1386 行面板 + 1871 行宿主逻辑）
> 本目录是仓库里的独立网页版（WorkBuddy 通道）；插件版面板在 `lib/client.js`。

它回答一个具体问题：**显卡被谁占着，那份占用到底是哪个模型、哪个任务。**

不是"GPU 使用率 92%"这种数字，而是：

```
01 ComfyUI-H3  FlowEdge · idle               22.2G  79%
   └ python.exe PID 75512  →  ComfyUI 0.41.0  →  minimax_h3_fl2va 19.5G / qwen3vl_32b 14.6G …
02 GameViewer  网易UU远程                      4.1G  15%
03 Windows     桌面窗口管理（dwm）              1.3G   5%
```

## 两条通道

| 通道 | 怎么用 | 给谁 |
|---|---|---|
| **输入框（技能）** | WorkBuddy 输入框敲 `/vram-radar` | 日常问「还能不能起模型」 |
| **网页（可发布）** | `node web/server.mjs` → http://127.0.0.1:4711，或直接开 `web/index.html` | 看曲线、钻取、截图、投稿 |

技能装在 `~/.workbuddy/skills/vram-radar/SKILL.md`（源文件在本仓库 `skill/SKILL.md`）。
新增技能需要重启一次 WorkBuddy 才会出现在斜杠列表里。

## 目录

```
vram-radar-wb/
├─ engine/                 采集 → 归一化 → 快照（Node + PowerShell，无依赖）
│  ├─ collector.ps1        每 1.2s 一行 JSON：GPU/CPU/内存 + 每进程显存（GPU Engine 计数器）
│  ├─ collect.mjs          拉起采集器，收够样本即杀（冷启 6.5s，之后 ~1s/行）
│  ├─ normalize.mjs        归组成「项目」+ 任务身份 + 工作归属；借用 DSH 插件的 __test 工具
│  ├─ snapshot.mjs         CLI：--brief / --json / --emit-web
│  └─ manage.ps1           进程暂停/恢复（NtSuspendProcess，需显式确认才用）
├─ web/                    可发布面板（纯静态，零依赖、零外链）
│  ├─ index.html · assets/{app.css,app.js,i18n.js} · data/snapshot.js
│  └─ server.mjs           本机实时服务：/api/snapshot 每 3s 按需重采
├─ skill/SKILL.md          输入框技能定义
├─ tools/check-i18n.mjs    双语字典自检（键位对齐 + 键引用完整）
└─ docs/lookdev/verify-i18n-cdp.mjs  中英切换 CDP 验收（断言 + 截图）
```

## 中英双语

- **默认英文**。右上角地球小菜单（`#langbtn`）点开选 `English` / `中文`，整页文案跟着走。
- 选择记在 `localStorage` 的 `vram-radar/lang/v1`，刷新后保持；清不掉就想回英文：菜单里再点一次 English。
- 文案全部集中在 `web/assets/i18n.js`（167 键，en/zh 两套对齐）。面板代码里只写 `T("hero.gpu")` 这种键名，
  **不要**再把字符串硬写进 `app.js`。
- `index.html` 里的静态节点用 `data-i18n` / `data-i18n-html` / `data-i18n-placeholder` /
  `data-i18n-aria-label` 标注；JS 生成的区块在切语言时整块重绘。
- **数据本身不翻译**：项目名、任务名、进程名、路径、权重名、`/vram-radar` 的中文子命令
  （`榜单` / `详情` / `预算` / `面板`）都是采集器和技能里的真实值，两种语言下都按原样显示。
- 中文化不改采集、不新增依赖：只有 `i18n.js` 一个文件 + `index.html`/`app.js` 里的键。

## 命令

```bash
cd /path/to/vram-radar          # 仓库根目录

node engine/snapshot.mjs --brief            # 一行判读 + 排行（默认，3 样本）
node engine/snapshot.mjs --json             # 完整快照
node engine/snapshot.mjs --emit-web         # 写进面板（默认脱敏 C:\Users\you）
node engine/snapshot.mjs --brief --raw      # 不脱敏
node engine/snapshot.mjs --samples 8 --deadline 30000

node web/server.mjs                         # 本机实时面板 :4711
node web/server.mjs --once                  # 只采一次
node web/server.mjs --port 4800 --interval 5000
```

## 数据从哪来

- **显存**：`nvidia-smi --query-gpu` → 总量/已用/利用率/温度/功耗
- **每进程显存**：`Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory`（WDDM 下
  `nvidia-smi` 的进程列全是 N/A，只能走这条）
- **处理器**：`Win32_PerfFormattedData_PerfOS_Processor`（`_Total`）+ 每核
- **内存**：`Win32_OperatingSystem`
- **工作归属**：探测 FlowEdge `:8080`、ComfyUI `:8189`、Ollama `:11434`，把
  「python.exe」翻译成「ComfyUI-H3 · 正在跑的任务 · 4 个权重」

归组证据优先级：**脚本路径 > 可执行文件 > 启动参数**；三桶都拿不到才落回进程名。
这套逻辑不重写，直接 `import` DSH 插件的 `__test` 导出；插件不在时退到"按可执行目录分桶"，
并在 `snapshot.warnings` 里显式写明降级（不静默）。

## 边界（写在面板和技能里，不只写在文档里）

- **只读默认**：不结束、不暂停进程；`manage.ps1` 只在用户点名 + 二次确认后用。
- **暂停 ≠ 释放**：suspend 让出算力，显存照占；腾显存只能结束进程。
- **路径脱敏**：默认 `C:\Users\<你>` → `C:\Users\you`，投稿截图和公开页面不会带出账号名。
- **没显卡就说没读到**：`gpu === null` 时不会拿 CPU/内存数字凑一份"显卡报告"。
- **公开站是快照**：云端读不到你的显卡，`web/data/snapshot.js` 是真实采集的一份定格；
  实时只能在本机 `node web/server.mjs`。

## 验收

```bash
node engine/snapshot.mjs --brief          # 0.9–1.6s 内出结果（热态）
node engine/snapshot.mjs --emit-web       # 写 web/data/snapshot.js ~31KB
curl -s http://127.0.0.1:4711/api/health  # {"ok":true,...}
node tools/check-i18n.mjs                  # 双语字典自检（改文案后必跑）
```

面板自检清单（改 UI 后逐条过）：
1. 三个圆表的读数不压环、不溢出；圆表为定稿配方「分段光环 × 粗刻度 × 单针 × 发丝圈 × 读数沉底 × 凝光点火」：
   36 段光环逐段点亮（段头最亮）、指针弹簧落位 + 怠速微振、读数 ≥78% 时红刻度呼吸告警；
   实时刷新只换 target 不重放（pos/vel 活在 `web/assets/app.js` 的 tach 运行时里）；
2. 排行首行点开有 4 格统计 + 工作归属 + 权重 + 进程 + 预算；
3. 搜索「comfy」只剩一组；排序切换三档都变；
4. 设一个低于当前占用的预算 → 行头出现红色「超预算」，判读卡出现「共可释放 X G」；
5. 1200px / 720px / 390px 三档宽度都不横向滚动；
6. **双语**：默认英文；右上角菜单切中文后，标题 / 圆表 / 排行 / 明细卡 / 搜索命中计数 / 说明卡全部变中文；
   切回英文正常；刷新后仍是上次选的语言；窄屏下菜单不被裁。
   （需要真实渲染证据时跑 `node docs/lookdev/verify-i18n-cdp.mjs`，它会截 7 张图并逐项断言。）

## 1024 造物挑战

作品定位：**一个把"谁在吃显存"从任务管理器里捞出来的归因看板**——把「GPU 92%」拆成
「哪个项目 → 哪个进程 → 哪个模型权重」，并且给出「还能不能起下一个模型」的判断。
