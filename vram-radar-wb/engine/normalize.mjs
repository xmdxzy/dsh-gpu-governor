/**
 * 归一化层：把采集器的原始样本压成面板认识的那一份快照。
 *
 * 面板（lib/client.js）只吃一种形状——和 DSH 插件 `snapshot()` 返回的完全一致。
 * 桌面端已经把这套归组 / 任务身份 / 工作归属的逻辑写了 1800 行，重复实现一遍
 * 只会立刻跑偏，所以这里优先 **借用 DSH 插件宿主半导出的 __test 工具**：
 *
 *   __test.aggregateGroups()  —— 按项目归组（脚本 > 程序 > 参数 三桶证据）
 *   __test.describeProcess()  —— 「python.exe」→「ComfyUI-H3 · h3_t2v_fp8」
 *   __test.workloadDetail()   —— 工作归属：引擎版本 / 在用的模型 / 正在跑的任务
 *   __test.collectWorkload()  —— 探测 FlowEdge / ComfyUI / Ollama
 *
 * 插件不在（卸载了 / 换机器）时退到本文件的精简归组：只按可执行路径分桶，
 * 任务名用 PE 里的产品名，不探测本地引擎。降级是显式的，会写进 snapshot.warnings。
 */
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

export const STATE_DIR = process.env.VRAM_RADAR_HOME || path.join(os.homedir(), ".workbuddy", "vram-radar");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const HISTORY_FILE = path.join(STATE_DIR, "history.jsonl");
const DEFAULT_DSH_INDEX = path.join(os.homedir(), ".dsh", "plugins", "dsh-gpu-governor", "lib", "index.js");
const HISTORY_LIMIT = 200;
const TOP_LIMIT = 5;
const ALL_LIMIT = 30;

const mib = (bytes) => Math.round(bytes / (1024 * 1024));
const round1 = (value) => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export async function loadState() {
	const fallback = { reservedMiB: 2048, budgets: {} };
	try {
		const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
		return {
			reservedMiB: Number.isFinite(raw?.reservedMiB) ? raw.reservedMiB : fallback.reservedMiB,
			budgets: raw?.budgets && typeof raw.budgets === "object" ? raw.budgets : {}
		};
	} catch {
		return fallback;
	}
}

/** 每轮采样写一行，跨调用累积成趋势。DSH 侧是内存里的 200 点，这里是磁盘上的 200 点。 */
export async function appendHistory(points) {
	if (points.length === 0) return;
	await mkdir(STATE_DIR, { recursive: true });
	const lines = points.map((point) => JSON.stringify(point));
	let existing = "";
	try { existing = await readFile(HISTORY_FILE, "utf8"); } catch { existing = ""; }
	const kept = existing.split("\n").filter((line) => line.trim().startsWith("{"));
	const merged = [...kept, ...lines].slice(-HISTORY_LIMIT);
	await writeFile(HISTORY_FILE, `${merged.join("\n")}\n`, "utf8");
}

async function readHistory() {
	try {
		const raw = await readFile(HISTORY_FILE, "utf8");
		return raw.split("\n")
			.filter((line) => line.trim().startsWith("{"))
			.map((line) => { try { return JSON.parse(line); } catch { return null; } })
			.filter((entry) => entry !== null)
			.slice(-HISTORY_LIMIT);
	} catch {
		return [];
	}
}

async function loadHostHelpers() {
	const indexPath = process.env.VRAM_GOVERNOR_INDEX || DEFAULT_DSH_INDEX;
	if (!existsSync(indexPath)) return null;
	try {
		const module = await import(pathToFileURL(indexPath).href);
		const helpers = module?.__test;
		if (!helpers || typeof helpers.aggregateGroups !== "function") return null;
		return helpers;
	} catch {
		return null;
	}
}

/* ---------------------------------------------------------------- 降级归组 */

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|uproject|blend|bat|ps1|exe)$/i;

function tokens(cmd) {
	if (typeof cmd !== "string") return [];
	return cmd.match(/"[^"]+"|\S+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
}

