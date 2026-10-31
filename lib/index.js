/**
 * Host half of the GPU governor plugin, deliberately dependency-free.
 *
 * It exposes one Typert Remote service (`gpuGovernor`) with four read/write
 * methods:
 *
 *   snapshot()   - live GPU board state plus the top VRAM consumers, grouped
 *                  into projects, with each group's budget verdict
 *   act()        - suspend / resume / kill one PID, guarded and audited
 *   setBudget()  - pin a VRAM budget (soft quota) on a project key
 *   setPolicy()  - reserve headroom and the sampling cadence
 *
 * Everything the plugin needs comes from the live Host context, because a
 * plugin mounted from outside the installation tree cannot resolve
 * `@deepseek-ai/*` specifiers (see dsh-prompt-enhancer for the same
 * constraint). Data collection is one long-lived PowerShell child that
 * prints a JSON line per sample; see lib/collector.ps1 for why WMI
 * performance classes are the only workable source on Windows WDDM.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, writeFile, appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SERVICE_KEY = "gpuGovernor";
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR_SCRIPT = path.join(HERE, "collector.ps1");
const MANAGE_SCRIPT = path.join(HERE, "manage.ps1");
const STATE_DIR = path.join(os.homedir(), ".dsh", "gpu-governor");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const AUDIT_FILE = path.join(STATE_DIR, "audit.jsonl");
const AUDIT_MAX_BYTES = 512 * 1024;

const POWERSHELL = process.env.SystemRoot
	? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	: "powershell.exe";

const STALE_MS = 15000;
const TOP_LIMIT = 5;
/** Board-level samples kept for the trend chart (~10 minutes at the default cadence). */
const HISTORY_LIMIT = 200;
/** Ceiling on the project list returned for the "show all" view. */
const ALL_LIMIT = 30;

/** Minimal structural stand-in for RemoteError (Gateway discriminates by marker + code). */
class RemoteErrorShim extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = "RemoteError";
		this.code = code;
		this.details = details;
		this.isDSHRemoteError = true;
	}
}

function fail(code, message, details) {
	throw new RemoteErrorShim(code, message, details);
}

/** Read one positive integer with a fallback for absent or invalid values. */
function positiveInt(value, fallback) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
	return value < min ? min : value > max ? max : value;
}

function mib(bytes) {
	return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** MiB -> "12.4G" / "24G": whole gigabytes keep no decimals. */
function gib(mibValue) {
	const value = typeof mibValue === "number" && isFinite(mibValue) ? mibValue : 0;
	const gibs = value / 1024;
	return (Number.isInteger(gibs) ? gibs.toFixed(0) : gibs.toFixed(1)) + "G";
}

function lower(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function truncate(text, limit) {
	if (typeof text !== "string") return "";
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Thin the trend window to `limit` points for the wire. The newest point is
 * always kept so the chart ends at "now" instead of at the last strided sample.
 * @param points - collector history, oldest first.
 * @param limit - maximum points to return.
 * @returns {{t: number, usedMiB: number, utilPct: number}[]}
 */
function thinHistory(points, limit) {
	if (!Array.isArray(points) || points.length === 0) return [];
	const project = (point) => ({
		t: point.t,
		usedMiB: point.usedMiB,
		utilPct: point.utilPct,
		cpuPct: typeof point.cpuPct === "number" ? point.cpuPct : 0,
		ramPct: typeof point.ramPct === "number" ? point.ramPct : 0
	});
	if (points.length <= limit) return points.map(project);
	const step = (points.length - 1) / (limit - 1);
	const out = [];
	for (let index = 0; index < limit; index += 1) {
		out.push(project(points[Math.round(index * step)]));
	}
	out[out.length - 1] = project(points[points.length - 1]);
	return out;
}

/**
 * Long-lived collector child. Each sample is a single JSON line on stdout.
 * A crashed or killed child is restarted with a bounded backoff; the service
 * keeps serving the last good sample and reports staleness instead of failing.
 */
class Collector {
	constructor(options) {
		this.intervalMs = positiveInt(options.intervalMs, 4000);
		this.pidFile = typeof options.pidFile === "string" && options.pidFile.length > 0 ? options.pidFile : null;
		this.child = null;
		this.buffer = "";
		this.latest = null;
		this.latestAt = 0;
		this.stopped = true;
		this.failures = 0;
		this.restartTimer = null;
		this.lastError = null;
		this.elapsedMs = 0;
		/** Board-level samples, newest last (see accept()). */
		this.history = [];
	}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.spawnChild();
	}

	stop() {
		this.stopped = true;
		if (this.restartTimer !== null) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const child = this.child;
		this.child = null;
		if (child !== null && child.exitCode === null && !child.killed) {
			try {
				child.kill();
			} catch {
				/* the child is already gone */
			}
		}
	}

	setInterval(intervalMs) {
		const next = positiveInt(intervalMs, this.intervalMs);
		if (next === this.intervalMs) return;
		this.intervalMs = next;
		if (this.stopped) return;
		// The interval is a script argument: restart to apply it.
		this.stop();
		this.start();
	}

	snapshot() {
		return {
			data: this.latest,
			ageMs: this.latest === null ? Number.POSITIVE_INFINITY : Date.now() - this.latestAt,
			running: !this.stopped && this.child !== null,
			elapsedMs: this.elapsedMs,
			intervalMs: this.intervalMs,
			lastError: this.lastError,
			history: this.history
		};
	}

	spawnChild() {
		if (this.stopped) return;
		const args = [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			COLLECTOR_SCRIPT,
			"-IntervalMs",
			String(this.intervalMs),
			// Lets the collector retire itself when this Host disappears.
			"-ParentPid",
			String(process.pid)
		];
		// Tests point this elsewhere so a probe run cannot steal the live lock.
		if (this.pidFile !== null) args.push("-PidFile", this.pidFile);
		let child;
		try {
			child = spawn(
				POWERSHELL,
				args,
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
			);
		} catch (error) {
			this.scheduleRestart(error instanceof Error ? error.message : String(error));
			return;
		}
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.consume(chunk));
		// The collector writes nothing to stderr on the happy path; keep it out
		// of the parent's console but remember the tail for diagnostics.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text.length > 0) this.lastError = truncate(text, 400);
		});
		child.on("error", (error) => {
			this.lastError = truncate(error.message, 400);
		});
		child.on("exit", (code) => {
			if (this.child === child) this.child = null;
			if (this.stopped) return;
			this.scheduleRestart(`collector exited with code ${String(code)}`);
		});
	}

	scheduleRestart(reason) {
		if (this.stopped) return;
		this.failures += 1;
		this.lastError = truncate(reason, 400);
		const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
		if (this.restartTimer !== null) clearTimeout(this.restartTimer);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.spawnChild();
		}, delay);
		if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
	}

	consume(chunk) {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line.length > 0) this.accept(line);
			index = this.buffer.indexOf("\n");
		}
		// A sample is a few KB; anything past a megabyte means the framing broke.
		if (this.buffer.length > 1024 * 1024) this.buffer = "";
	}

	accept(line) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (parsed === null || typeof parsed !== "object") return;
		this.latest = parsed;
		this.latestAt = Date.now();
		this.elapsedMs = typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0;
		this.failures = 0;
		// Board-level rolling window for the trend chart. Kept to a handful of
		// numbers per point so even a few minutes of history stays a few KB.
		const gpu = Array.isArray(parsed.gpus) ? parsed.gpus[0] : null;
		if (gpu !== null && gpu !== void 0) {
			this.history.push({
				t: this.latestAt,
				usedMiB: Math.round(typeof gpu.memUsed === "number" ? gpu.memUsed : 0),
				utilPct: Math.round(typeof gpu.util === "number" ? gpu.util : 0),
				cpuPct: Math.round(typeof parsed.cpu?.util === "number" ? parsed.cpu.util : 0),
				ramPct: Math.round(typeof parsed.mem?.pct === "number" ? parsed.mem.pct : 0)
			});
			if (this.history.length > HISTORY_LIMIT) this.history.shift();
		}
	}
}

// ---------------------------------------------------------------------------
// Project attribution
//
// "Who is using the GPU" is only useful at project granularity, because one
// training run is often python.exe plus two workers. Attribution walks the
// process's command line for the real path it was launched with and maps it
// onto, in order: a DSH workspace, a Desktop folder, a drive-level project
// directory, or finally the executable's own folder (software).
// ---------------------------------------------------------------------------

