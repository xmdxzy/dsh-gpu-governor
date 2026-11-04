/**
 * 采集层：拉起 PowerShell 采集器，收够样本就收工。
 *
 * 采集器本身是 DSH 插件的常驻进程设计（一行 JSON / 一轮），这里只做
 * 一次性使用：读到 wantSamples 行或撞上 deadline 就杀掉子进程。
 * 实测（本机 72 线程 / 31–34 个有显存进程）：
 *   第 1 行 +6.5s（WMI 类首次加载 + 720 个 GPUEngine 实例）
 *   之后每行 ~1.0s（-IntervalMs 1500 时）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = process.env.VRAM_COLLECTOR || path.join(HERE, "collector.ps1");
const POWERSHELL = process.env.SystemRoot
	? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	: "powershell.exe";

/**
 * @param {{wantSamples?: number, deadlineMs?: number, intervalMs?: number, onSample?: Function}} options
 * @returns {Promise<{samples: object[], elapsedMs: number, error: string|null}>}
 */
export function collect(options = {}) {
	const wantSamples = options.wantSamples ?? 3;
	const deadlineMs = options.deadlineMs ?? 16000;
	const intervalMs = options.intervalMs ?? 1200;
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const samples = [];
		let buffer = "";
		let settled = false;
		let stderrTail = "";
		const pidFile = path.join(os.tmpdir(), `vram-radar-${process.pid}.pid`);

		const finish = (error) => {
			if (settled) return;
			settled = true;
			try { child.kill(); } catch { /* already gone */ }
			clearTimeout(timer);
			resolve({ samples, elapsedMs: Date.now() - startedAt, error: error ?? null });
		};

		const child = spawn(POWERSHELL, [
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-File", COLLECTOR, "-IntervalMs", String(intervalMs), "-PidFile", pidFile
		], { windowsHide: true });

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line.startsWith("{")) continue;
				let sample;
				try { sample = JSON.parse(line); } catch { continue; }
				samples.push(sample);
				if (typeof options.onSample === "function") options.onSample(sample);
				if (samples.length >= wantSamples) return finish(null);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-800); });
		child.on("error", (error) => finish(`采集器启动失败：${error.message}`));
		child.on("exit", () => {
			if (samples.length > 0) return finish(null);
			finish(`采集器没有输出样本${stderrTail.trim() === "" ? "" : `：${stderrTail.trim()}`}`);
		});

		const timer = setTimeout(() => {
			if (samples.length > 0) return finish(null);
			finish(`采集超时（${Math.round(deadlineMs / 1000)}s 内没有样本）`);
		}, deadlineMs);
	});
}

export { COLLECTOR, POWERSHELL, HERE };