function evidencePath(proc) {
	const list = tokens(proc.cmd);
	for (const token of list.slice(1)) {
		if (SCRIPT_EXT.test(token) && /[\\/]/.test(token)) return token;
	}
	return proc.exe || list[0] || proc.name || "";
}

function fallbackGroups(procs) {
	const buckets = new Map();
	for (const proc of procs) {
		const evidence = evidencePath(proc);
		const dir = path.dirname(evidence);
		const key = `path:${dir.toLowerCase()}`;
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			const label = path.basename(dir) || proc.prod || proc.name || "未归组";
			bucket = { key, label, basis: "path", dir, memBytes: 0, ramBytes: 0, cpu: 0, util: 0, processes: [] };
			buckets.set(key, bucket);
		}
		bucket.memBytes += Math.round((proc.memMiB ?? 0) * 1048576);
		bucket.ramBytes += Math.round((proc.ramMiB ?? 0) * 1048576);
		bucket.cpu += proc.cpuPct ?? 0;
		bucket.util += proc.utilPct ?? 0;
		bucket.processes.push({
			...proc,
			task: proc.prod || proc.name || "",
			sub: path.basename(evidence)
		});
	}
	return buckets;
}

/* --------------------------------------------------------------- 快照组装 */

/**
 * @param {object} sample 采集器最后一行原始样本
 * @param {object[]} samples 本轮全部样本（用于趋势与峰值）
 * @param {{sanitize?: (text: string) => string}} options
 */