const PATH_QUOTED = /"([A-Za-z]:\\[^"]+)"/g;
const PATH_BARE = /(?:^|\s)([A-Za-z]:\\[^\s"]+)/g;
/** Extensions that mean "this path is the work being run", not just an argument. */
const SCRIPT_EXTENSIONS = /\.(py|ipynb|uproject|sln|ps1|sh|bash|js|mjs|cjs|ts|rb|pl|jl)$/i;

/**
 * Launch paths in priority order, split by what they prove.
 *
 * The interpreter always comes first on a command line (`python.exe
 * /opt/ComfyUI/main.py`), and its install folder says nothing about the work.
 * Arguments are worse still: `--user-data-dir=...\AppData\Roaming\@deepseek-ai`
 * would name the app after a config folder. So paths are bucketed as
 *   script  - a .py/.uproject/... argument: the work itself
 *   binary  - the .exe that runs it: names the installed application
 *   arg     - any other path argument: last resort
 * and the rules are applied to script, then binary, then arg.
 * @returns {{scriptDirs: string[], binaryDirs: string[], argDirs: string[]}}
 */
function candidatePaths(proc) {
	const raw = [];
	const cmd = typeof proc.cmd === "string" ? proc.cmd : "";
	let match;
	PATH_QUOTED.lastIndex = 0;
	while ((match = PATH_QUOTED.exec(cmd)) !== null) raw.push(match[1]);
	PATH_BARE.lastIndex = 0;
	while ((match = PATH_BARE.exec(cmd)) !== null) raw.push(match[1]);
	if (typeof proc.exe === "string" && proc.exe.length > 0) raw.push(proc.exe);

	const scriptDirs = [];
	const binaryDirs = [];
	const argDirs = [];
	for (const entry of raw) {
		const normalized = entry.replace(/\//g, "\\").replace(/\\+$/, "");
		if (normalized.length < 4) continue;
		const isBinary = /\.(exe|com|bat|cmd|dll)$/i.test(normalized);
		const isScript = SCRIPT_EXTENSIONS.test(normalized);
		const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(normalized);
		const dir = hasExtension ? path.win32.dirname(normalized) : normalized;
		if (dir.length < 4) continue;
		const bucket = isBinary ? binaryDirs : isScript ? scriptDirs : argDirs;
		if (!bucket.includes(dir)) bucket.push(dir);
	}
	return { scriptDirs, binaryDirs, argDirs };
}

function isUnder(target, root) {
	const a = lower(target.replace(/\//g, "\\"));
	const b = lower(root.replace(/\//g, "\\").replace(/\\+$/, ""));
	if (b.length === 0) return false;
	return a === b || a.startsWith(`${b}\\`);
}

/** Named containers whose first child is the project itself. */
const CONTAINER = /^([A-Za-z]:\\(?:AI|Projects|projects|UEProjects|UnrealProjects|code|Code|models|Models|work|Work|src)\\([^\\]+))/i;
/** Absolute system trees never belong to a user project. */
const SYSTEM_TREE = /^([A-Za-z]:\\(?:Windows|ProgramData)(?:\\|$))/i;
/** First-level folders that are containers, not projects. */
const NOT_A_PROJECT = new Set(["users", "windows", "program files", "program files (x86)", "programdata", "epic", "$recycle.bin", "system volume information"]);

function lastSegment(dir) {
	const parts = dir.split("\\").filter((part) => part.length > 0);
	return parts.length === 0 ? "" : parts[parts.length - 1];
}

/**
 * Derive a stable project key and a human label for one process.
 *
 * Rule order (first hit wins), applied to script paths before binary paths:
 *   1. inside a DSH workspace               -> that workspace
 *   2. under ...\Desktop\<folder>           -> that folder
 *   3. under a named container (AI, UEProjects, Projects, models, ...)
 *                                           -> the container's child
 *   4. an installed application (AppData\Local\Programs, Program Files)
 *                                           -> vendor\product
 *   5. the drive-level folder               -> that folder
 *   6. the executable's own folder          -> last segment
 * @param proc - one collector process entry.
 * @param workspaces - known DSH workspaces ({ key, label, path }).
 * @returns {{key: string, label: string, basis: string, dir: string}}
 */
function attributeProject(proc, workspaces) {
	const { scriptDirs, binaryDirs, argDirs } = candidatePaths(proc);
	const dirs = [...scriptDirs, ...binaryDirs, ...argDirs];

	for (const dir of dirs) {
		for (const workspace of workspaces) {
			if (isUnder(dir, workspace.path)) {
				return { key: workspace.key, label: workspace.label, basis: "workspace", dir };
			}
		}
	}
	for (const dir of dirs) {
		const desktop = /\\Desktop\\([^\\]+)/i.exec(dir);
		if (desktop !== null) {
			const name = desktop[1];
			return { key: `desktop:${lower(name)}`, label: name, basis: "desktop", dir };
		}
	}
	for (const dir of dirs) {
		const container = CONTAINER.exec(dir);
		if (container !== null) {
			const name = container[2];
			return { key: `dir:${lower(container[1])}`, label: name, basis: "path", dir };
		}
	}
	for (const dir of dirs) {
		const programs = /\\Program Files(?: \(x86\))?\\([^\\]+)(?:\\([^\\]+))?/i.exec(dir);
		if (programs !== null) {
			const vendor = programs[1];
			const product = programs[2] !== undefined ? programs[2] : vendor;
			return { key: `app:${lower(product)}`, label: product, basis: "software", dir };
		}
		const localPrograms = /\\AppData\\Local\\Programs\\([^\\]+)/i.exec(dir);
		if (localPrograms !== null) {
			return { key: `app:${lower(localPrograms[1])}`, label: localPrograms[1], basis: "software", dir };
		}
		const roaming = /\\AppData\\Roaming\\([^\\]+)/i.exec(dir);
		if (roaming !== null) {
			return { key: `app:${lower(roaming[1])}`, label: roaming[1], basis: "software", dir };
		}
	}
	for (const dir of dirs) {
		if (SYSTEM_TREE.test(dir)) continue;
		const driveFolder = /^([A-Za-z]:\\([^\\]+))/i.exec(dir);
		if (driveFolder !== null && !NOT_A_PROJECT.has(lower(driveFolder[2]))) {
			const name = driveFolder[2];
			return { key: `root:${lower(driveFolder[1])}`, label: name, basis: "path", dir };
		}
	}
	for (const dir of dirs) {
		if (SYSTEM_TREE.test(dir)) {
			return { key: "system:windows", label: "Windows", basis: "system", dir };
		}
	}
	for (const dir of [...binaryDirs, ...scriptDirs, ...argDirs]) {
		const segment = lastSegment(dir);
		if (segment.length > 0) {
			return { key: `dir:${lower(dir)}`, label: segment, basis: "exe", dir };
		}
	}
	const name = typeof proc.name === "string" && proc.name.length > 0 ? proc.name : `pid ${String(proc.pid)}`;
	return { key: `proc:${lower(name)}`, label: name, basis: "process", dir: "" };
}

const SCRIPT_EXTS = "py|mjs|cjs|js|ts|ipynb|uproject|sln|ps1|bat";

/**
 * The script a command line actually runs, which is the real "work" behind an
 * interpreter. `python.exe /opt/ComfyUI/main.py --port 8189` is not
 * "python"; it is ComfyUI-H3.
 * @param cmd - full command line.
 * @returns the first script/uproject path, or "".
 */
function scriptOf(cmd) {
	if (typeof cmd !== "string" || cmd.length === 0) return "";
	// A separator is required: without it a bare token like `x.com` or a flag
	// value ending in `.js` would be mistaken for the script being run.
	const pattern = new RegExp(`(?:^|[\\s"])([^\\s"]*[\\\\/][^\\s"]*\\.(?:${SCRIPT_EXTS}))\\b`, "i");
	const match = pattern.exec(cmd);
	return match === null ? "" : match[1];
}

/** File name without its directory. */
function baseName(file) {
	if (typeof file !== "string" || file.length === 0) return "";
	const parts = file.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.length === 0 ? "" : parts[parts.length - 1];
}

/** Parent directory name, used to name a script by the project that owns it. */
function containerName(file) {
	if (typeof file !== "string" || file.length === 0) return "";
	const parts = file.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.length < 2 ? "" : parts[parts.length - 2];
}

/** `tts_breeze_server.py` -> `tts breeze server`, which reads as a task. */
function prettyScript(file) {
	return baseName(file).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

/** First two `--flag value` pairs, the cheapest way to say what a process is doing. */
function flagSummary(cmd) {
	if (typeof cmd !== "string") return "";
	const tokens = cmd.split(/\s+/);
	const out = [];
	for (let index = 0; index < tokens.length && out.length < 2; index += 1) {
		const token = tokens[index];
		if (!/^--?[A-Za-z][\w-]*$/.test(token)) continue;
		const next = tokens[index + 1];
		if (next !== undefined && next.length > 0 && !next.startsWith("-")) {
			out.push(`${token.replace(/^-+/, "")}=${truncate(next.replace(/^["']|["']$/g, ""), 40)}`);
			index += 1;
		}
	}
	return out.join(" · ");
}

/**
 * Turn one process into a task identity: never a bare `python.exe`.
 *
 * Priority: a live FlowEdge run (the job itself) → ComfyUI weights → Ollama
 * model → known local services → Unreal/Blender → `interpreter · script`.
 * The workload probe is optional; without it the script name still beats the
 * executable name.
 * @param proc - collector process entry.
 * @param workload - collectWorkload() result or null.
 * @returns {{task: string, sub: string, kind: string}}
 */
/** Windows system processes whose bare names tell a user nothing. */
const SYSTEM_TASKS = {
	dwm: "桌面窗口管理（dwm）",
	csrss: "会话管理（csrss）",
	winlogon: "登录（winlogon）",
	explorer: "资源管理器（explorer）",
	searchhost: "开始菜单搜索",
	textinputhost: "输入法宿主",
	svchost: "系统服务宿主",
	msmpeng: "Defender 扫描",
	sihost: "外壳基础设施",
	audiodg: "音频引擎",
	conhost: "控制台宿主",
	lsass: "安全认证（lsass）",
	services: "服务控制",
	taskhostw: "任务宿主",
	registry: "注册表",
};

/** Electron/Chromium child process kinds, which are otherwise all `name.exe`. */
const CHROMIUM_ROLES = {
	"gpu-process": "GPU 进程",
	renderer: "渲染进程",
	utility: "工具进程",
	zygote: "孵化进程",
	"crashpad-handler": "崩溃收集",
};

/**
 * `--model D:\\OllamaModels\\blobs\\sha256-a0c1…` -> the weight file name.
 * Ollama runs llama-server with a blob path, so this is the only cheap way to
 * say which weights are in memory when the daemon itself is not answering.
 */
function modelFromFlags(cmd) {
	if (typeof cmd !== "string") return "";
	const match = /--model[=\s]+"?([^"\s]+)/i.exec(cmd);
	if (match === null) return "";
	return baseName(match[1].replace(/"$/, "")).replace(/\.(gguf|safetensors|bin)$/i, "");
}

/**
 * Turn one process into a task identity: never a bare `python.exe`.
 *
 * Priority: a live FlowEdge run (the job itself) → an LLM runner and the
 * weights it loaded → ComfyUI checkpoint → Chromium/Electron child role →
 * known local services → Unreal/Blender → Windows system role →
 * `interpreter · script`. The workload probe is optional; without it the
 * script name and flags still beat the executable name.
 * @param proc - collector process entry.
 * @param workload - collectWorkload() result or null.
 * @returns {{task: string, sub: string, kind: string}}
 */
function describeProcess(proc, workload) {
	const cmd = typeof proc.cmd === "string" ? proc.cmd : "";
	const name = typeof proc.name === "string" ? proc.name : "";
	const script = scriptOf(cmd);
	const pretty = script.length > 0 ? prettyScript(script) : "";
	const where = containerName(script);
	const flags = flagSummary(cmd);
	const flowedge = workload?.flowedge ?? null;
	const comfy = Array.isArray(workload?.comfy) ? workload.comfy : [];
	const ollama = workload?.ollama ?? null;
	const exe = typeof proc.exe === "string" ? proc.exe : "";
	const interpreter = name.replace(/\.exe$/i, "");

	// 1. FlowEdge engine: name the live run, not the executable.
	if (/flowedge/i.test(`${name} ${cmd}`) && flowedge !== null) {
		const run = flowedge.runs[0];
		if (run !== undefined) {
			return {
				kind: "job",
				task: `FlowEdge · ${run.pipeline ?? run.pipelineId ?? "run"} #${String(run.id ?? "?")}`,
				sub: [run.status, `${String(run.nodesDone)}/${String(run.nodesTotal)} nodes`, run.prompt ? truncate(run.prompt, 90) : ""].filter((part) => part.length > 0).join(" · ")
			};
		}
		return {
			kind: "engine",
			task: "FlowEdge · idle",
			sub: [flowedge.version, `${String(flowedge.deps.filter((dep) => dep.running).length)} services`].filter((part) => typeof part === "string" && part.length > 0).join(" · ")
		};
	}

	// 2. LLM runner (Ollama's llama-server) and the weights in memory.
	if (/llama-server|llama\.exe|ollama/i.test(name) || /OllamaModels/i.test(cmd)) {
		const resident = ollama?.models?.[0]?.name;
		const model = typeof resident === "string" && resident.length > 0 ? resident : modelFromFlags(cmd);
		if (model.length > 0) {
			return {
				kind: "model",
				task: `Ollama · ${model}`,
				sub: [ollama?.models?.[0]?.vramMiB ? `${(ollama.models[0].vramMiB / 1024).toFixed(1)}G VRAM` : "", flags].filter((part) => part.length > 0).join(" · ")
			};
		}
		return { kind: "engine", task: "Ollama · serve", sub: flags };
	}

	// 3. ComfyUI: the loaded checkpoint is the answer to "what is this".
	const comfyInstance = comfy.find((entry) => {
		const port = typeof entry.endpoint === "string" ? entry.endpoint.split(":").pop() : "";
		return port.length > 0 && cmd.includes(port);
	});
	if (comfyInstance !== undefined || /comfy/i.test(cmd)) {
		const label = comfyInstance?.label ?? (where.length > 0 ? where : "ComfyUI");
		const model = comfyInstance?.models?.[0];
		const weights = (comfyInstance?.weightFiles ?? []).filter((file) => typeof file.bytes === "number");
		const weightGiB = weights.length === 0 ? null : weights.reduce((sum, file) => sum + file.bytes, 0) / (1024 ** 3);
		if (typeof model === "string" && model.length > 0) {
			const kind = comfyInstance?.modelSource === "history" ? "上次运行" : "正在运行";
			return {
				kind: "model",
				task: `${label} · ${path.basename(model)}`,
				sub: [kind, weightGiB === null ? "" : `权重 ${weightGiB.toFixed(1)}G`].filter((part) => part.length > 0).join(" · ")
			};
		}
		return { kind: "engine", task: `${label} · 空闲`, sub: flags };
	}

	// 4. Chromium / Electron child processes: say which role, not which exe.
	const roleMatch = /--type[=\s]+([\w-]+)/i.exec(cmd);
	if (roleMatch !== null && CHROMIUM_ROLES[roleMatch[1]] !== undefined) {
		return {
			kind: "child",
			task: `${interpreter} · ${CHROMIUM_ROLES[roleMatch[1]]}`,
			sub: flags
		};
	}

	// 5. Known local services (their script name is the job).
	if (/tts_breeze|tts_?server|breeze/i.test(`${script} ${name}`)) {
		return { kind: "service", task: "TTS · breeze 语音合成", sub: flags };
	}
	if (/asr_server|whisper/i.test(`${script} ${name}`)) {
		return { kind: "service", task: "ASR · faster-whisper 转写", sub: flags };
	}

	// 6. Unreal / Blender: the project or the script being rendered.
	const uproject = /([^\\/\s"]+\.uproject)/i.exec(cmd);
	if (/unrealeditor|unrealpak|shadercompile/i.test(name)) {
		return {
			kind: "engine",
			task: `UE · ${uproject !== null ? uproject[1].replace(/\.uproject$/i, "") : interpreter}`,
			sub: flags
		};
	}
	if (/blender/i.test(name)) {
		return { kind: "job", task: `Blender · ${pretty.length > 0 ? pretty : "scene"}`, sub: flags };
	}

	// 7. Windows system roles that a bare exe name hides.
	const systemRole = SYSTEM_TASKS[interpreter.toLowerCase()];
	if (systemRole !== undefined && script.length === 0) {
		return { kind: "system", task: systemRole, sub: flags };
	}

	// 8. Anything else: interpreter + the script it runs, never the bare exe.
	if (pretty.length > 0) {
		return { kind: "script", task: `${interpreter} · ${pretty}`, sub: flags };
	}
	const modelFlag = modelFromFlags(cmd);
	if (modelFlag.length > 0) {
		return { kind: "model", task: `${interpreter} · ${modelFlag}`, sub: flags };
	}
	// Executables carry a product name in their PE resources ("网易UU远程服务").
	// Prefer it over a bare exe name when the two actually differ.
	const product = typeof proc.prod === "string" ? proc.prod.trim() : "";
	if (product.length >= 3 && product.toLowerCase() !== interpreter.toLowerCase()) {
		return {
			kind: "app",
			task: product,
			sub: [interpreter, containerName(exe)].filter((part) => typeof part === "string" && part.length > 0).join(" · ")
		};
	}
	// Last resort: the exe name is all we have, so add where it lives — a bare
	// "GameViewer.exe" says nothing, "GameViewer\bin" at least says what it is.
	return {
		kind: "process",
		task: name.length > 0 ? name : `pid ${String(proc.pid)}`,
		sub: flags.length > 0 ? flags : containerName(exe)
	};
}


/**
 * Fold the collector's process list into project groups.
 *
 * Kept pure and exported for tests: the grouping rules, the CPU/RAM sums and
 * the "processes that never touch the GPU still count" decision are the parts
 * that silently break when a new source is added.
 * @param procs - collector process entries ({pid, mem, util, cpu, ram, ...}).
 * @param workspaces - known DSH workspaces.
 * @param suspendedPids - PIDs this session suspended.
 * @returns {groups: Map, trackedBytes, trackedRam}
 */
function aggregateGroups(procs, workspaces, suspendedPids) {
	const groups = new Map();
	let trackedBytes = 0;
	let trackedRam = 0;
	for (const proc of procs) {
		const bytes = typeof proc.mem === "number" ? proc.mem : 0;
		const utilValue = typeof proc.util === "number" ? proc.util : 0;
		const cpuValue = typeof proc.cpu === "number" ? clamp(proc.cpu, 0, 100) : 0;
		const ramBytes = typeof proc.ram === "number" ? proc.ram : 0;
		// The collector also reports CPU/RAM heavy processes that never touch
		// the GPU (Blender, an UnrealEditor cook, a runaway node worker).
		if (bytes <= 0 && utilValue <= 0 && cpuValue <= 0 && ramBytes <= 0) continue;
		const attributed = attributeProject(proc, workspaces);
		trackedBytes += bytes;
		trackedRam += ramBytes;
		let group = groups.get(attributed.key);
		if (group === undefined) {
			group = {
				key: attributed.key,
				// Storefront package ids can be 60 characters; the panel has ~30.
				label: truncate(attributed.label, 44),
				basis: attributed.basis,
				dir: attributed.dir,
				memBytes: 0,
				util: 0,
				cpu: 0,
				ramBytes: 0,
				processes: []
			};
			groups.set(attributed.key, group);
		}
		group.memBytes += bytes;
		group.util += utilValue;
		group.cpu += cpuValue;
		group.ramBytes += ramBytes;
		group.processes.push({
			pid: proc.pid,
			name: proc.name,
			prod: truncate(proc.prod ?? "", 80),
			memMiB: mib(bytes),
			utilPct: clamp(utilValue, 0, 100),
			cpuPct: Math.round(cpuValue * 10) / 10,
			ramMiB: Math.round(ramBytes / (1024 * 1024)),
			suspended: suspendedPids.has(proc.pid),
			alive: proc.dead !== true,
			exe: truncate(proc.exe, 240),
			cmd: truncate(proc.cmd, 320)
		});
	}
	return { groups, trackedBytes, trackedRam };
}

// ---------------------------------------------------------------------------
// Workload attribution: which model or which job sits behind a busy project
//
// Process-level numbers answer "how much"; they never answer "which model".
// For the local generation stack that answer already exists in a service API:
//   FlowEdge   http://127.0.0.1:8080  /api/health /api/deps /api/runs?status=running
//   ComfyUI    <dep endpoint>         /queue (the live prompt graph names its checkpoints)
//   Ollama     http://127.0.0.1:11434 /api/ps (loaded weights + size)
// These probes are strictly best-effort: a closed port, a slow daemon or a
// malformed body must leave the resource numbers untouched and only cost the
// detail section, so every call is bounded in time and size and cached.
// ---------------------------------------------------------------------------

const PROBE_TTL_MS = 3000;
const PROBE_TIMEOUT_MS = 1200;
const PROBE_MAX_BYTES = 512 * 1024;
const FLOWEDGE_BASE_DEFAULT = "http://127.0.0.1:8080";
const OLLAMA_BASE_DEFAULT = "http://127.0.0.1:11434";
/** Response cache: the panel polls every few seconds, the daemons do not change faster. */
const probeCache = new Map();

/**
 * One bounded JSON GET. Never rejects: a probe is an optional enrichment.
 * @param url - absolute http URL.
 * @param options - { timeoutMs, maxBytes }.
 * @returns {ok: true, data} or {ok: false, error}
 */
function httpJson(url, options = {}) {
	const timeoutMs = positiveInt(options.timeoutMs, PROBE_TIMEOUT_MS);
	const maxBytes = positiveInt(options.maxBytes, PROBE_MAX_BYTES);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let request;
		try {
			request = http.get(url, { timeout: timeoutMs }, (response) => {
				if (response.statusCode !== 200) {
					response.resume();
					finish({ ok: false, error: `HTTP ${String(response.statusCode)}` });
					return;
				}
				let size = 0;
				const chunks = [];
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > maxBytes) {
						response.destroy();
						finish({ ok: false, error: "response too large" });
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					try {
						finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
					} catch {
						finish({ ok: false, error: "invalid json" });
					}
				});
			});
		} catch (error) {
			finish({ ok: false, error: truncate(error instanceof Error ? error.message : String(error), 160) });
			return;
		}
		request.on("timeout", () => {
			request.destroy();
			finish({ ok: false, error: "timeout" });
		});
		request.on("error", (error) => {
			finish({ ok: false, error: truncate(error instanceof Error ? error.message : String(error), 160) });
		});
	});
}

/**
 * Cached probe. The TTL keeps a 2.5s panel poll from hammering a local daemon.
 * Note the second argument is a TTL, not a timeout -- use probeJson() when a slow
 * endpoint (ComfyUI /history on a large graph) needs a longer deadline.
 */
async function probe(url, ttlMs = PROBE_TTL_MS) {
	const cached = probeCache.get(url);
	if (cached !== void 0 && Date.now() - cached.at < ttlMs) return cached.value;
	const value = await httpJson(url);
	probeCache.set(url, { at: Date.now(), value });
	if (probeCache.size > 48) {
		const oldest = probeCache.keys().next().value;
		probeCache.delete(oldest);
	}
	return value;
}

/** Model file names a ComfyUI prompt graph references (ckpt / unet / vae / lora). */
const COMFY_MODEL_KEYS = ["ckpt_name", "unet_name", "vae_name", "lora_name", "clip_name", "control_net_name"];
/**
 * Walk one ComfyUI prompt graph and collect the weight files it names.
 * @param graph - { [nodeId]: { class_type, inputs } }.
 * @returns {string[]} unique model file names, at most 8.
 */
function comfyModels(graph) {
	const names = [];
	if (graph === null || typeof graph !== "object") return names;
	for (const node of Object.values(graph)) {
		const inputs = node?.inputs;
		if (inputs === null || typeof inputs !== "object") continue;
		for (const key of COMFY_MODEL_KEYS) {
			const value = inputs[key];
			if (typeof value === "string" && value.length > 0 && !names.includes(value)) names.push(value);
			else if (Array.isArray(value)) {
				for (const entry of value) {
					if (typeof entry === "string" && SCRIPT_EXTENSIONS.test(entry) && !names.includes(entry)) names.push(entry);
				}
			}
			if (names.length >= 8) return names;
		}
	}
	return names;
}

/**
 * Ask the local generation stack what is loaded and running.
 *
 * @param options - { flowedgeBaseUrl, ollamaBaseUrl }.
 * @returns {flowedge, comfy, ollama, probedAt} where every part may be null.
 */
async function collectWorkload(options) {
	const flowedgeBase = options.flowedgeBaseUrl;
	const ollamaBase = options.ollamaBaseUrl;
	const result = {
		probedAt: Date.now(),
		flowedge: null,
		comfy: [],
		ollama: null,
		errors: []
	};

	const health = await probe(`${flowedgeBase}/api/health`);
	if (health.ok && health.data !== null && typeof health.data === "object") {
		const [deps, runs, pipelines] = await Promise.all([
			probe(`${flowedgeBase}/api/deps`),
			probe(`${flowedgeBase}/api/runs?status=running&limit=4`),
			probe(`${flowedgeBase}/api/pipelines`, 15000)
		]);
		const pipelineNames = new Map();
		if (pipelines.ok && Array.isArray(pipelines.data?.pipelines)) {
			for (const row of pipelines.data.pipelines) {
				if (typeof row?.id === "string") pipelineNames.set(row.id, truncate(row.name ?? row.id, 40));
			}
		}
		const depItems = deps.ok && Array.isArray(deps.data?.items) ? deps.data.items : [];
		result.flowedge = {
			base: flowedgeBase,
			version: typeof health.data.version === "string" ? health.data.version : null,
			uptimeSeconds: typeof health.data.uptime_seconds === "number" ? health.data.uptime_seconds : null,
			deps: depItems.slice(0, 24).map((dep) => ({
				name: typeof dep?.name === "string" ? dep.name : "",
				label: truncate(dep?.label ?? dep?.name ?? "", 60),
				running: dep?.running === true,
				state: typeof dep?.state === "string" ? dep.state : "",
				endpoint: typeof dep?.endpoint === "string" ? dep.endpoint : "",
				pid: Number.isInteger(dep?.pid) ? dep.pid : null,
				command: truncate(dep?.command ?? "", 400)
			})),
			runs: runs.ok && Array.isArray(runs.data?.runs) ? runs.data.runs.slice(0, 4).map((run) => {
				const states = Array.isArray(run?.node_states) ? run.node_states : [];
				const done = states.filter((node) => node?.status === "success").length;
				const prompt = typeof run?.params?.prompt === "string" ? run.params.prompt : "";
				return {
					id: run?.id ?? null,
					pipeline: pipelineNames.get(run?.pipeline_id) ?? (typeof run?.pipeline_id === "string" ? run.pipeline_id : null),
					pipelineId: typeof run?.pipeline_id === "string" ? run.pipeline_id : null,
					status: typeof run?.status === "string" ? run.status : "",
					invokedBy: typeof run?.invoked_by === "string" ? run.invoked_by : null,
					startedAt: typeof run?.started_at === "string" ? run.started_at : null,
					nodesDone: done,
					nodesTotal: states.length,
					nodeTypes: [...new Set(states.map((node) => node?.type).filter((type) => typeof type === "string"))].slice(0, 6),
					prompt: truncate(prompt.replace(/\s+/g, " "), 220)
				};
			}) : [],
			depsError: deps.ok ? null : deps.error,
			runsError: runs.ok ? null : runs.error
		};

		// Every running ComfyUI instance: which instance, and what its live prompt loads.
		for (const dep of result.flowedge.deps) {
			if (!dep.running || !/^comfy/i.test(dep.name) || dep.endpoint.length === 0) continue;
			const base = dep.endpoint.replace(/\/$/, "");
			// Three parallel probes: what is queued, how much the device actually holds,
			// and what ran last (an idle ComfyUI keeps those weights resident).
			const [queue, stats, history] = await Promise.all([
				probeJson(`${base}/queue`, { timeoutMs: 2500 }),
				probeJson(`${base}/system_stats`, { timeoutMs: 2500 }),
				probeJson(`${base}/history?max_items=8`, { timeoutMs: 6000, ttlMs: 5000 })
			]);
			const running = queue.ok && Array.isArray(queue.data?.queue_running) ? queue.data.queue_running : [];
			const pending = queue.ok && Array.isArray(queue.data?.queue_pending) ? queue.data.queue_pending : [];
			const liveItem = running[0] ?? pending[0];
			let models = Array.isArray(liveItem) && liveItem.length > 2 ? comfyModels(liveItem[2]) : [];
			let source = models.length > 0 ? "running" : "none";
			let lastRunAt = null;
			if (models.length === 0) {
				const newest = newestHistory(history.ok ? history.data : null);
				if (newest !== null) {
					models = comfyModels(newest.graph);
					lastRunAt = newest.at > 0 ? newest.at : null;
					source = models.length > 0 ? "history" : "none";
				}
			}
			const argc = Array.isArray(stats.data?.system?.argv) ? stats.data.system.argv : [];
			const mainPy = argc.find((entry) => typeof entry === "string" && /main\.py$/i.test(entry));
			const installDir = typeof mainPy === "string" ? path.dirname(mainPy) : null;
			const device = Array.isArray(stats.data?.devices) ? stats.data.devices[0] ?? null : null;
			const weightFiles = [];
			for (const name of models.slice(0, 8)) {
				weightFiles.push({ name, bytes: await comfyWeightBytes(installDir, name) });
			}
			result.comfy.push({
				name: dep.name,
				label: dep.label,
				endpoint: dep.endpoint,
				version: typeof stats.data?.system?.comfyui_version === "string" ? stats.data.system.comfyui_version : null,
				models,
				weightFiles,
				modelSource: source,
				lastRunAt,
				installDir,
				queue: { running: running.length, pending: pending.length },
				device: device === null ? null : {
					vramTotalMiB: Math.round((device.vram_total ?? 0) / (1024 * 1024)),
					vramFreeMiB: Math.round((device.vram_free ?? 0) / (1024 * 1024)),
					torchVramTotalMiB: Math.round((device.torch_vram_total ?? 0) / (1024 * 1024))
				},
				queueError: queue.ok ? null : queue.error,
				statsError: stats.ok ? null : stats.error
			});
		}
	} else if (!health.ok) {
		result.errors.push(`flowedge: ${health.error}`);
	}

	const ps = await probe(`${ollamaBase}/api/ps`);
	if (ps.ok && Array.isArray(ps.data?.models)) {
		result.ollama = {
			base: ollamaBase,
			models: ps.data.models.slice(0, 6).map((model) => ({
				name: typeof model?.name === "string" ? model.name : (typeof model?.model === "string" ? model.model : ""),
				sizeMiB: typeof model?.size === "number" ? Math.round(model.size / (1024 * 1024)) : 0,
				vramMiB: typeof model?.size_vram === "number" ? Math.round(model.size_vram / (1024 * 1024)) : 0
			})).filter((model) => model.name.length > 0)
		};
	}

	return result;
}

/** ComfyUI model folders, in lookup order (a name may also carry a sub-path). */
const COMFY_MODEL_DIRS = [
	"checkpoints", "diffusion_models", "unet", "vae", "clip", "text_encoders",
	"loras", "controlnet", "upscale_models", "clip_vision", "diffusers"
];

/** name -> bytes, resolved once per process. Weights do not change size often. */
const comfyWeightCache = new Map();

/** installDir -> candidate model roots (parsed from extra_model_paths.yaml). */
const comfyRootsCache = new Map();

/**
 * Resolve one weight file's size under a ComfyUI install.
 *
 * Why on disk: /queue and /history name the files but never say how big they are,
 * and "14.2G VRAM" alone does not tell you whether one 12G checkpoint or six 2G
 * LoRAs are responsible. The file size is the part of that VRAM the driver cannot
 * reclaim, so it is the number worth showing.
 */
async function comfyModelRoots(installDir) {
	if (typeof installDir !== "string" || installDir.length === 0) return [];
	const cached = comfyRootsCache.get(installDir);
	if (cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
	const roots = [];
	const base = path.join(installDir, "models");
	for (const dir of COMFY_MODEL_DIRS) roots.push(path.join(base, dir));
	roots.push(base);
	// extra_model_paths.yaml is how real installs keep weights on another drive:
	//   flowedge_models:
	//       base_path: E:/models/comfyui
	//       checkpoints: checkpoints
	//       unet: diffusion_models
	try {
		const text = await readFile(path.join(installDir, "extra_model_paths.yaml"), "utf8");
		let sectionBase = null;
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.replace(/#.*$/, "").trimEnd();
			if (line.trim().length === 0) continue;
			const indent = line.length - line.trimStart().length;
			const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
			if (match === null) continue;
			const key = match[1];
			const value = match[2].trim().replace(/^["']|["']$/g, "");
			if (indent === 0) { sectionBase = null; continue; }
			if (key === "base_path") { sectionBase = value; continue; }
			if (sectionBase !== null && value.length > 0 && !/^(true|false)$/i.test(value)) {
				roots.push(path.resolve(sectionBase, value));
			}
		}
	} catch (_) { /* no extra paths */ }
	comfyRootsCache.set(installDir, { at: Date.now(), value: roots });
	return roots;
}

async function comfyWeightBytes(installDir, name) {
	if (typeof installDir !== "string" || installDir.length === 0) return null;
	if (typeof name !== "string" || name.length === 0) return null;
	const cacheKey = `${installDir}|${name}`;
	const cached = comfyWeightCache.get(cacheKey);
	// Weights rarely change, but they do (re-download, different quant): expire.
	if (cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
	const roots = await comfyModelRoots(installDir);
	const candidates = [];
	for (const root of roots) {
		candidates.push(path.join(root, name));
		if (path.basename(name) !== name) candidates.push(path.join(root, path.basename(name)));
	}
	let bytes = null;
	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isFile()) { bytes = info.size; break; }
		} catch (_) { /* keep looking */ }
	}
	comfyWeightCache.set(cacheKey, { at: Date.now(), value: bytes });
	return bytes;
}

/** Newest ComfyUI history entry as { at, graph }, or null. */
function newestHistory(history) {
	if (history === null || typeof history !== "object") return null;
	let best = null;
	for (const entry of Object.values(history)) {
		const graph = Array.isArray(entry?.prompt) ? entry.prompt[2] : null;
		if (graph === null) continue;
		const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
		const stamp = messages.length > 0 && typeof messages[0]?.[1]?.timestamp === "number"
			? messages[0][1].timestamp
			: 0;
		if (best === null || stamp > best.at) best = { at: stamp, graph };
	}
	return best;
}

/**
 * Same cache, explicit timeout. ComfyUI's /history returns whole prompt graphs and
 * 1.2s is not enough on a loaded machine, which used to make attribution fail quietly.
 */
async function probeJson(url, options = {}) {
	const timeoutMs = positiveInt(options.timeoutMs, 4000);
	const ttlMs = positiveInt(options.ttlMs, PROBE_TTL_MS);
	const cached = probeCache.get(url);
	if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.value;
	const value = await httpJson(url, { timeoutMs, maxBytes: options.maxBytes });
	probeCache.set(url, { at: Date.now(), value });
	if (probeCache.size > 48) {
		const oldest = probeCache.keys().next().value;
		probeCache.delete(oldest);
	}
	return value;
}

/** Does this project group look like the given engine? */
function groupMatches(group, pattern) {
	return pattern.test(lower(`${group.key} ${group.label} ${group.dir}`));
}

/**
 * Compose the "what inside" section for one project group.
 *
 * The shape is deliberately flat ({kind, title, items, models, jobs}) so the
 * panel can render any source without knowing the source's API.
 * @param group - aggregated project group.
 * @param workload - result of collectWorkload().
 * @returns {object|null} null when nothing is known about this project.
 */
function workloadDetail(group, workload) {
	if (workload === null) return null;
	if (groupMatches(group, /flowedge/) && workload.flowedge !== null) {
		const flowedge = workload.flowedge;
		const liveDeps = flowedge.deps.filter((dep) => dep.running);
		const items = [
			{ k: "engine", v: `FlowEdge ${flowedge.version ?? "?"} · up ${formatUptime(flowedge.uptimeSeconds)}` },
			{ k: "services", v: liveDeps.length === 0 ? "none running" : liveDeps.map((dep) => dep.label).join(" · ") },
			{ k: "jobs", v: flowedge.runs.length === 0 ? "idle" : `${String(flowedge.runs.length)} running` }
		];
		const models = [];
		for (const comfy of workload.comfy) {
			models.push({
				name: comfy.label || comfy.name,
				source: `ComfyUI @ ${comfy.endpoint}`,
				detail: comfy.models.length > 0 ? comfy.models.join(" · ") : "no live prompt"
			});
		}
		for (const dep of flowedge.deps) {
			if (!dep.running || /^comfy/i.test(dep.name)) continue;
			models.push({ name: dep.label, source: dep.name, detail: dep.endpoint || dep.state });
		}
		if (workload.ollama !== null) {
			for (const model of workload.ollama.models) {
				models.push({
					name: model.name,
					source: "Ollama",
					detail: `${(model.vramMiB / 1024).toFixed(1)}G VRAM / ${(model.sizeMiB / 1024).toFixed(1)}G`
				});
			}
		}
		const jobs = flowedge.runs.map((run) => ({
			title: `#${String(run.id)} · ${run.pipeline ?? run.pipelineId ?? "run"}`,
			status: run.status,
			progress: run.nodesTotal > 0 ? `${String(run.nodesDone)}/${String(run.nodesTotal)} nodes` : "",
			detail: run.prompt,
			meta: [run.invokedBy, run.nodeTypes.join("/")].filter((part) => typeof part === "string" && part.length > 0).join(" · ")
		}));
		return { kind: "flowedge", title: "FlowEdge", items, models, jobs };
	}
	if (groupMatches(group, /comfy/) && workload.comfy.length > 0) {
		const instance = workload.comfy.find((comfy) => groupMatches(group, new RegExp(lower(comfy.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))))
			?? workload.comfy[0];
		// The row above already says "ComfyUI"; what the user cannot tell is which
		// weights inside it own the VRAM. Answer with sizes, and say how much is left
		// over for activations instead of pretending the split is exact.
		const weightMiB = (instance.weightFiles ?? [])
			.filter((file) => typeof file.bytes === "number")
			.reduce((sum, file) => sum + file.bytes / (1024 * 1024), 0);
		const groupMiB = Number.isFinite(mib(group.memBytes)) ? mib(group.memBytes) : 0;
		const residualMiB = weightMiB > 0 ? Math.max(0, Math.round(groupMiB - weightMiB)) : null;
		const resident = (instance.weightFiles ?? []).length > 0
			? (instance.weightFiles ?? []).map((file) => (typeof file.bytes === "number"
				? `${path.basename(file.name)} ${(file.bytes / (1024 ** 3)).toFixed(1)}G`
				: path.basename(file.name))).join(" · ")
			: (instance.models.length > 0 ? instance.models.join(" · ") : "未取到模型名");
		const ago = instance.lastRunAt === null || instance.lastRunAt === undefined
			? null
			: Math.max(0, Math.round((Date.now() - instance.lastRunAt) / 60000));
		const when = instance.modelSource === "running"
			? "正在跑的任务"
			: instance.modelSource === "history" && ago !== null
				? `上次运行 ${String(ago)} 分钟前（权重通常仍驻留）`
				: "无记录";
		return {
			kind: "comfyui",
			title: instance.label || instance.name,
			items: [
				{ k: "engine", v: `ComfyUI ${instance.version ?? ""}`.trim() },
				{ k: "endpoint", v: instance.endpoint },
				{
					k: "vramUsage",
					v: weightMiB <= 0
						? `本组 ${gib(groupMiB)}（未解析到权重文件大小）`
						: weightMiB > groupMiB * 1.05
							// Bigger than the resident set: ComfyUI streams weights in and out, so the
							// honest statement is "these files, this much on disk", not a split.
							? `本组 ${gib(groupMiB)} · 权重合计 ${gib(Math.round(weightMiB))}，超出部分按需换入`
							: `本组 ${gib(groupMiB)} · 权重约 ${gib(Math.round(weightMiB))}${residualMiB === null ? "" : ` + 激活/缓存约 ${gib(residualMiB)}`}`
				},
				{ k: "resident", v: resident },
				{ k: "modelSource", v: when },
				{
					k: "queue",
					v: instance.queue === undefined || instance.queue === null
						? "—"
						: `${String(instance.queue.running)} 在跑 / ${String(instance.queue.pending)} 排队`
				}
			],
			models: instance.models.map((name) => {
				const file = (instance.weightFiles ?? []).find((entry) => entry.name === name);
				const size = typeof file?.bytes === "number" ? `${(file.bytes / (1024 ** 3)).toFixed(1)}G` : null;
				return {
					name: path.basename(name),
					source: instance.modelSource === "history" ? "上次运行" : "正在运行",
					detail: size === null ? (instance.modelSource === "history" ? "未解析到文件大小" : "") : `${size} 权重文件`
				};
			}),
			jobs: []
		};
	}
	if (groupMatches(group, /ollama/) && workload.ollama !== null) {
		return {
			kind: "ollama",
			title: "Ollama",
			items: [
				{ k: "engine", v: "Ollama" },
				{ k: "endpoint", v: workload.ollama.base },
				{ k: "loaded", v: workload.ollama.models.length === 0 ? "no model resident" : `${String(workload.ollama.models.length)} model(s)` }
			],
			models: workload.ollama.models.map((model) => ({
				name: model.name,
				source: "Ollama",
				detail: `${(model.vramMiB / 1024).toFixed(1)}G VRAM / ${(model.sizeMiB / 1024).toFixed(1)}G`
			})),
			jobs: []
		};
	}
	return null;
}

/**
 * Await a promise but never longer than `ms`; a timeout resolves to null.
 * The timer is unref'd so it can never keep the Host alive on its own.
 */
function withDeadline(promise, ms) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), ms);
		if (typeof timer.unref === "function") timer.unref();
		promise.then(
			(value) => { clearTimeout(timer); finish(value); },
			() => { clearTimeout(timer); finish(null); }
		);
	});
}

/** "3h 12m" from a service uptime in seconds. */
function formatUptime(seconds) {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
	return `${String(minutes)}m`;
}



// ---------------------------------------------------------------------------
// Persisted state (budgets + policy) and the audit trail
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
	version: 1,
	budgets: {},
	policy: {
		reservedMiB: 2048
	}
};

async function loadState() {
	try {
		const text = await readFile(STATE_FILE, "utf8");
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return structuredClone(DEFAULT_STATE);
		return {
			version: 1,
			budgets: parsed.budgets !== null && typeof parsed.budgets === "object" ? { ...parsed.budgets } : {},
			policy: {
				reservedMiB: typeof parsed.policy?.reservedMiB === "number" ? parsed.policy.reservedMiB : DEFAULT_STATE.policy.reservedMiB
			}
		};
	} catch {
		return structuredClone(DEFAULT_STATE);
	}
}

async function saveState(state) {
	await mkdir(STATE_DIR, { recursive: true });
	const temporary = `${STATE_FILE}.${String(process.pid)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rename(temporary, STATE_FILE);
}

async function audit(entry) {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		try {
			const info = await stat(AUDIT_FILE);
			if (info.size > AUDIT_MAX_BYTES) await rename(AUDIT_FILE, `${AUDIT_FILE}.1`);
		} catch {
			/* first write */
		}
		await appendFile(AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		/* auditing must never break a control action */
	}
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function createService(ctx, config) {
	const resolved = config ?? {};
	const collector = new Collector({ intervalMs: config?.intervalMs ?? 4000, pidFile: config?.pidFile });
	/** Local generation stack endpoints (FlowEdge engine, Ollama) for detail probes. */
	const probeServices = resolved.probeServices !== false;
	const flowedgeBaseUrl = typeof resolved.flowedgeBaseUrl === "string" && resolved.flowedgeBaseUrl.length > 0
		? resolved.flowedgeBaseUrl
		: (process.env.FLOWEDGE_BASE_URL || FLOWEDGE_BASE_DEFAULT);
	const ollamaBaseUrl = typeof resolved.ollamaBaseUrl === "string" && resolved.ollamaBaseUrl.length > 0
		? resolved.ollamaBaseUrl
		: (process.env.OLLAMA_BASE_URL || OLLAMA_BASE_DEFAULT);
	let state = structuredClone(DEFAULT_STATE);
	let stateReady = null;
	let workspaceCache = { at: 0, list: [] };
	/** PIDs this session suspended, so the panel can offer "resume". */
	const suspendedPids = new Set();
	/** Last snapshot's GPU PIDs: the allow-list for control actions. */
	let controlAllowList = new Set();
	/** Session high-water mark per project key, in MiB. */
	const peaks = new Map();
	/** Last snapshot's project key -> PIDs, so a project action can address all of them. */
	let groupPids = new Map();

	const ensureState = async () => {
		if (stateReady === null) stateReady = loadState().then((loaded) => { state = loaded; return state; });
		return stateReady;
	};

	const workspaceList = () => {
		const now = Date.now();
		if (now - workspaceCache.at < 30000) return workspaceCache.list;
		const list = [];
		try {
			const registry = ctx.get("workspaceRegistry");
			const rows = typeof registry?.list === "function" ? registry.list() : [];
			for (const row of rows) {
				const dir = row?.path ?? row?.directory ?? row?.rootPath ?? row?.root;
				if (typeof dir !== "string" || dir.length < 4) continue;
				const label = typeof row.title === "string" && row.title.length > 0 ? row.title : lastSegment(dir);
				list.push({ key: `ws:${lower(dir).replace(/\\+$/, "")}`, label, path: dir });
			}
		} catch {
			/* workspace attribution is best-effort */
		}
		workspaceCache = { at: now, list };
		return list;
	};

	const buildSnapshot = async () => {
		await ensureState();
		const sample = collector.snapshot();
		const workspaces = workspaceList();
		const policy = state.policy;
		const budgets = state.budgets;

		const data = sample.data;
		const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
		const procs = Array.isArray(data?.procs) ? data.procs : [];

		const { groups, trackedBytes, trackedRam } = aggregateGroups(procs, workspaces, suspendedPids);

		// Rank by VRAM first (the panel's original question); every row carries the
		// CPU and RAM meters too, so the client can re-sort without a second call.
		const ordered = [...groups.values()].sort((a, b) => (b.memBytes - a.memBytes) || (b.cpu - a.cpu));
		const hiddenMiB = mib(ordered.slice(TOP_LIMIT).reduce((sum, group) => sum + group.memBytes, 0));
		const totalMem = ordered.reduce((sum, group) => sum + group.memBytes, 0);

		const projectRow = (group, withProcesses) => {
			const budgetMiB = typeof budgets[group.key] === "number" ? budgets[group.key] : null;
			const memMiB = mib(group.memBytes);
			if (withProcesses) group.processes.sort((a, b) => (b.memMiB - a.memMiB) || (b.cpuPct - a.cpuPct));
			return {
				key: group.key,
				label: group.label,
				basis: group.basis,
				dir: truncate(group.dir, 200),
				memMiB,
				utilPct: Math.round(clamp(group.util, 0, 100) * 10) / 10,
				cpuPct: Math.round(clamp(group.cpu, 0, 100) * 10) / 10,
				ramMiB: Math.round(group.ramBytes / (1024 * 1024)),
				share: totalMem > 0 ? Math.round((group.memBytes / totalMem) * 1000) / 10 : 0,
				peakMiB: peaks.get(group.key) ?? memMiB,
				budgetMiB,
				overBudget: budgetMiB !== null && memMiB > budgetMiB,
				processCount: group.processes.length,
				taskLabel: group.taskLabel ?? "",
				taskSub: group.taskSub ?? "",
				processes: withProcesses ? group.processes.slice(0, 8) : []
			};
		};

		// Probe first: the task identity of a process depends on what the local
		// engines say is loaded or running. A dead or hanging daemon must never
		// delay the resource numbers, so the whole probe has a hard deadline.
		const workload = probeServices ? await withDeadline(collectWorkload({ flowedgeBaseUrl, ollamaBaseUrl }), 2500) : null;

		// Every process gets a "what is this actually doing" label, and each group
		// inherits the label of its heaviest member — never a bare python.exe.
		for (const group of ordered) {
			for (const proc of group.processes) {
				const described = describeProcess(proc, workload);
				proc.task = described.task;
				proc.sub = described.sub;
				proc.kind = described.kind;
			}
			const lead = group.processes.reduce((best, proc) => {
				if (best === null) return proc;
				if (proc.memMiB > best.memMiB) return proc;
				if (proc.memMiB === best.memMiB && proc.cpuPct > best.cpuPct) return proc;
				return best;
			}, null);
			group.taskLabel = lead === null ? "" : lead.task;
			group.taskSub = lead === null ? "" : lead.sub;
			const detail = workload === null ? null : workloadDetail(group, workload);
			if (detail !== null) group.detail = detail;
		}

		const projects = ordered.slice(0, ALL_LIMIT).map((group) => projectRow(group, true));
		// Kept for a panel build that predates `projects`.
		const top = projects.slice(0, TOP_LIMIT);
		const all = projects.map((row) => {
			const copy = { ...row };
			delete copy.processes;
			delete copy.detail;
			return copy;
		});

		// Session peaks: remembered per project so the panel can show how close a
		// past run came to filling the card, not just the current instant.
		for (const group of ordered) {
			const memMiB = mib(group.memBytes);
			const previous = peaks.get(group.key);
			if (previous === void 0 || memMiB > previous) peaks.set(group.key, memMiB);
		}
		groupPids = new Map(ordered.map((group) => [group.key, group.processes.map((proc) => proc.pid)]));

		controlAllowList = new Set(procs.map((proc) => proc.pid));

		const primary = gpus[0] ?? null;
		const usedMiB = primary === null ? 0 : Math.round(primary.memUsed);
		const totalMiB = primary === null ? 0 : Math.round(primary.memTotal);
		const freeMiB = Math.max(0, totalMiB - usedMiB);
		const reservedMiB = Math.max(0, Math.round(policy.reservedMiB));
		const stale = sample.ageMs > STALE_MS || data === null;

		// CPU + RAM meters. Per-core values arrive every other round (they cost
		// ~280ms); the panel draws them as a core grid, so jitter is invisible.
		const cpuRaw = data?.cpu ?? null;
		const memRaw = data?.mem ?? null;
		const coreList = Array.isArray(cpuRaw?.cores)
			? cpuRaw.cores.slice(0, 128).map((value) => clamp(Math.round(value), 0, 100))
			: [];
		const cpuSection = cpuRaw === null && memRaw === null ? null : {
			// procUtil is the per-process delta total, refreshed every round; the
			// PerfOS counter is the fallback and the cross-check.
			utilPct: clamp(typeof cpuRaw?.procUtil === "number" ? cpuRaw.procUtil : (cpuRaw?.util ?? 0), 0, 100),
			osUtilPct: clamp(typeof cpuRaw?.util === "number" ? cpuRaw.util : 0, 0, 100),
			cores: coreList,
			coreCount: coreList.length,
			logicalCores: typeof data?.cores === "number" ? data.cores : (coreList.length || 1),
			ram: memRaw === null ? null : {
				totalMiB: Math.round(typeof memRaw.totalMB === "number" ? memRaw.totalMB : 0),
				usedMiB: Math.round(typeof memRaw.usedMB === "number" ? memRaw.usedMB : 0),
				pct: clamp(typeof memRaw.pct === "number" ? memRaw.pct : 0, 0, 100)
			}
		};

		return {
			generatedAt: new Date().toISOString(),
			stale,
			ageMs: Number.isFinite(sample.ageMs) ? Math.round(sample.ageMs) : null,
			error: data === null ? sample.lastError ?? "collector has not produced a sample yet" : null,
			collector: {
				running: sample.running,
				intervalMs: sample.intervalMs,
				sampleMs: Math.round(sample.elapsedMs ?? 0),
				lastError: sample.lastError
			},
			gpu: primary === null
				? null
				: {
					index: primary.index,
					name: primary.name,
					totalMiB,
					usedMiB,
					freeMiB,
					utilPct: clamp(primary.util, 0, 100),
					tempC: primary.tempC,
					powerW: primary.powerW
				},
			headroomMiB: Math.max(0, freeMiB - reservedMiB),
			reservedMiB,
			// Reserve scheduling: a board-sized suggestion beats a number someone typed once.
			reserveSuggestedMiB: clamp(Math.round(totalMiB * 0.06), 512, 4096),
			// How much of the board is spoken for right now, as a 3-step pressure level.
			pressure: totalMiB <= 0 ? "idle" : totalMiB - usedMiB <= 0 ? "crit" : usedMiB / totalMiB >= 0.92 ? "crit" : usedMiB / totalMiB >= 0.8 ? "warn" : "ok",
			overBudgetCount: ordered.filter((group) => {
				const budget = budgets[group.key];
				return typeof budget === "number" && mib(group.memBytes) > budget;
			}).length,
			cpu: cpuSection,
			trackedMiB: mib(trackedBytes),
			trackedRamMiB: Math.round(trackedRam / (1024 * 1024)),
			processCount: procs.length,
			groupCount: ordered.length,
			hiddenMiB,
			history: thinHistory(sample.history, 120),
			projects,
			workloads: workload === null ? null : {
				probedAt: workload.probedAt,
				flowedge: workload.flowedge === null ? null : {
					base: workload.flowedge.base,
					version: workload.flowedge.version,
					uptimeSeconds: workload.flowedge.uptimeSeconds,
					runningDeps: workload.flowedge.deps.filter((dep) => dep.running).map((dep) => dep.label),
					runningJobs: workload.flowedge.runs.length
				},
				comfy: workload.comfy.map((comfy) => ({ name: comfy.name, endpoint: comfy.endpoint, models: comfy.models })),
				ollama: workload.ollama === null ? 0 : workload.ollama.models.length,
				errors: workload.errors
			},
			top,
			all,
			budgets: { ...budgets },
			policy: { reservedMiB },
			suspendedPids: [...suspendedPids]
		};
	};

	const runManage = (action, pid) => new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let child;
		try {
			child = spawn(
				POWERSHELL,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", MANAGE_SCRIPT, "-Action", action, "-ProcessId", String(pid)],
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
			);
		} catch (error) {
			finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
			return;
		}
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => {});
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* already gone */ }
			finish({ ok: false, message: "control script timed out" });
		}, 15000);
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ ok: false, message: error.message });
		});
		child.on("exit", () => {
			clearTimeout(timer);
			const line = out.split("\n").map((part) => part.trim()).filter((part) => part.length > 0).pop();
			if (line === undefined) {
				finish({ ok: false, message: "control script produced no result" });
				return;
			}
			try {
				finish(JSON.parse(line));
			} catch {
				finish({ ok: false, message: truncate(line, 300) });
			}
		});
	});

	const killProcess = (pid) => new Promise((resolve) => {
		let child;
		try {
			child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
			return;
		}
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { out += chunk; });
		child.on("error", (error) => resolve({ ok: false, message: error.message }));
		child.on("exit", (code) => resolve({
			ok: code === 0,
			message: code === 0 ? "terminated" : truncate(out.trim(), 300) || `taskkill exited with code ${String(code)}`
		}));
	});

	/** Guard: only PIDs we just observed on the GPU, and never this Host. */
	const assertControllable = (pid) => {
		if (!Number.isInteger(pid) || pid <= 8) fail("gpu-governor/bad-pid", "the process id is not a controllable process", { pid });
		const self = process.pid;
		if (pid === self || pid === process.ppid) {
			fail("gpu-governor/protected", "refusing to control the Harness host process", { pid });
		}
		if (!controlAllowList.has(pid)) {
			fail("gpu-governor/unknown-pid", "that process is not in the current GPU snapshot; refresh and retry", { pid });
		}
	};

	const proto = {};

	/**
	 * Live board state plus the top VRAM consumers, grouped into projects.
	 * @returns board state, ranked groups (with per-process detail and budget
	 *          verdicts), and the active policy.
	 */
	proto.snapshot = async function snapshot() {
		return buildSnapshot();
	};

	/**
	 * Control GPU processes, either one PID or every process of one project.
	 *
	 * suspend freezes the work (VRAM stays held), resume unfreezes it, kill
	 * terminates it and actually frees its VRAM. A project request runs the
	 * action over each member process and reports how many took it.
	 * @param request - { pid, action } or { project, action }, plus `label`.
	 * @param signal - client cancellation (declared in the wire descriptor).
	 * @returns the outcome, with `applied`/`failed` counts for project actions.
	 */
	proto.act = async function act(request, signal) {
		if (signal !== void 0) signal.throwIfAborted();
		const action = request?.action;
		if (action !== "suspend" && action !== "resume" && action !== "kill") {
			fail("gpu-governor/bad-action", "action must be suspend, resume or kill", { action });
		}
		const project = typeof request?.project === "string" ? request.project : null;
		const single = Number.isInteger(request?.pid) ? request.pid : null;

		const applyOne = async (pid) => {
			const result = action === "kill" ? await killProcess(pid) : await runManage(action, pid);
			if (action === "suspend" && result.ok) suspendedPids.add(pid);
			if ((action === "resume" || action === "kill") && result.ok) suspendedPids.delete(pid);
			return result;
		};

		if (project !== null) {
			const pids = groupPids.get(project) ?? [];
			if (pids.length === 0) {
				fail("gpu-governor/unknown-project", "that project has no processes in the current snapshot; refresh and retry", { project });
			}
			let applied = 0;
			let failed = 0;
			let lastMessage = "";
			for (const pid of pids) {
				// Guard each member: the snapshot may have moved since the last poll.
				if (!controlAllowList.has(pid) || pid <= 8 || pid === process.pid || pid === process.ppid) {
					failed += 1;
					lastMessage = "some processes are no longer controllable";
					continue;
				}
				const result = await applyOne(pid);
				if (result.ok === true) applied += 1;
				else {
					failed += 1;
					lastMessage = truncate(result.message, 300);
				}
			}
			await audit({
				at: new Date().toISOString(),
				action: `${action}-project`,
				project,
				applied,
				failed,
				label: truncate(request?.label, 120)
			});
			const past = action === "resume" ? "resumed" : action === "suspend" ? "suspended" : "killed";
			return {
				ok: applied > 0 && failed === 0,
				action,
				project,
				applied,
				failed,
				message: failed === 0 ? `${String(applied)} process(es) ${past}` : lastMessage
			};
		}

		assertControllable(single);
		const result = await applyOne(single);
		await audit({
			at: new Date().toISOString(),
			action,
			pid: single,
			label: truncate(request?.label, 120),
			ok: result.ok === true,
			message: truncate(result.message, 300)
		});
		return { ok: result.ok === true, action, pid: single, applied: result.ok === true ? 1 : 0, failed: result.ok === true ? 0 : 1, message: truncate(result.message, 300) };
	};

	/**
	 * Pin a soft VRAM budget on one project key; 0 or null clears it.
	 * @param request - { project, budgetMiB }.
	 * @returns the full budget table after the change.
	 */
	proto.setBudget = async function setBudget(request, signal) {
		if (signal !== void 0) signal.throwIfAborted();
		await ensureState();
		const project = typeof request?.project === "string" ? request.project.trim() : "";
		if (project.length === 0) fail("gpu-governor/bad-project", "a project key is required", {});
		const budgetMiB = request?.budgetMiB;
		if (budgetMiB === null || budgetMiB === 0) {
			delete state.budgets[project];
		} else {
			if (typeof budgetMiB !== "number" || !Number.isFinite(budgetMiB) || budgetMiB < 0) {
				fail("gpu-governor/bad-budget", "budgetMiB must be a non-negative number", { budgetMiB });
			}
			state.budgets[project] = Math.round(budgetMiB);
		}
		await saveState(state);
		await audit({
			at: new Date().toISOString(),
			action: budgetMiB === null || budgetMiB === 0 ? "budget-clear" : "budget-set",
			project,
			budgetMiB: state.budgets[project] ?? null
		});
		return { ok: true, budgets: { ...state.budgets } };
	};

	/**
	 * Update the reserve headroom kept out of allocatable VRAM.
	 * @param request - { reservedMiB }.
	 * @returns the policy after the change.
	 */
	proto.setPolicy = async function setPolicy(request, signal) {
		if (signal !== void 0) signal.throwIfAborted();
		await ensureState();
		if (typeof request?.reservedMiB === "number" && Number.isFinite(request.reservedMiB)) {
			state.policy.reservedMiB = Math.max(0, Math.round(request.reservedMiB));
			await saveState(state);
			await audit({ at: new Date().toISOString(), action: "policy-set", reservedMiB: state.policy.reservedMiB });
		}
		return { ok: true, policy: { ...state.policy } };
	};

	Object.defineProperty(proto, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([
				Object.freeze({ method: "snapshot", invocation: Object.freeze({ kind: "direct" }) }),
				Object.freeze({ method: "act", invocation: Object.freeze({ kind: "direct" }) }),
				Object.freeze({ method: "setBudget", invocation: Object.freeze({ kind: "direct" }) }),
				Object.freeze({ method: "setPolicy", invocation: Object.freeze({ kind: "direct" }) })
			])
		})
	});

	const service = Object.create(proto);
	service.ctx = ctx;
	service.name = SERVICE_KEY;
	service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
	service.stop = () => collector.stop();
	service.start = () => collector.start();
	service.setInterval = (intervalMs) => collector.setInterval(intervalMs);
	return service;
}

const name = "gpu-governor";

/**
 * Mount the GPU governor service.
 * @param ctx - plugin context.
 * @param config - row configuration ({ intervalMs }).
 * @returns the disposer owned by this plugin's fiber.
 */
function apply(ctx, config) {
	const service = createService(ctx, config);
	// Sampling starts after the loader settles so a slow first WMI query never
	// delays plugin activation.
	const startTimer = setTimeout(() => {
		try {
			service.start();
		} catch {
			/* the service degrades to "no sample" and reports the error */
		}
	}, 250);
	if (typeof startTimer.unref === "function") startTimer.unref();
	const dispose = ctx.reflect.provide(SERVICE_KEY, service);
	return async () => {
		clearTimeout(startTimer);
		try {
			service.stop();
		} catch {
			/* best effort */
		}
		return dispose();
	};
}

export { apply, name };

/**
 * Pure helpers exported for the offline test harness (tools/test-plugin.mjs).
 * They are not part of the Remote surface and never reach the wire.
 */
export const __test = Object.freeze({
	attributeProject,
	aggregateGroups,
	candidatePaths,
	comfyModels,
	comfyWeightBytes,
	newestHistory,
	workloadDetail,
	collectWorkload,
	describeProcess,
	scriptOf,
	flagSummary,
	httpJson,
	probe,
	thinHistory,
	deleteProbeCache: () => probeCache.clear()
});




