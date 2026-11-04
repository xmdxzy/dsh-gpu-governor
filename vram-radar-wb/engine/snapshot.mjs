#!/usr/bin/env node
/**
 * 显存雷达 · WorkBuddy 版引擎（CLI）
 *
 *   node engine/snapshot.mjs --brief            一行徽标 + 排名，给对话用（默认）
 *   node engine/snapshot.mjs --json             完整快照 JSON
 *   node engine/snapshot.mjs --emit-web         把这次采样写进 web/data/snapshot.js
 *   node engine/snapshot.mjs --brief --raw      不脱敏（默认脱敏：C:\Users\you）
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
		lines.push("● 显存雷达 · 没读到显卡（nvidia-smi 无输出）");
	} else {
		const pct = gpu.totalMiB > 0 ? Math.round((gpu.usedMiB / gpu.totalMiB) * 100) : 0;
		const pressure = { ok: "正常", warn: "偏紧", crit: "告急", idle: "空闲" }[snapshot.pressure] ?? snapshot.pressure;
		lines.push(`● 显存雷达 · ${gpu.name}`);
		lines.push(`显存 ${gib(gpu.usedMiB)} / ${gib(gpu.totalMiB)}（${pct}% · ${pressure}）· 显卡 ${gpu.utilPct}%${gpu.tempC === null ? "" : ` · ${gpu.tempC}°C`}${gpu.powerW === null ? "" : ` · ${Math.round(gpu.powerW)}W`}`);
	}
	if (cpu !== null && cpu.ram !== null) {
		lines.push(`处理器 ${cpu.utilPct}%（${cpu.coreCount} 核）· 内存 ${gib(cpu.ram.usedMiB)} / ${gib(cpu.ram.totalMiB)}（${cpu.ram.pct}%）`);
	}
	lines.push(`可分配 ${gib(snapshot.headroomMiB)}（保留 ${gib(snapshot.reservedMiB)}）· ${snapshot.processCount} 个进程 / ${snapshot.groupCount} 个项目 · 采样 ${snapshot.collector.sampleMs}ms`);

	if (snapshot.overBudgetCount > 0) lines.push(`⚠ ${snapshot.overBudgetCount} 个项目超预算`);
	lines.push("");
	lines.push("谁在吃显存");
	const rows = snapshot.projects.slice(0, 8);
	const labelWidth = Math.min(22, Math.max(10, ...rows.map((row) => [...row.label].length)));
	const taskWidth = Math.min(34, Math.max(12, ...rows.map((row) => [...row.taskLabel].length)));
	rows.forEach((row, index) => {
		const rank = String(index + 1).padStart(2, "0");
		const mem = `${Math.round(row.memMiB)}M`.padStart(6);
		const share = `${Math.round(row.share)}%`.padStart(4);
		const flag = row.overBudget ? " 超预算" : "";
		lines.push(`${rank} ${pad(row.label, labelWidth)} ${pad(row.taskLabel, taskWidth)} ${mem} ${share}${flag}`);
	});
	if (snapshot.projects.length > rows.length) {
		lines.push(`   其余 ${snapshot.projects.length - rows.length} 个项目合计 ${gib(snapshot.hiddenMiB)}`);
	}
	for (const warning of snapshot.warnings ?? []) lines.push(`\n⚠ ${warning}`);
	lines.push(`\n快照 ${snapshot.generatedAt} · 面板 node engine/snapshot.mjs --emit-web`);
	return lines.join("\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.mode === "help") {
		console.log("用法：node engine/snapshot.mjs [--brief|--json|--emit-web] [--raw] [--samples N] [--deadline MS] [--out PATH]");
		return;
	}
	const collected = await collect({ wantSamples: options.samples, deadlineMs: options.deadline });
	if (collected.samples.length === 0) {
		console.error(collected.error ?? "采集失败：没有样本");
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
		console.log(`已写入 ${out}（${(payload.length / 1024).toFixed(0)}KB）`);
		console.log(`面板：${path.join(ROOT, "web", "index.html")}`);
		return;
	}
	console.log(brief(snapshot));
}

main().catch((error) => {
	console.error(`显存雷达失败：${error?.message ?? error}`);
	process.exit(1);
});
