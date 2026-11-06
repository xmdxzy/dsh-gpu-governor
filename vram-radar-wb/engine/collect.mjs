/**
 * Collection layer: spawns the PowerShell collector and stops once it has enough samples.
 *
 * The collector itself is designed as a long-running process for the DSH plugin (one JSON
 * line per round); here it is one-shot: once wantSamples lines arrive, or the deadline
 * hits, the child process is killed.
 * Measured (this machine: 72 threads / 31–34 processes holding VRAM):
 *   first line +6.5s (first WMI class load + 720 GPUEngine instances)
 *   ~1.0s per line after that (-IntervalMs 1500)
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
		child.on("error", (error) => finish(`collector failed to start: ${error.message}`));
		child.on("exit", () => {
			if (samples.length > 0) return finish(null);
			finish(`collector produced no samples${stderrTail.trim() === "" ? "" : `: ${stderrTail.trim()}`}`);
		});

		const timer = setTimeout(() => {
			if (samples.length > 0) return finish(null);
			finish(`collection timed out (no samples within ${Math.round(deadlineMs / 1000)}s)`);
		}, deadlineMs);
	});
}

export { COLLECTOR, POWERSHELL, HERE };
