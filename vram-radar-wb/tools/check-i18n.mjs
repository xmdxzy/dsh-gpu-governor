#!/usr/bin/env node
/**
 * 双语字典自检（零依赖）
 *
 *   node tools/check-i18n.mjs
 *
 * 做四件事：
 *   1. in-memory 加载 web/assets/i18n.js，确认两套字典键位一致（漏译会在面板上显示成键名）；
 *   2. 逐个键用两套语言渲染一次，确认非空、且没有残留未替换的 {变量}（带变量的键除外）；
 *   3. 扫 web/index.html 里的 data-i18n* 属性，确认每个键都在字典里；
 *   4. 扫 web/assets/app.js 里的 T("...") 调用，确认每个键都在字典里。
 * 退出码 0 = 通过，1 = 有问题（明细打到 stderr）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warn = (message) => errors.push(message);

/* ---------------------------------------------------------- 1. 加载字典 */
const source = await readFile(path.join(ROOT, "web/assets/i18n.js"), "utf8");
const sandbox = {
  console,
  localStorage: null,
  document: {
    readyState: "complete",
    documentElement: { lang: "" },
    title: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {}
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "i18n.js" });

const I18N = sandbox.window.VRAM_I18N;
if (!I18N) {
  console.error("i18n.js 没有挂出 window.VRAM_I18N");
  process.exit(1);
}

/* 字典本体是闭包里的，只能通过 keys + 渲染探针间接校验：
   切到每种语言，用每个键渲染一次。带 {变量} 的键先喂一组假值。 */

const KEYS = I18N.keys;
const langs = I18N.LANGS;
if (langs.join(",") !== "en,zh") warn(`LANGS 应为 en,zh，实际 ${langs.join(",")}`);
if (I18N.DEFAULT_LANG !== "en") warn(`默认语言应为 en，实际 ${I18N.DEFAULT_LANG}`);
if (I18N.lang !== "en") warn(`首次加载语言应为 en，实际 ${I18N.lang}`);

const samples = { count: 2, value: "12.3G", time: "2026-11-04 12:00", name: "x", list: "a / b", n: 2, processes: 3, groups: 4, temp: "60°C", power: "210W", free: "3.1G", avail: "2.0G", total: "24.0G", used: "1.2G", pct: "50%", util: "90%", headroom: "5G", reserved: "1.4G", min: 8, sum: "0.2G", samples: 3, interval: 1200, sample: 900, shown: 2, seconds: 30, minutes: 5, others: 3, rest: "20%", label: "x", share: "50%", freeable: "2G", suggested: "1.5G", extra: "0.5G", span: 30, delta: "1G", from: "1G", to: "2G", over: "1G", left: "1G", gpu: "RTX", task: "t", mem: "1G", cpu: "5%", ram: "40%" };

const rendered = { en: new Map(), zh: new Map() };
for (const lang of langs) {
  I18N.setLang(lang);
  for (const key of KEYS) {
    /* 先空跑一次拿到模板，再按模板里的变量名喂假值重跑 */
    let value;
    try { value = I18N.t(key); } catch (error) { warn(`[${lang}] ${key} 渲染抛错：${error.message}`); continue; }
    const vars = {};
    for (const match of String(value).matchAll(/\{(\w+)\}/g)) vars[match[1]] = samples[match[1]] ?? "X";
    if (Object.keys(vars).length) {
      try { value = I18N.t(key, vars); } catch (error) { warn(`[${lang}] ${key} 渲染抛错：${error.message}`); continue; }
    }
    if (typeof value !== "string" || value.trim() === "") warn(`[${lang}] ${key} 为空`);
    if (value === key) warn(`[${lang}] ${key} 缺失（回落到键名）`);
    if (/\{[a-zA-Z]+\}/.test(value)) warn(`[${lang}] ${key} 有未替换变量：${value}`);
    rendered[lang].set(key, value);
  }
}
I18N.setLang("en");

if (rendered.en.size !== rendered.zh.size) {
  warn(`两套字典键数不一致：en=${rendered.en.size} zh=${rendered.zh.size}`);
}

