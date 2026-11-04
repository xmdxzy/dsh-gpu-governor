#!/usr/bin/env node
/**
 * 中英切换验收（CDP → 本机 Edge Dev）
 *
 *   node docs/lookdev/verify-i18n-cdp.mjs
 *
 * 检查：默认英文 → 切中文 → 切回英文；行内明细 / 搜索命中 / 判读卡标签都跟着走。
 * 截图落在 docs/lookdev/i18n/。任一项不符即退出码 1。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "i18n");
const PORT = 9444;
const TARGET = "http://127.0.0.1:4711/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on("error", reject);
});

async function openCdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30000);
  });
  return { call, close: () => ws.close() };
}

const failures = [];
const check = (label, actual, expected) => {
  const ok = expected === null ? Boolean(actual) : actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${actual}${expected === null ? "" : ` (期望 ${expected})`}`);
  if (!ok) failures.push(`${label}: ${actual}`);
};
const evalInPage = async (cdp, expression) => {
  const result = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`页面执行抛错：${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
};

await mkdir(OUT, { recursive: true });

const PROFILE = path.join(os.tmpdir(), `vram-i18n-cdp-${Date.now()}`);

const browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
  [`--remote-debugging-port=${PORT}`, "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--user-data-dir=${PROFILE}`, "--window-size=1440,1280", TARGET], { stdio: "ignore", detached: true });
browser.unref();

let page;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    page = targets.find((item) => item.type === "page" && String(item.url).includes("4711")) || targets.find((item) => item.type === "page");
    if (page?.webSocketDebuggerUrl) break;
  } catch { /* 还没起来 */ }
  await sleep(400);
}
if (!page?.webSocketDebuggerUrl) { console.error("拿不到调试页面"); process.exit(1); }

const cdp = await openCdp(page.webSocketDebuggerUrl);
await cdp.call("Page.enable");
await cdp.call("Runtime.enable");
await cdp.call("Page.navigate", { url: TARGET });
await sleep(1600);
/* 清掉上次留下的语言选择，保证「默认英文」这一测的是真默认 */
await evalInPage(cdp, `(() => { localStorage.removeItem("vram-radar/lang/v1"); return localStorage.length; })()`);
await cdp.call("Page.navigate", { url: TARGET });
await sleep(3200);

async function shot(name) {
  const { data } = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(data, "base64"));
  console.log("  截图 →", file);
}

const probe = `(() => {
  const text = (selector) => (document.querySelector(selector)?.textContent || "").trim();
  const langbtn = document.getElementById("langbtn");
  return {
    lang: document.documentElement.lang,
    title: document.title,
    langnow: text("#langnow"),
    boardTitle: text(".board-head h2"),
    gaugeLabel: text(".gauge .gname"),
    judgeTitle: text(".judge-head h3"),
    searchPlaceholder: document.getElementById("search").getAttribute("placeholder"),
    sorted: document.getElementById("sorttabs").textContent.replace(/\\s+/g, " ").trim(),
    howtoFirst: text(".howto h3")
  };
})()`;

console.log("\n[默认语言]");
let probe1 = await evalInPage(cdp, probe);
console.log(probe1);
check("默认语言=en", probe1.lang, "en");
check("右上角按钮=EN", probe1.langnow, "EN");
check("排行标题英文", probe1.boardTitle.includes("Who's on the GPU"), true);
check("圆表标签英文", probe1.gaugeLabel, "GPU utilization");
check("判读标题英文", probe1.judgeTitle, "Verdict");
check("搜索框占位英文", probe1.searchPlaceholder.startsWith("Search"), true);
check("排序三档英文", probe1.sorted.includes("VRAM") && probe1.sorted.includes("Share"), true);
check("说明卡片英文", probe1.howtoFirst.includes("/vram-radar"), true);
await shot("01-default-en.png");

console.log("\n[切到中文]");
await evalInPage(cdp, `(() => { document.getElementById("langbtn").click(); return true; })()`);
await sleep(150);
const opened = await evalInPage(cdp, `document.getElementById("langmenu").hidden === false`);
check("菜单展开", opened, true);
await evalInPage(cdp, `(() => { document.querySelector('#langmenu [data-lang="zh"]').click(); return true; })()`);
await sleep(500);
let probe2 = await evalInPage(cdp, probe);
console.log(probe2);
check("切后语言=zh-CN", probe2.lang, "zh-CN");
check("右上角按钮=中文", probe2.langnow, "中文");
check("排行标题中文", probe2.boardTitle.includes("谁在占用显卡"), true);
check("圆表标签中文", probe2.gaugeLabel, "显卡利用率");
check("判读标题中文", probe2.judgeTitle, "判读");
check("搜索框占位中文", probe2.searchPlaceholder.startsWith("搜"), true);
check("说明卡片中文", probe2.howtoFirst.includes("/vram-radar"), true);
await shot("02-switched-zh.png");

