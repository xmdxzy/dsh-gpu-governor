#!/usr/bin/env node
/**
 * 显存雷达 · 本机实时服务
 *
 *   node web/server.mjs                 → http://127.0.0.1:4711（每 3 秒按需重采）
 *   node web/server.mjs --port 4800     → 换端口
 *   node web/server.mjs --once          → 只采一次，之后当静态站用
 *   node web/server.mjs --raw           → 不脱敏（默认把 C:\Users\<你> 换成 C:\Users\you）
 *
 * 采集是「拉起 PowerShell 采集器 → 收够 3 个样本 → 杀掉子进程」的一次性动作，
 * 冷启第一行约 6.5 秒（WMI 类首次加载），所以默认按 3 秒轮询时用缓存兜住，
 * 上一份快照随时可读，绝不排队等采集。
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../engine/collect.mjs";
import { buildSnapshot, makeSanitizer } from "../engine/normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".md": "text/markdown; charset=utf-8"
};

function parseArgs(argv) {
	const options = { port: 4711, once: false, raw: false, interval: 3000, samples: 3 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--port") options.port = Number(argv[++index]) || options.port;
		else if (arg === "--once") options.once = true;
		else if (arg === "--raw") options.raw = true;
		else if (arg === "--interval") options.interval = Math.max(1000, Number(argv[++index]) || 3000);
		else if (arg === "--samples") options.samples = Math.max(1, Number(argv[++index]) || 3);
		else if (arg === "--help" || arg === "-h") options.help = true;
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
	console.log("用法：node web/server.mjs [--port 4711] [--once] [--raw] [--interval 3000] [--samples 3]");
	process.exit(0);
}

const sanitize = makeSanitizer(!options.raw);
const cache = { snapshot: null, at: 0, error: null, inflight: null };

async function sample() {
	const collected = await collect({ wantSamples: options.samples, deadlineMs: 20000 });
	if (collected.samples.length === 0) throw new Error(collected.error || "采集失败：没有样本");
	const snapshot = await buildSnapshot(collected.samples.at(-1), collected.samples, { sanitize, intervalMs: 1200 });
	return snapshot;
}

function refresh() {
	if (cache.inflight !== null) return cache.inflight;
	cache.inflight = sample()
		.then((snapshot) => {
			cache.snapshot = snapshot;
			cache.at = Date.now();
			cache.error = null;
			return snapshot;
		})
		.catch((error) => {
			cache.error = error.message;
			throw error;
		})
		.finally(() => { cache.inflight = null; });
	return cache.inflight;
}

function safePath(urlPath) {
	const clean = decodeURIComponent(urlPath.split("?")[0]);
	const target = path.resolve(HERE, `.${clean === "/" ? "/index.html" : clean}`);
	if (!target.startsWith(HERE)) return null;
	return target;
}

async function serveStatic(response, urlPath) {
	const target = safePath(urlPath);
	if (target === null) {
		response.writeHead(403).end("forbidden");
		return;
	}
	try {
		const body = await readFile(target);
		response.writeHead(200, {
			"content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff"
		});
		response.end(body);
	} catch {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
	}
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
	const pathname = url.pathname;

	if (pathname === "/api/health") {
		response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify({ ok: true, ageMs: cache.at ? Date.now() - cache.at : null, error: cache.error }));
		return;
	}

	if (pathname === "/api/snapshot") {
		try {
			if (cache.snapshot === null) await refresh();
			else if (!options.once && Date.now() - cache.at > options.interval && cache.inflight === null) refresh().catch(() => {});
			response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			response.end(JSON.stringify({ ...cache.snapshot, live: true }));
		} catch (error) {
			response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: error.message }));
		}
		return;
	}

	if (pathname === "/api/refresh") {
		try {
			const snapshot = await refresh();
			response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ ok: true, generatedAt: snapshot.generatedAt }));
		} catch (error) {
			response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ ok: false, error: error.message }));
		}
		return;
	}

	await serveStatic(response, pathname);
});

process.stdout.write("显存雷达 · 首次采样中（冷启约 7 秒）…\n");
try {
	const first = await refresh();
	const gpu = first.gpu;
	process.stdout.write(`  ${gpu ? `${gpu.name} · ${(gpu.usedMiB / 1024).toFixed(1)}G / ${(gpu.totalMiB / 1024).toFixed(1)}G` : "未读到显卡"} · ${first.processCount} 进程 / ${first.groupCount} 项目\n`);
} catch (error) {
	process.stdout.write(`  采样失败：${error.message}（服务仍会启动，页面显示上一份或空态）\n`);
}

server.listen(options.port, "127.0.0.1", () => {
	process.stdout.write(`显存雷达 · http://127.0.0.1:${options.port}  ${options.once ? "静态模式" : `每 ${options.interval}ms 按需重采`}${options.raw ? " · 未脱敏" : ""}\n`);
	process.stdout.write("  停止：Ctrl+C\n");
});
