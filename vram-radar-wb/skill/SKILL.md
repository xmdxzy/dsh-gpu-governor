---
name: vram-radar
description: 显卡雷达 GPU Radar（曾用名显存雷达）：回答「显卡与显存现在被谁占着、那份占用到底是哪个模型/哪个任务、还能不能再起一个模型」。当用户提到显存、显卡占用、GPU 占用、VRAM、谁在吃显存、爆显存/OOM、还能跑多大模型、要不要释放显存、ComfyUI 或 Ollama 驻留了哪些权重、给项目设显存预算、看显存曲线时使用。触发词：显卡雷达、显存雷达、显卡占用、GPU 占用、VRAM、谁在吃显存、爆显存、OOM、还能跑多大、释放显存、ComfyUI 显存、vram radar。
agent_created: true
---

# 显卡雷达 · GPU Radar（WorkBuddy 输入框版）

引擎目录（下称 `$RADAR`）：本仓库根目录（装技能时换成本机实际路径）

先确认 `$RADAR\engine\snapshot.mjs` 存在；不存在就直说「显卡雷达引擎不在 `<路径>`」，不要自己造数据。

## 一、默认动作

用户只说「显卡雷达」「看显存」「谁在吃显存」「显卡怎么样」时，跑：

```bash
cd "$RADAR" && node engine/snapshot.mjs --brief --samples 3 --deadline 20000
```

超时给 30 秒（冷启第一行约 6.5 秒：WMI 类首次加载 + 数百个 GPU Engine 实例）。

把终端输出**原样**贴进回答（它就是给人看的排版），再补一句判读：能不能再起模型、要不要先释放谁。不要复述工具原理。

## 二、按意图分流

| 用户说 | 跑什么 | 回什么 |
|---|---|---|
| 看显存 / 谁在吃显存 / 显卡怎么样 | `--brief` | 原样贴 + 一句判读 |
| 榜单 / 排名 / 前几名 / 全部项目 | `--brief`，必要时 `--json` 取 `projects[]` | 前 8–10 名表格：项目 / 任务 / 显存 / 份额 |
| 详情 `<项目名>` | `--json` 后按 `projects[].label` 模糊匹配 | 进程清单 + 工作归属 + 在用权重（`detail.items` / `detail.models`） |
| 还能跑多大 / 会不会 OOM | `--brief` 取「可分配」 | 直接给判断：可分配 X G → 能跑什么、不能跑什么 |
| 预算 `<项目>` `<MiB>` | 改 `%USERPROFILE%\.workbuddy\vram-radar\state.json` 的 `budgets["<项目 key>"]` | 确认新预算 + 当前是否超 |
| 面板 / 曲线 / 网页 | `node web/server.mjs`（默认 4711） | 给 `http://127.0.0.1:4711` |
| 存档一份快照 | `--emit-web`（写页面数据）或 `--json --out <路径>` | 文件路径 |

`--json` 的结构：`gpu{totalMiB,usedMiB,utilPct,tempC,powerW}`、`cpu{utilPct,cores[],ram{}}`、`headroomMiB`、`reservedMiB`、`pressure(ok|warn|crit|idle)`、`projects[]{key,label,memMiB,share,cpuPct,taskLabel,detail{kind,items[],models[]},processes[]}`、`history[]`、`workloads{flowedge,comfy,ollama}`。

## 三、回答形状（固定三段，不要改）

1. **结论一行**：`显存 X.XG / YY.YG（ZZ%）· 压力 正常/偏紧/告急 · 可分配 N.NG`
2. **谁在吃**：最多 8 行，`序号 项目 · 任务 · 显存 · 份额`，超预算的标出来
3. **能怎么办**：最多 2 条动作（释放谁 / 还差多少 / 别起什么）

不写「我帮你查了一下」这类铺垫；不加免责声明；不给没测到的数字。

## 四、硬边界

- **默认只读**：不结束、不暂停任何进程。用户明确说「停掉 X」时：先报 `PID / 进程名 / 占多少显存`，等一句确认，再执行
  `powershell -NoProfile -File engine/manage.ps1 -Action suspend -ProcessId <pid>`（恢复用 `-Action resume`）。
- **暂停 ≠ 释放**：suspend 只让出算力，显存照样占着；真要腾显存只能结束进程 —— 这句必须在建议里说清。
- **路径脱敏**：默认把 `C:\Users\<用户名>` 换成 `C:\Users\you`；用户要原文才加 `--raw`，且提醒这会把本机账号名带到输出里。
- **没读显卡就说没读到**：`gpu === null` 时不要拿处理器/内存数字凑一份「显卡报告」。
- **不落文件**：默认只在对话里给结果；用户要存档才写 `out/`。
- 采集器是「拉起 PowerShell 收够样本后杀掉」的一次性动作，不要留常驻进程，也不要重复拉起两个采集器。

## 五、常见追问

- 「为什么和任务管理器不一样」→ 任务管理器按 GPU 引擎分片统计，会重复计数；这里按进程去重后按项目归组。
- 「ComfyUI 那个 20G 是什么」→ 指向 `detail.items` 的 `resident`（权重清单）与 `vramUsage`（权重合计 vs 驻留）。
- 「能不能设个告警」→ 现在没有推送通道，只能给「可分配低于阈值就该释放」的固定判据；阈值用 `state.json` 的 `reservedMiB` 调。
