/**
 * Normalization layer: folds the collector's raw samples into the one snapshot the panel knows.
 *
 * The panel (lib/client.js) accepts exactly one shape — identical to what the DSH plugin's
 * `snapshot()` returns. The desktop side already wrote 1800 lines of grouping / task identity
 * / workload attribution logic, and re-implementing it would drift immediately, so this file
 * prefers **borrowing the __test helpers exported by the DSH plugin host**:
 *
 *   __test.aggregateGroups()  — group by project (script > program > args, three buckets)
 *   __test.describeProcess()  — "python.exe" → "ComfyUI-H3 · h3_t2v_fp8"
 *   __test.workloadDetail()   — workload attribution: engine version / models / running jobs
 *   __test.collectWorkload()  — probe FlowEdge / ComfyUI / Ollama
 *
 * When the plugin is absent (uninstalled / different machine) this falls back to the minimal
 * grouping below: bucket by executable path only, name tasks after the PE product name, no
 * local engine probing. The degradation is explicit and lands in snapshot.warnings.
 */
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATE_DIR = process.env.VRAM_RADAR_HOME || path.join(os.homedir(), ".workbuddy", "vram-radar");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const HISTORY_FILE = path.join(STATE_DIR, "history.jsonl");
const DEFAULT_DSH_INDEX = path.join(os.homedir(), ".dsh", "plugins", "dsh-gpu-governor", "lib", "index.js");
/* The repository ships the plugin host half next to the engine, so prefer it over
   whatever copy happens to be installed under ~/.dsh; that keeps grouping labels
   in step with this checkout instead of an older install. */
const REPO_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "index.js");
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

/** One line per sample round, accumulated across calls into a trend. On the DSH side it is 200 points in memory; here it is 200 points on disk. */
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
	const candidates = [process.env.VRAM_GOVERNOR_INDEX, REPO_INDEX, DEFAULT_DSH_INDEX]
		.filter((candidate) => typeof candidate === "string" && candidate.length > 0);
	for (const indexPath of candidates) {
		if (!existsSync(indexPath)) continue;
		try {
			const module = await import(pathToFileURL(indexPath).href);
			const helpers = module?.__test;
			if (helpers && typeof helpers.aggregateGroups === "function") return helpers;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/* ---------------------------------------------------------------- fallback grouping */

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
			const label = path.basename(dir) || proc.prod || proc.name || "ungrouped";
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

/* --------------------------------------------------------------- snapshot assembly */

/**
 * @param {object} sample the collector's last raw sample
 * @param {object[]} samples all samples from this round (used for the trend and peaks)
 * @param {{sanitize?: (text: string) => string}} options
 */
export async function buildSnapshot(sample, samples, options = {}) {
	const sanitize = typeof options.sanitize === "function" ? options.sanitize : (text) => text;
	const state = await loadState();
	const helpers = await loadHostHelpers();
	const warnings = [];
	if (helpers === null) warnings.push("DSH GPU Radar plugin not found; degraded to grouping by executable path (no FlowEdge / ComfyUI / Ollama probing)");

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

	// Peaks can only come from this round's samples: WorkBuddy has no long-running process, so no cross-call high-water mark.
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

	// With a single sample, procUtil (delta method) is necessarily 0; fall back to PerfOS _Total.
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
			name: gpu.name ?? "unknown GPU",
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

/** Path sanitizing: screenshots and public pages must not leak the local account name. */
export function makeSanitizer(enabled) {
	if (!enabled) return (text) => text;
	const userName = os.userInfo().username;
	const home = os.homedir();
	const homeWin = home.replace(/\//g, "\\");
	const homePosix = home.replace(/\\/g, "/");

	/**
	 * Some fields are "truncated with an ellipsis" before they reach the sanitizer, e.g. `C:\Users\Administrat…`:
	 * the full home path does not match, the full account name does not match either, and the
	 * account name leaks. So match the whole "user directory root" as
	 * `<parent of home>\<any account fragment>`, which also flattens other accounts on the same
	 * machine — over-sanitizing beats leaking one account name.
	 * Only enabled when home looks like `X:\Users\<name>`; other layouts fall back to literal replacement.
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