console.log("\n[行内明细 / 搜索命中 随语言]");
const rowCheck = await evalInPage(cdp, `(() => {
  const row = document.querySelector("article.row");
  row?.querySelector("button.rowhead")?.click();
  const head = document.querySelector(".dcard-head");
  const budget = document.querySelector(".budget b");
  return {
    runtime: (document.querySelector(".dgrid .dcard-head")?.textContent || "").trim(),
    budgetLabel: (budget?.textContent || "").trim(),
    processesLabel: (document.querySelector(".rowhead + .rtask")?.textContent || "").slice(0, 0),
    rmetaFirst: (document.querySelector(".rmeta span")?.textContent || "").trim()
  };
})()`);
console.log(rowCheck);
check("明细卡英文→中文：运行概况", rowCheck.runtime.includes("运行概况"), true);
check("预算标签中文", rowCheck.budgetLabel, "预算");
check("行元信息中文", rowCheck.rmetaFirst.includes("进程"), true);

const searchCheck = await evalInPage(cdp, `(() => {
  const input = document.getElementById("search");
  input.value = "comfy";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return {
    hits: document.getElementById("fieldcount").textContent,
    count: document.getElementById("boardcount").textContent
  };
})()`);
console.log(searchCheck);
check("命中计数中文", searchCheck.hits.includes("命中"), true);
check("筛选计数中文", searchCheck.count.includes("个项目"), true);
await shot("03-zh-drill.png");

console.log("\n[切回英文 + 还原搜索]");
await evalInPage(cdp, `(() => { document.getElementById("langbtn").click(); return true; })()`);
await sleep(150);
await evalInPage(cdp, `(() => { document.querySelector('#langmenu [data-lang="en"]').click(); return true; })()`);
await sleep(500);
await evalInPage(cdp, `(() => {
  const input = document.getElementById("search");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(300);
const probe3 = await evalInPage(cdp, probe);
check("切回 en", probe3.lang, "en");
check("排行标题回到英文", probe3.boardTitle.includes("Who's on the GPU"), true);
check("命中计数已隐藏", await evalInPage(cdp, `document.getElementById("fieldcount").hidden`), true);
await shot("04-back-to-en.png");

console.log("\n[窄屏 390px 不横向滚动]");
await cdp.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const overflow = await evalInPage(cdp, `(() => {
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, overflow };
})()`);
console.log(overflow);
check("窄屏无横向溢出", overflow.overflow <= 1, true);
await shot("05-en-mobile390.png");
await evalInPage(cdp, `window.VRAM_I18N.setLang("zh")`);
await sleep(500);
await shot("06-zh-mobile390.png");
await cdp.call("Emulation.clearDeviceMetricsOverride");

console.log("\n[刷新后仍保持选择]");
await evalInPage(cdp, `window.VRAM_I18N.setLang("zh")`);
await cdp.call("Page.navigate", { url: TARGET });
await sleep(3200);
const afterReload = await evalInPage(cdp, probe);
check("刷新后仍是 zh-CN", afterReload.lang, "zh-CN");
check("刷新后排行标题仍是中文", afterReload.boardTitle.includes("谁在占用显卡"), true);
check("刷新后圆表标签仍是中文", afterReload.gaugeLabel, "显卡利用率");
await shot("07-zh-reload-persisted.png");

console.log("\n[残留键名 / 未替换变量 / 占位符]");
const leaks = await evalInPage(cdp, `(() => {
  const dict = window.VRAM_I18N.keys;
  const text = document.body.innerText;
  const found = new Set();
  for (const key of dict) {
    /* 键名只在 HTML 里出现才算漏译：body.innerText 是渲染后的可见文本 */
    if (text.includes(key)) found.add(key);
  }
  const braces = text.match(/\\{[a-zA-Z][a-zA-Z0-9]*\\}/g) || [];
  return { leakedKeys: [...found], unreplacedVars: braces, zhPlain: (text.match(/[\\u4e00-\\u9fa5]/g) || []).length };
})()`);
console.log(leaks);
check("渲染文本里没有漏译键名", leaks.leakedKeys.length, 0);
check("渲染文本里没有未替换变量", leaks.unreplacedVars.length, 0);
check("中文渲染确实有汉字", leaks.zhPlain > 50, true);

console.log("\n[英文页面无漏译键名]");
await evalInPage(cdp, `window.VRAM_I18N.setLang("en")`);
await sleep(400);
const leaksEn = await evalInPage(cdp, `(() => {
  const text = document.body.innerText;
  return { leakedKeys: window.VRAM_I18N.keys.filter((key) => text.includes(key)),
           unreplacedVars: text.match(/\\{[a-zA-Z][a-zA-Z0-9]*\\}/g) || [] };
})()`);
console.log(leaksEn);
check("英文页面无漏译键名", leaksEn.leakedKeys.length, 0);
check("英文页面无未替换变量", leaksEn.unreplacedVars.length, 0);

await cdp.call("Runtime.evaluate", { expression: `window.close()` });
cdp.close();
/* 收尾：关掉调试实例（headless 下 Browser.close 不一定干净，直接按 PID 杀进程树），
   然后删掉这次用的临时 profile。 */
await new Promise((resolve) => {
  const killer = spawn("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
  killer.on("exit", resolve);
  killer.on("error", resolve);
  setTimeout(resolve, 5000);
});
await sleep(600);
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});

console.log(`\n${failures.length ? `✗ ${failures.length} 项不符` : "✓ 全部通过"}`);
if (failures.length) failures.forEach((line) => console.error("  -", line));
process.exit(failures.length ? 1 : 0);
