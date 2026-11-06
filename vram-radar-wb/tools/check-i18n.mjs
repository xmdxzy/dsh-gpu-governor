#!/usr/bin/env node
/**
 * Bilingual dictionary self-check (zero dependencies)
 *
 *   node tools/check-i18n.mjs
 *
 * Does four things:
 *   1. loads web/assets/i18n.js in memory, confirming both dictionaries agree on keys (a missing translation shows up as a key name on the panel);
 *   2. renders every key once per language, confirming it is non-empty and has no unreplaced {vars} left (keys that take variables excepted);
 *   3. scans the data-i18n* attributes in web/index.html, confirming every key exists in the dictionary;
 *   4. scans the T("...") calls in web/assets/app.js, confirming every key exists in the dictionary.
 * Exit code 0 = pass, 1 = problems (details go to stderr).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warn = (message) => errors.push(message);

/* ---------------------------------------------------------- 1. load dictionary */
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
  console.error("i18n.js did not expose window.VRAM_I18N");
  process.exit(1);
}

/* The dictionary itself lives in a closure, so it can only be checked indirectly
   through keys + render probes: switch to each language and render every key once.
   Keys with {vars} are fed a set of fake values first. */

const KEYS = I18N.keys;
const langs = I18N.LANGS;
if (langs.join(",") !== "en,zh") warn(`LANGS should be en,zh, got ${langs.join(",")}`);
if (I18N.DEFAULT_LANG !== "en") warn(`default language should be en, got ${I18N.DEFAULT_LANG}`);
if (I18N.lang !== "en") warn(`first-load language should be en, got ${I18N.lang}`);

const samples = { count: 2, value: "12.3G", time: "2026-11-04 12:00", name: "x", list: "a / b", n: 2, processes: 3, groups: 4, temp: "60°C", power: "210W", free: "3.1G", avail: "2.0G", total: "24.0G", used: "1.2G", pct: "50%", util: "90%", headroom: "5G", reserved: "1.4G", min: 8, sum: "0.2G", samples: 3, interval: 1200, sample: 900, shown: 2, seconds: 30, minutes: 5, others: 3, rest: "20%", label: "x", share: "50%", freeable: "2G", suggested: "1.5G", extra: "0.5G", span: 30, delta: "1G", from: "1G", to: "2G", over: "1G", left: "1G", gpu: "RTX", task: "t", mem: "1G", cpu: "5%", ram: "40%" };

const rendered = { en: new Map(), zh: new Map() };
for (const lang of langs) {
  I18N.setLang(lang);
  for (const key of KEYS) {
    /* Render once bare to get the template, then re-render feeding fake values for its variables */
    let value;
    try { value = I18N.t(key); } catch (error) { warn(`[${lang}] ${key} threw on render: ${error.message}`); continue; }
    const vars = {};
    for (const match of String(value).matchAll(/\{(\w+)\}/g)) vars[match[1]] = samples[match[1]] ?? "X";
    if (Object.keys(vars).length) {
      try { value = I18N.t(key, vars); } catch (error) { warn(`[${lang}] ${key} threw on render: ${error.message}`); continue; }
    }
    if (typeof value !== "string" || value.trim() === "") warn(`[${lang}] ${key} is empty`);
    if (value === key) warn(`[${lang}] ${key} missing (fell back to the key name)`);
    if (/\{[a-zA-Z]+\}/.test(value)) warn(`[${lang}] ${key} has unreplaced variables: ${value}`);
    rendered[lang].set(key, value);
  }
}
I18N.setLang("en");

if (rendered.en.size !== rendered.zh.size) {
  warn(`dictionary sizes differ: en=${rendered.en.size} zh=${rendered.zh.size}`);
}

/* Chinese with a whole English phrase mixed in is usually a missed translation (commands, product names and units excepted; this only lists suspects for a human to eyeball) */
const ALLOW_ENGLISH = /^(PID|CPU|VRAM|GPU|RAM|MiB|G|%|Ctrl|FlowEdge|ComfyUI|Ollama|DSH|WorkBuddy|node)/;
const suspects = [];
for (const [key, text] of rendered.zh) {
  const plain = String(text).replace(/<[^>]+>/g, " ").replace(/\{[^}]+\}/g, " ");
  if (!/[\u4e00-\u9fa5]/.test(plain) && /[A-Za-z]{4,}/.test(plain) && !ALLOW_ENGLISH.test(plain.trim())) {
    suspects.push(`${key} → ${plain.trim().slice(0, 60)}`);
  }
}

/* ---------------------------------------------------------- 2. index.html keys */
const html = await readFile(path.join(ROOT, "web/index.html"), "utf8");
const attrKeys = new Set();
for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-aria-label|-title)?="([^"]+)"/g)) {
  attrKeys.add(match[1]);
}
for (const key of attrKeys) {
  if (!KEYS.includes(key)) warn(`index.html uses a key missing from the dictionary: ${key}`);
}

/* ---------------------------------------------------------- 3. app.js keys */
const app = await readFile(path.join(ROOT, "web/assets/app.js"), "utf8");
const codeKeys = new Set();
for (const match of app.matchAll(/\bT\(\s*"([\w.]+)"/g)) codeKeys.add(match[1]);
for (const key of codeKeys) {
  if (!KEYS.includes(key)) warn(`app.js uses a key missing from the dictionary: ${key}`);
}

/* Dynamic key prefixes: T(`pressure.${level}`) / `detail.${key}` / `basis.${basis}` / `sort.${state.sort}` */
const dynamicPrefixes = new Set();
for (const match of app.matchAll(/`([a-z][\w]*)\.\$\{/g)) dynamicPrefixes.add(`${match[1]}.`);
for (const prefix of dynamicPrefixes) {
  if (!KEYS.some((key) => key.startsWith(prefix))) warn(`app.js dynamic key prefix has no matching entries: ${prefix}*`);
}

/* Keys passed as string literals in app.js (renderHowto's title/body/desc, DETAIL_KEYS, BASIS_KEYS) */
const literalKeys = new Set();
for (const match of app.matchAll(/["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g)) literalKeys.add(match[1]);
for (const key of literalKeys) {
  if (key.includes(".") && KEYS.includes(key)) codeKeys.add(key);
}
/* i18n.js uses keys itself too (meta.title / meta.desc / lang.label in applyStatic) */
for (const match of source.matchAll(/["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g)) {
  if (KEYS.includes(match[1])) codeKeys.add(match[1]);
}

/* ---------------------------------------------------------- report */
const isDynamic = (key) => [...dynamicPrefixes].some((prefix) => key.startsWith(prefix));
const unused = KEYS.filter((key) => !attrKeys.has(key) && !codeKeys.has(key) && !isDynamic(key));
console.log(`Dictionary keys: ${KEYS.length} (en/zh aligned ${rendered.en.size}/${rendered.zh.size})`);
console.log(`index.html references: ${attrKeys.size} keys`);
console.log(`app.js references: ${codeKeys.size} keys`);
if (suspects.length) {
  console.log(`\nPossible untranslated Chinese: ${suspects.length} (eyeball them):`);
  suspects.forEach((line) => console.log(`  - ${line}`));
}
if (unused.length) {
  console.log(`\nUnreferenced dictionary keys: ${unused.length} (possibly template leftovers; delete after confirming):`);
  unused.forEach((key) => console.log(`  - ${key}`));
}
if (errors.length) {
  console.error(`\n✗ ${errors.length} problems:`);
  errors.forEach((line) => console.error(`  - ${line}`));
  process.exit(1);
}
console.log("\n✓ bilingual dictionary self-check passed");