export async function buildSnapshot(sample, samples, options = {}) {
	const sanitize = typeof options.sanitize === "function" ? options.sanitize : (text) => text;
	const state = await loadState();
	const helpers = await loadHostHelpers();
	const warnings = [];
	if (helpers === null) warnings.push("未找到 DSH 显存雷达插件，已降级为按可执行路径归组（不探测 FlowEdge / ComfyUI / Ollama）");

	let groups;
	let workload = null;
	if (helpers !== null) {
		workload = await helpers.collectWorkload({
			flowedgeBaseUrl: process.env.FLOWEDGE_BASE_URL || "http://127.0.0.1:8080",
			ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
		}).catch(() => null);
		groups = helpers.aggregateGroups(sample.procs ?? [], [], new Set()).groups;
	} else {
		groups = fallbackGroups(sample.procs ?? []);
	}

	const ordered = [...groups.values()].sort((a, b) => b.memBytes - a.memBytes);
	const totalMem = ordered.reduce((sum, group) => sum + group.memBytes, 0);

	const projects = ordered.slice(0, ALL_LIMIT).map((group) => {
		for (const proc of group.processes) {
			if (helpers !== null) {
				const described = helpers.describeProcess(proc, workload);
				proc.task = described.task;
				proc.sub = described.sub;
			}
		}
		group.processes.sort((a, b) => b.memMiB - a.memMiB || b.cpuPct - a.cpuPct);
		const lead = group.processes[0];
		const detail = helpers !== null ? helpers.workloadDetail(group, workload) : null;
		const budgetMiB = Number.isFinite(state.budgets[group.key]) ? state.budgets[group.key] : null;
		const memMiB = round1(group.memBytes / 1048576);
		const row = {
			key: group.key,
			label: group.label,
			basis: group.basis,
			dir: sanitize(group.dir ?? ""),
			memMiB,
			utilPct: round1(Math.min(100, group.util)),
			cpuPct: round1(Math.min(100, group.cpu)),
			ramMiB: mib(group.ramBytes),
			share: totalMem > 0 ? round1((memMiB * 1048576 / totalMem) * 100) : 0,
			peakMiB: memMiB,
			budgetMiB,
			overBudget: budgetMiB !== null && memMiB > budgetMiB,
			processCount: group.processes.length,
			taskLabel: lead?.task ?? "",
			taskSub: lead?.sub ?? "",
			processes: group.processes.slice(0, 8).map((proc) => ({
				pid: proc.pid,
				name: proc.name,
				prod: proc.prod,
				memMiB: round1(proc.memMiB ?? 0),
				utilPct: round1(proc.utilPct ?? 0),
				cpuPct: round1(proc.cpuPct ?? 0),
				ramMiB: proc.ramMiB ?? 0,
				alive: proc.alive !== false,
				suspended: proc.suspended === true,
				exe: sanitize(proc.exe ?? ""),
				cmd: sanitize(proc.cmd ?? ""),
				task: proc.task,
				sub: sanitize(proc.sub ?? "")
			}))
		};
		if (detail !== null) row.detail = detail;
		return row;
	});

	// 峰值只能来自本轮样本：WorkBuddy 侧没有常驻进程，拿不到跨调用的高水位。
	const peakByKey = new Map();
	for (const entry of samples) {
		const snapshotGroups = helpers !== null
			? helpers.aggregateGroups(entry.procs ?? [], [], new Set()).groups
			: fallbackGroups(entry.procs ?? []);
		for (const [key, group] of snapshotGroups) {
			const value = round1(group.memBytes / 1048576);
			peakByKey.set(key, Math.max(peakByKey.get(key) ?? 0, value));
		}
	}
	for (const row of projects) row.peakMiB = Math.max(row.peakMiB, peakByKey.get(row.key) ?? 0);

	const gpu = Array.isArray(sample.gpus) ? sample.gpus[0] : null;
	const cpuSample = sample.cpu ?? null;
	const memSample = sample.mem ?? null;
	const totalMiB = gpu ? Math.round(gpu.memTotal) : 0;
	const usedMiB = gpu ? Math.round(gpu.memUsed) : 0;
	const freeMiB = gpu ? Math.max(0, totalMiB - usedMiB) : 0;
	const reserveSuggestedMiB = clamp(Math.round(totalMiB * 0.06), 512, 4096);

	// 单样本时 procUtil（差值法）必然是 0，此时用 PerfOS 的 _Total 兜底。
	const deltaCpu = typeof cpuSample?.procUtil === "number" ? cpuSample.procUtil : null;
	const perfCpu = typeof cpuSample?.totalUtil === "number" ? cpuSample.totalUtil : cpuSample?.util;
	const cpuPct = deltaCpu !== null && deltaCpu > 0.05 ? deltaCpu : (perfCpu ?? 0);

	const freshHistory = samples.map((entry) => ({
		t: entry.t ?? Date.now(),
		usedMiB: Math.round(entry.gpus?.[0]?.memUsed ?? 0),
		utilPct: Math.round(entry.gpus?.[0]?.util ?? 0),
		cpuPct: round1(typeof entry.cpu?.procUtil === "number" && entry.cpu.procUtil > 0.05 ? entry.cpu.procUtil : (entry.cpu?.totalUtil ?? entry.cpu?.util ?? 0)),
		ramPct: round1(entry.mem?.pct ?? 0)
	}));
	await appendHistory(freshHistory);
	const history = await readHistory();

	const trackedBytes = ordered.reduce((sum, group) => sum + group.memBytes, 0);
	const pressure = totalMiB <= 0 ? "idle" : (totalMiB - usedMiB <= 0 || usedMiB / totalMiB >= 0.92) ? "crit" : usedMiB / totalMiB >= 0.8 ? "warn" : "ok";

	const snapshot = {
		generatedAt: new Date().toISOString(),
		stale: false,
		ageMs: 200,
		error: null,
		collector: {
			running: true,
			intervalMs: options.intervalMs ?? 1200,
			sampleMs: Math.round(sample.elapsedMs ?? 0),
			lastError: null
		},
		gpu: gpu === null ? null : {
			index: gpu.index ?? 0,
			name: gpu.name ?? "未知显卡",
			totalMiB,
			usedMiB,
			freeMiB,
			utilPct: Math.round(gpu.util ?? 0),
			tempC: gpu.tempC ?? null,
			powerW: gpu.powerW ?? null
		},
		cpu: cpuSample === null ? null : {
			utilPct: round1(cpuPct),
			cores: Array.isArray(cpuSample.cores) ? cpuSample.cores.map((value) => Math.round(value)) : [],
			coreCount: Array.isArray(cpuSample.cores) ? cpuSample.cores.length : 0,
			logicalCores: sample.cores ?? cpuSample.cores?.length ?? 1,
			ram: memSample === null ? null : {
				totalMiB: Math.round(memSample.totalMB ?? 0),
				usedMiB: Math.round(memSample.usedMB ?? 0),
				pct: round1(memSample.pct ?? 0)
			}
		},
		headroomMiB: Math.max(0, freeMiB - state.reservedMiB),
		reservedMiB: state.reservedMiB,
		reserveSuggestedMiB,
		pressure,
		overBudgetCount: projects.filter((row) => row.overBudget).length,
		trackedMiB: mib(trackedBytes),
		trackedRamMiB: mib(ordered.reduce((sum, group) => sum + group.ramBytes, 0)),
		processCount: sample.procs?.length ?? 0,
		groupCount: ordered.length,
		hiddenMiB: mib(ordered.slice(TOP_LIMIT).reduce((sum, group) => sum + group.memBytes, 0)),
		history,
		projects,
		top: projects.slice(0, TOP_LIMIT),
		all: projects.map((row) => {
			const copy = { ...row };
			delete copy.processes;
			delete copy.detail;
			return copy;
		}),
		budgets: state.budgets,
		policy: { reservedMiB: state.reservedMiB },
		suspendedPids: (sample.procs ?? []).filter((proc) => proc.suspended === true).map((proc) => proc.pid),
		workloads: workload === null ? null : {
			probedAt: workload.probedAt,
			flowedge: workload.flowedge === null ? null : {
				base: workload.flowedge.base,
				version: workload.flowedge.version,
				uptimeSeconds: workload.flowedge.uptimeSeconds,
				runningDeps: workload.flowedge.deps.filter((dep) => dep.running).map((dep) => dep.label),
				runningJobs: workload.flowedge.runs.length
			},
			comfy: workload.comfy.map((entry) => ({ name: entry.name, endpoint: entry.endpoint, models: entry.models })),
			ollama: workload.ollama === null ? 0 : workload.ollama.models.length,
			errors: workload.errors
		},
		warnings
	};
	return snapshot;
}

