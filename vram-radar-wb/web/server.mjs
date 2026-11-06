#!/usr/bin/env node
/**
 * VRAM Radar · local live server
 *
 *   node web/server.mjs                 → http://127.0.0.1:4711 (re-samples on demand every 3s)
 *   node web/server.mjs --port 4800     → different port
 *   node web/server.mjs --once          → sample once, then serve as a static site
 *   node web/server.mjs --raw           → no sanitizing (default: C:\Users\<you> becomes C:\Users\you)
 *
 * Sampling is one-shot: "spawn the PowerShell collector → collect 3 samples → kill the child".
 * The first cold line takes ~6.5 seconds (first WMI class load), so the default 3s polling is
 * backed by cache: the previous snapshot is always readable, nothing ever queues behind a sample.
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
	console.log("Usage: node web/server.mjs [--port 4711] [--once] [--raw] [--interval 3000] [--samples 3]");
	process.exit(0);
}

const sanitize = makeSanitizer(!options.raw);
const cache = { snapshot: null, at: 0, error: null, inflight: null };

async function sample() {
	const collected = await collect({ wantSamples: options.samples, deadlineMs: 20000 });
	if (collected.samples.length === 0) throw new Error(collected.error || "collection failed: no samples");
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

process.stdout.write("VRAM Radar · first sample in progress (cold start ~7s)…\n");
try {
	const first = await refresh();
	const gpu = first.gpu;
	process.stdout.write(`  ${gpu ? `${gpu.name} · ${(gpu.usedMiB / 1024).toFixed(1)}G / ${(gpu.totalMiB / 1024).toFixed(1)}G` : "no GPU detected"} · ${first.processCount} processes / ${first.groupCount} projects\n`);
} catch (error) {
	process.stdout.write(`  sampling failed: ${error.message} (the server still starts; the page shows the previous snapshot or the empty state)\n`);
}

server.listen(options.port, "127.0.0.1", () => {
	process.stdout.write(`VRAM Radar · http://127.0.0.1:${options.port}  ${options.once ? "static mode" : `re-sampling on demand every ${options.interval}ms`}${options.raw ? " · unsanitized" : ""}\n`);
	process.stdout.write("  Stop: Ctrl+C\n");
});