/* 中文里混着整段英文，多半是漏翻（命令、产品名、单位除外，这里只列出可疑项供人工过一眼） */
const ALLOW_ENGLISH = /^(PID|CPU|VRAM|GPU|RAM|MiB|G|%|Ctrl|FlowEdge|ComfyUI|Ollama|DSH|WorkBuddy|node)/;
const suspects = [];
for (const [key, text] of rendered.zh) {
  const plain = String(text).replace(/<[^>]+>/g, " ").replace(/\{[^}]+\}/g, " ");
  if (!/[\u4e00-\u9fa5]/.test(plain) && /[A-Za-z]{4,}/.test(plain) && !ALLOW_ENGLISH.test(plain.trim())) {
    suspects.push(`${key} → ${plain.trim().slice(0, 60)}`);
  }
}

/* ---------------------------------------------------------- 2. index.html 键 */
const html = await readFile(path.join(ROOT, "web/index.html"), "utf8");
const attrKeys = new Set();
for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-aria-label|-title)?="([^"]+)"/g)) {
  attrKeys.add(match[1]);
}
for (const key of attrKeys) {
  if (!KEYS.includes(key)) warn(`index.html 用到的键不在字典里：${key}`);
}

/* ---------------------------------------------------------- 3. app.js 键 */
const app = await readFile(path.join(ROOT, "web/assets/app.js"), "utf8");
const codeKeys = new Set();
for (const match of app.matchAll(/\bT\(\s*"([\w.]+)"/g)) codeKeys.add(match[1]);
for (const key of codeKeys) {
  if (!KEYS.includes(key)) warn(`app.js 用到的键不在字典里：${key}`);
}

/* 动态键前缀：T(`pressure.${level}`) / `detail.${key}` / `basis.${basis}` / `sort.${state.sort}` */
const dynamicPrefixes = new Set();
for (const match of app.matchAll(/`([a-z][\w]*)\.\$\{/g)) dynamicPrefixes.add(`${match[1]}.`);
for (const prefix of dynamicPrefixes) {
  if (!KEYS.some((key) => key.startsWith(prefix))) warn(`app.js 动态键前缀没有对应条目：${prefix}*`);
}

/* app.js 里以字符串字面量传参的键（renderHowto 的 title/body/desc、DETAIL_KEYS、BASIS_KEYS） */
const literalKeys = new Set();
for (const match of app.matchAll(/["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g)) literalKeys.add(match[1]);
for (const key of literalKeys) {
  if (key.includes(".") && KEYS.includes(key)) codeKeys.add(key);
}
/* i18n.js 自己也会用键（applyStatic 里的 meta.title / meta.desc / lang.label） */
for (const match of source.matchAll(/["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g)) {
  if (KEYS.includes(match[1])) codeKeys.add(match[1]);
}

/* ---------------------------------------------------------- 报告 */
const isDynamic = (key) => [...dynamicPrefixes].some((prefix) => key.startsWith(prefix));
const unused = KEYS.filter((key) => !attrKeys.has(key) && !codeKeys.has(key) && !isDynamic(key));
console.log(`字典键：${KEYS.length}（en/zh 对齐 ${rendered.en.size}/${rendered.zh.size}）`);
console.log(`index.html 引用：${attrKeys.size} 个键`);
console.log(`app.js 引用：${codeKeys.size} 个键`);
if (suspects.length) {
  console.log(`\n中文可能漏翻 ${suspects.length} 处（人工过一眼）：`);
  suspects.forEach((line) => console.log(`  - ${line}`));
}
if (unused.length) {
  console.log(`\n字典里未被引用的键 ${unused.length} 个（可能是模板遗留，确认后可删）：`);
  unused.forEach((key) => console.log(`  - ${key}`));
}
if (errors.length) {
  console.error(`\n✗ ${errors.length} 个问题：`);
  errors.forEach((line) => console.error(`  - ${line}`));
  process.exit(1);
}
console.log("\n✓ 双语字典自检通过");