/** 路径脱敏：投稿截图 / 公开页面不能带出本机账号名。 */
export function makeSanitizer(enabled) {
	if (!enabled) return (text) => text;
	const userName = os.userInfo().username;
	const home = os.homedir();
	const homeWin = home.replace(/\//g, "\\");
	const homePosix = home.replace(/\\/g, "/");

	/**
	 * 有些字段是「先截断加省略号」再进脱敏器的，例如 `C:\Users\Administrat…`：
	 * 完整 home 匹配不上，完整账号名也匹配不上，账号名就这样漏出去了。
	 * 这里按「用户目录根」整段匹配 `<home 的父目录>\<任意账号片段>`，
	 * 顺带把同机其他账号的路径也抹平——过度脱敏比漏一个账号名安全。
	 * 仅当 home 形如 `X:\Users\<name>` 时启用，其他布局退回字面替换。
	 */
	const userRoot = path.dirname(homeWin);
	const usersLayout = path.basename(userRoot).toLowerCase() === "users";
	const userRe = usersLayout
		? new RegExp(`${userRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/][^\\\\/\\s"',;)]*`, "gi")
		: null;

	return (text) => {
		let out = String(text);
		if (userRe !== null) {
			out = out.replace(userRe, (match) => (match.includes("\\") ? "C:\\Users\\you" : "C:/Users/you"));
		}
		return out
			.split(homeWin).join("C:\\Users\\you")
			.split(homePosix).join("C:/Users/you")
			.split(`${userName}`).join("you");
	};
}

export { STATE_FILE, HISTORY_FILE, TOP_LIMIT, ALL_LIMIT };
