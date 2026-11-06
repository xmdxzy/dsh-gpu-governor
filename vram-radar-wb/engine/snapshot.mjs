#!/usr/bin/env node
/**
 * VRAM Radar · WorkBuddy engine (CLI)
 *
 *   node engine/snapshot.mjs --brief            one-line badge + ranking for chat (default)
 *   node engine/snapshot.mjs --json             full snapshot JSON
 *   node engine/snapshot.mjs --emit-web         write this sample into web/data/snapshot.js
 *   node engine/snapshot.mjs --brief --raw      no sanitizing (default: C:\Users\you)
 *   node engine/snapshot.mjs --samples 4 --deadline 18000
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.mjs";
import { buildSnapshot, makeSanitizer } from "./normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function parseArgs(argv) {
	const options = { mode: "brief", samples: 3, deadline: 16000, raw: false, out: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.mode = "json";
		else if (arg === "--brief") options.mode = "brief";
		else if (arg === "--emit-web") options.mode = "web";
		else if (arg === "--raw") options.raw = true;
		else if (arg === "--samples") options.samples = Math.max(1, Number(argv[++index]) || 3);
		else if (arg === "--deadline") options.deadline = Math.max(2000, Number(argv[++index]) || 16000);
		else if (arg === "--out") options.out = argv[++index] ?? null;
		else if (arg === "--help" || arg === "-h") options.mode = "help";
	}
	return options;
}

const gib = (value) => `${(value / 1024).toFixed(1)}G`;
const pad = (text, width) => String(text).padEnd(width, " ");

function brief(snapshot) {
	const lines = [];
	const gpu = snapshot.gpu;
	const cpu = snapshot.cpu;
	if (gpu === null) {
		lines.push("● VRAM Radar · no GPU detected (nvidia-smi returned nothing)");
	} else {
		const pct = gpu.totalMiB > 0 ? Math.round((gpu.usedMiB / gpu.totalMiB) * 100) : 0;
		const pressure = { ok: "ok", warn: "tight", crit: "critical", idle: "idle" }[snapshot.pressure] ?? snapshot.pressure;
		lines.push(`● VRAM Radar · ${gpu.name}`);
		lines.push(`VRAM ${gib(gpu.usedMiB)} / ${gib(gpu.totalMiB)} (${pct}% · ${pressure}) · GPU ${gpu.utilPct}%${gpu.tempC === null ? "" : ` · ${gpu.tempC}°C`}${gpu.powerW === null ? "" : ` · ${Math.round(gpu.powerW)}W`}`);
	}
	if (cpu !== null && cpu.ram !== null) {
		lines.push(`CPU ${cpu.utilPct}% (${cpu.coreCount} cores) · RAM ${gib(cpu.ram.usedMiB)} / ${gib(cpu.ram.totalMiB)} (${cpu.ram.pct}%)`);
	}
	lines.push(`Headroom ${gib(snapshot.headroomMiB)} (reserved ${gib(snapshot.reservedMiB)}) · ${snapshot.processCount} processes / ${snapshot.groupCount} projects · sample ${snapshot.collector.sampleMs}ms`);

	if (snapshot.overBudgetCount > 0) lines.push(`⚠ ${snapshot.overBudgetCount} projects over budget`);
	lines.push("");
	lines.push("Who is using VRAM");
	const rows = snapshot.projects.slice(0, 8);
	const labelWidth = Math.min(22, Math.max(10, ...rows.map((row) => [...row.label].length)));
	const taskWidth = Math.min(34, Math.max(12, ...rows.map((row) => [...row.taskLabel].length)));
	rows.forEach((row, index) => {
		const rank = String(index + 1).padStart(2, "0");
		const mem = `${Math.round(row.memMiB)}M`.padStart(6);
		const share = `${Math.round(row.share)}%`.padStart(4);
		const flag = row.overBudget ? " over budget" : "";
		lines.push(`${rank} ${pad(row.label, labelWidth)} ${pad(row.taskLabel, taskWidth)} ${mem} ${share}${flag}`);
	});
	if (snapshot.projects.length > rows.length) {
		lines.push(`   ${snapshot.projects.length - rows.length} more projects, ${gib(snapshot.hiddenMiB)} combined`);
	}
	for (const warning of snapshot.warnings ?? []) lines.push(`\n⚠ ${warning}`);
	lines.push(`\nSnapshot ${snapshot.generatedAt} · panel node engine/snapshot.mjs --emit-web`);
	return lines.join("\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.mode === "help") {
		console.log("Usage: node engine/snapshot.mjs [--brief|--json|--emit-web] [--raw] [--samples N] [--deadline MS] [--out PATH]");
		return;
	}
	const collected = await collect({ wantSamples: options.samples, deadlineMs: options.deadline });
	if (collected.samples.length === 0) {
		console.error(collected.error ?? "collection failed: no samples");
		process.exit(1);
	}
	const sample = collected.samples.at(-1);
	const sanitize = makeSanitizer(!options.raw);
	const snapshot = await buildSnapshot(sample, collected.samples, { sanitize, intervalMs: 1200 });

	if (options.mode === "json") {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	if (options.mode === "web") {
		const out = options.out ?? path.join(ROOT, "web", "data", "snapshot.js");
		const payload = `window.__VRAM_SNAPSHOT__ = ${JSON.stringify(snapshot)};\n`;
		await writeFile(out, payload, "utf8");
		console.log(`Wrote ${out} (${(payload.length / 1024).toFixed(0)}KB)`);
		console.log(`Panel: ${path.join(ROOT, "web", "index.html")}`);
		return;
	}
	console.log(brief(snapshot));
}

main().catch((error) => {
	console.error(`VRAM Radar failed: ${error?.message ?? error}`);
	process.exit(1);
});
