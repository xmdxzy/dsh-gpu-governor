/* GPU Radar · panel logic
   Reads exactly one dataset: web/data/snapshot.js (window.__VRAM_SNAPSHOT__).
   Live mode is driven by web/server.mjs, which writes a fresh snapshot into that same global and re-renders. */

(() => {
  "use strict";

  /* Bilingual: the dictionary lives in assets/i18n.js. English is the default; the small menu in the
     top-right corner switches language and remembers the choice. All UI copy goes through T();
     the data itself (project / task / process / path names) is never translated. */
  const I18N = window.VRAM_I18N;
  const T = (key, vars) => I18N.t(key, vars);
  const PRESSURE = ["ok", "warn", "crit", "idle"];
  const pressureLabel = (level) => (PRESSURE.includes(level) ? T(`pressure.${level}`) : level);

  const S = window.__VRAM_SNAPSHOT__;
  const root = {
    topmeta: document.getElementById("topmeta"),
    hero: document.getElementById("hero"),
    rows: document.getElementById("rows"),
    boardcount: document.getElementById("boardcount"),
    boardfoot: document.getElementById("boardfoot"),
    trend: document.getElementById("trend"),
    workload: document.getElementById("workload"),
    howto: document.getElementById("howto"),
    footsrc: document.getElementById("footsrc"),
    search: document.getElementById("search"),
    field: document.getElementById("field"),
    fieldclear: document.getElementById("fieldclear"),
    fieldcount: document.getElementById("fieldcount"),
    sorttabs: document.getElementById("sorttabs"),
    pointerlight: document.getElementById("pointerlight"),
    tip: document.getElementById("tip")
  };

  const BUDGET_KEY = "vram-radar/budgets/v2";
  const state = {
    sort: "mem",
    query: "",
    open: new Set(),
    budgets: loadBudgets()
  };

  /* ------------------------------------------------------------ helpers */
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const num = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
  const gib = (mib) => `${(Number(mib || 0) / 1024).toFixed(1)}G`;
  const pct = (value, digits = 0) => `${num(Number(value || 0), digits)}%`;
  const round1 = (value) => Math.round(Number(value || 0) * 10) / 10;
  const clock = (ms) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  };
  const stamp = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const levelOf = (value, warn, crit) => (value >= crit ? "crit" : value >= warn ? "warn" : "ok");

  function loadBudgets() {
    try {
      const raw = JSON.parse(localStorage.getItem(BUDGET_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch { return {}; }
  }
  function saveBudgets() {
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(state.budgets)); } catch { /* ignore in private mode */ }
  }
  const budgetOf = (project) => {
    const own = state.budgets[project.key];
    if (Number.isFinite(own)) return own;
    return Number.isFinite(project.budgetMiB) ? project.budgetMiB : null;
  };

  /* ------------------------------------------------------------ geometry */
  const polar = (cx, cy, r, deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const arcPath = (cx, cy, r, from, to) => {
    const [x1, y1] = polar(cx, cy, r, from);
    const [x2, y2] = polar(cx, cy, r, to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const GAUGE = { cx: 60, cy: 62, r: 43, from: -135, sweep: 270, segs: 36 };
  const REDLINE_AT = 0.82;

  /* ------------------------------------------------------------ sports-car gauge runtime (final recipe)
     Segmented halo × chunky ticks × single needle × hairline ring × bottom-anchored readout × focus-in ignition.
     One rAF loop drives all of it:
     - first frame: the whole dial resolves out of a blur and the segments light up one by one with progress;
     - live refresh (DOM rebuilt every 3s) only swaps the target — pos/vel live in state, so the motion stays
       continuous and never replays;
     - once settled the needle idles with a micro-jitter; when the readout enters the red zone the red
       segments breathe as an alert. */
  const tach = (() => {
    const reduced = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const spring = (st, tv, dt) => {
      st.vel += (tv - st.pos) * 165 * dt;
      st.vel *= Math.max(0, 1 - 15.5 * dt);
      st.pos += st.vel * dt;
    };
    const states = new Map();
    let raf = 0, last = 0, seedIndex = 0;

    function target(id, ratio) {
      let st = states.get(id);
      if (!st) {
        st = { id, pos: reduced ? ratio : 0, vel: 0, value: ratio, phase: reduced ? "idle" : "enter", entryT: 0, seed: (seedIndex += 1) * 2.1, lit: -1, el: null };
        states.set(id, st);
      }
      st.value = ratio;
      if (reduced) st.pos = ratio;
      return st;
    }

    function apply(st, now) {
      const els = st.el;
      if (!els) return;
      const shown = Math.min(Math.max(st.pos, 0), 1);
      const n = Math.round(shown * els.segs.length);
      if (n !== st.lit) {
        st.lit = n;
        els.segs.forEach((p, i) => {
          const on = i < n;
          p.setAttribute("opacity", on ? (i === n - 1 ? "1" : "0.78") : (p.dataset.hot === "1" ? "0.15" : "0.09"));
        });
      }
      if (st.phase === "enter") {
        const e = easeOutCubic(Math.min(1, st.entryT / 1.1));
        els.svg.style.opacity = (0.15 + 0.85 * e).toFixed(3);
        els.svg.style.transform = `scale(${(1.05 - 0.05 * e).toFixed(3)})`;
      } else if (els.svg.style.opacity) {
        els.svg.style.opacity = "";
        els.svg.style.transform = "";
      }
    }

    function step(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      states.forEach((st) => {
        if (st.phase === "enter") {
          st.entryT += dt;
          spring(st, st.value * easeOutCubic(Math.min(1, st.entryT / 1.1)), dt);
          if (st.entryT > 1.4) st.phase = "idle";
        } else {
          spring(st, st.value, dt);
        }
        apply(st, now);
      });
      raf = requestAnimationFrame(step);
    }

    function attach(scope) {
      states.forEach((st) => {
        const svg = scope.querySelector(`[data-tach="${st.id}"]`);
        st.el = svg && {
          svg,
          segs: Array.from(svg.querySelectorAll(".tach-seg"))
        };
        st.lit = -1;
      });
      if (!reduced && !raf) { last = performance.now(); raf = requestAnimationFrame(step); }
    }

    return { target, attach };
  })();

  function gauge({ id, label, frac, big, unit, sub, accent, foot, aria, bigSize = 23 }) {
    const ratio = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 0));
    const st = tach.target(id, ratio);
    const shown = Math.min(Math.max(st.pos, 0), 1);
    const end = GAUGE.from + GAUGE.sweep * shown;
    /* 36-segment halo: gaps between segments, red-zone segments backed by the alert color */
    const segs = Array.from({ length: GAUGE.segs }, (_, index) => {
      const t0 = index / GAUGE.segs;
      const t1 = (index + 1) / GAUGE.segs;
      const hot = t1 > REDLINE_AT;
      const a0 = GAUGE.from + GAUGE.sweep * (t0 + (t1 - t0) * 0.08);
      const a1 = GAUGE.from + GAUGE.sweep * (t1 - (t1 - t0) * 0.3);
      const [x1, y1] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r, a0);
      const [x2, y2] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r, a1);
      const on = t1 <= shown + 0.0001;
      const lead = on && t1 > shown - 1 / GAUGE.segs;
      const op = on ? (lead ? "1" : "0.78") : (hot ? "0.15" : "0.09");
      return `<path class="tach-seg"${hot ? ' data-hot="1"' : ""} d="M${x1.toFixed(2)} ${y1.toFixed(2)} A${GAUGE.r} ${GAUGE.r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${hot ? "var(--crit)" : accent}" stroke-width="6.5" stroke-linecap="butt" opacity="${op}"/>`;
    }).join("");
    /* 9 chunky ticks (one every 4 segments); red-zone ticks are tinted red */
    const ticks = Array.from({ length: 9 }, (_, index) => {
      const t = index / 8;
      const angle = GAUGE.from + GAUGE.sweep * t;
      const hot = t >= REDLINE_AT;
      const [ax, ay] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r + 5.5, angle);
      const [bx, by] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r + 11, angle);
      return `<line class="ring-tick${hot ? " major" : ""}"${hot ? ' data-hot="true"' : ""} x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
    }).join("");
    /* used arc: the light sweep is clipped to this arc only (mask limited to the used arc) */
    const [osx, osy] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r + 6, GAUGE.from);
    const [oex, oey] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r + 6, end);
    const [iex, iey] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r - 6, end);
    const [isx, isy] = polar(GAUGE.cx, GAUGE.cy, GAUGE.r - 6, GAUGE.from);
    const large = end - GAUGE.from > 180 ? 1 : 0;
    const clip = `M${osx.toFixed(2)} ${osy.toFixed(2)} A${GAUGE.r + 6} ${GAUGE.r + 6} 0 ${large} 1 ${oex.toFixed(2)} ${oey.toFixed(2)} L${iex.toFixed(2)} ${iey.toFixed(2)} A${GAUGE.r - 6} ${GAUGE.r - 6} 0 ${large} 0 ${isx.toFixed(2)} ${isy.toFixed(2)} Z`;
    return `
      <div class="gauge">
        <div class="gname">${esc(label)}</div>
        <svg viewBox="0 0 120 128" data-tach="${esc(id)}" data-over="${ratio >= REDLINE_AT}" role="img" aria-label="${esc(aria || label)}">
          <defs>
            <radialGradient id="dial-${id}" cx="50%" cy="40%" r="68%">
              <stop offset="0" stop-color="#11161b"/>
              <stop offset="1" stop-color="#06080a"/>
            </radialGradient>
            <clipPath id="clip-${id}">${clip}</clipPath>
          </defs>
          <circle cx="60" cy="62" r="${GAUGE.r + 1}" fill="url(#dial-${id})"/>
          <circle cx="60" cy="62" r="${GAUGE.r + 4.6}" fill="none" stroke="rgba(255,255,255,.13)" stroke-width=".7"/>
          ${ticks}
          ${segs}
          <g clip-path="url(#clip-${id})">
            <circle class="arc-shine" cx="60" cy="62" r="${GAUGE.r}" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="7" stroke-dasharray="18 320" stroke-linecap="round"/>
          </g>
          <text class="ring-val tach-val" x="60" y="112" text-anchor="middle" font-size="${bigSize}">${esc(big)}<tspan class="ring-unit" dx="3">${esc(unit)}</tspan></text>
          <text class="ring-sub" x="60" y="50" text-anchor="middle">${esc(sub)}</text>
        </svg>
        <div class="gfoot">${foot}</div>
      </div>`;
  }

  /* ------------------------------------------------------------ verdict */
  function verdicts() {
    const list = [];
    const gpu = S.gpu;
    const headroom = S.headroomMiB ?? 0;
    const projects = sortedProjects();

    if (gpu === null) {
      list.push({ level: "crit", html: T("verdict.noGpu") });
    } else if (headroom < 1024) {
      list.push({ level: "crit", html: T("verdict.headroom.crit", { value: gib(headroom) }) });
    } else if (headroom < 4096) {
      list.push({ level: "warn", html: T("verdict.headroom.warn", { value: gib(headroom) }) });
    } else {
      list.push({ level: "good", html: T("verdict.headroom.good", { value: gib(headroom) }) });
    }

    const top = projects[0];
    if (top && top.share >= 50) {
      list.push({
        level: "info",
        html: T("verdict.topShare", {
          label: esc(top.label),
          share: pct(top.share),
          others: Math.max(0, S.groupCount - 1),
          rest: pct(100 - top.share)
        })
      });
    }

    const withBudget = projects.filter((project) => budgetOf(project) !== null);
    const over = withBudget.filter((project) => project.memMiB > budgetOf(project));
    const freeable = over.reduce((sum, project) => sum + (project.memMiB - budgetOf(project)), 0);
    if (over.length > 0) {
      list.push({ level: "warn", html: T("verdict.overBudget", { count: over.length, freeable: gib(freeable) }) });
    } else if (withBudget.length > 0) {
      list.push({ level: "good", html: T("verdict.underBudget", { count: withBudget.length }) });
    } else {
      list.push({ level: "info", html: T("verdict.noBudget") });
    }

    const comfy = projects.find((project) => project.detail && project.detail.kind === "comfyui");
    const usage = comfy && Array.isArray(comfy.detail.items) ? comfy.detail.items.find((item) => item.k === "vramUsage") : null;
    if (usage) list.push({ level: "info", html: T("verdict.weights", { value: esc(usage.v) }) });

    if ((S.suspendedPids || []).length > 0) {
      list.push({ level: "warn", html: T("verdict.suspended", { count: S.suspendedPids.length }) });
    }

    const gap = (S.reserveSuggestedMiB ?? 0) - (S.reservedMiB ?? 0);
    if (gap > 256) {
      list.push({
        level: "info",
        html: T("verdict.reserve", {
          reserved: gib(S.reservedMiB),
          suggested: gib(S.reserveSuggestedMiB),
          extra: gib(gap)
        })
      });
    }

    const history = S.history || [];
    if (history.length >= 4) {
      const first = history[0].usedMiB;
      const last = history[history.length - 1].usedMiB;
      const delta = last - first;
      if (Math.abs(delta) >= 512) {
        const span = Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 1000));
        list.push({
          level: delta > 0 ? "warn" : "good",
          html: T(delta > 0 ? "verdict.deltaUp" : "verdict.deltaDown", {
            span,
            delta: gib(Math.abs(delta)),
            from: gib(first),
            to: gib(last)
          })
        });
      }
    }
    return list;
  }

  function renderTop() {
    const level = S.pressure || "idle";
    const live = window.__VRAM_LIVE__ === true;
    root.topmeta.innerHTML = [
      `<span class="pill" data-level="${esc(level)}"><i></i>${esc(pressureLabel(level))}</span>`,
      `<span class="pill">${T("top.snapshot", { time: esc(stamp(S.generatedAt)) })}</span>`,
      `<span class="pill">${T("top.count", { processes: S.processCount, groups: S.groupCount })}</span>`,
      `<span class="pill">${live ? T("top.live") : T("top.static")}</span>`
    ].join("");
    root.footsrc.textContent = live
      ? T("top.liveNote")
      : T("top.staticNote", { time: stamp(S.generatedAt) });
  }

  function renderHero() {
    const gpu = S.gpu;
    const cpu = S.cpu;
    const ram = cpu && cpu.ram ? cpu.ram : null;
    const usedPct = gpu && gpu.totalMiB ? (gpu.usedMiB / gpu.totalMiB) * 100 : 0;
    const pressureLevel = S.pressure || "idle";
    const headroom = S.headroomMiB ?? 0;
    const rawHeadroom = (gpu ? gpu.freeMiB : 0) - (S.reservedMiB || 0);
    const headroomLevel = headroom < 1024 ? "crit" : headroom < 4096 ? "warn" : "ok";

    const gauges = [
      gauge({
        id: "gpu",
        label: T("hero.gpu"),
        frac: gpu ? gpu.utilPct / 100 : 0,
        big: gpu ? String(Math.round(gpu.utilPct)) : "—",
        unit: gpu ? "%" : "n/a",
        sub: gpu ? gpu.name.replace("NVIDIA GeForce ", "") : T("hero.gpu.none"),
        accent: "var(--gpu)",
        foot: gpu
          ? T("hero.gpu.foot", {
              temp: gpu.tempC === null ? "—" : `${gpu.tempC}°C`,
              power: gpu.powerW === null ? "—" : `${Math.round(gpu.powerW)}W`
            })
          : T("hero.gpu.empty"),
        aria: gpu ? T("hero.gpu.aria", { value: Math.round(gpu.utilPct) }) : T("hero.gpu.aria.none")
      }),
      gauge({
        id: "vram",
        label: T("hero.vram"),
        frac: usedPct / 100,
        big: gpu ? gib(gpu.usedMiB).replace("G", "") : "—",
        unit: gpu ? "G" : "n/a",
        bigSize: 23,
        sub: gpu ? T("hero.vram.sub", { total: gib(gpu.totalMiB), pct: pct(usedPct) }) : "—",
        accent: "var(--vram)",
        foot: gpu ? T("hero.vram.foot", { free: gib(gpu.freeMiB), avail: gib(headroom) }) : "—",
        aria: gpu ? T("hero.vram.aria", { pct: usedPct.toFixed(0), free: gib(gpu.freeMiB) }) : T("hero.vram.aria.none")
      }),
      gauge({
        id: "cpu",
        label: T("hero.cpu"),
        frac: cpu ? cpu.utilPct / 100 : 0,
        big: cpu ? String(Math.round(cpu.utilPct)) : "—",
        unit: cpu ? "%" : "n/a",
        sub: cpu ? `${cpu.coreCount}C / ${cpu.logicalCores}T` : "—",
        accent: "var(--cpu)",
        foot: ram ? T("hero.cpu.ram", { used: gib(ram.usedMiB), total: gib(ram.totalMiB), pct: pct(ram.pct) }) : "—",
        aria: cpu ? T("hero.cpu.aria", { value: Math.round(cpu.utilPct) }) : T("hero.cpu.aria.none")
      })
    ].join("");

    const cores = cpu && Array.isArray(cpu.cores) && cpu.cores.length
      ? `<div class="strip"><span>${T("strip.cores")}</span><div class="cores">${cpu.cores.map((value) => {
          const height = Math.max(14, Math.min(100, Number(value) || 0));
          return `<b data-idle="${(Number(value) || 0) < 3}" style="height:${height}%" title="${Math.round(value)}%"></b>`;
        }).join("")}</div><span class="v">${cpu.coreCount}C / ${cpu.logicalCores}T</span></div>`
      : "";

    const ramStrip = ram
      ? `<div class="strip"><span>${T("strip.ram")}</span><div class="track"><i style="width:${Math.min(100, ram.pct)}%;background:linear-gradient(90deg,rgba(125,138,150,.5),rgba(125,138,150,.95))"></i></div><span class="v">${gib(ram.usedMiB)} / ${gib(ram.totalMiB)} · ${pct(ram.pct)}</span></div>`
      : "";

    const judgeList = verdicts().map((entry) => `
      <div class="verdict" data-level="${esc(entry.level)}">
        <span class="mark">${entry.level === "crit" ? "!" : entry.level === "warn" ? "!" : entry.level === "good" ? "✓" : "·"}</span>
        <span>${entry.html}</span>
      </div>`).join("");

    root.hero.innerHTML = `
      <div class="card system">
        <div class="gauges">${gauges}</div>
        <div class="strips">${ramStrip}${cores}</div>
        <div class="sfoot">
          <span>${T("card.collector", {
            interval: num((S.collector && S.collector.intervalMs) || 0),
            sample: num((S.collector && S.collector.sampleMs) || 0)
          })}</span>
          <span>${T("card.criteria")}</span>
        </div>
      </div>
      <div class="card judge">
        <div class="judge-head">
          <h3>${T("judge.title")}</h3>
          <span class="pill" data-level="${esc(pressureLevel)}"><i></i>${T("judge.pressure", { level: esc(pressureLabel(pressureLevel)) })}</span>
        </div>
        <div class="alloc">
          <span class="big" data-level="${headroomLevel}">${gib(headroom)}</span>
          <span class="unit">${T("judge.available")}</span>
          <span class="sub">${rawHeadroom < 0
            ? T("judge.overdrawn", { amount: gib(-rawHeadroom), reserved: gib(S.reservedMiB) })
            : T("judge.eq", { free: gib(gpu ? gpu.freeMiB : 0), reserved: gib(S.reservedMiB) })}</span>
        </div>
        <div class="judge-verdicts">${judgeList}</div>
        <div class="judge-actions">
          <button class="btn" data-primary="true" id="btn-copy">${T("btn.copy")}</button>
          <button class="btn" id="btn-json">${T("btn.json")}</button>
          <button class="btn" data-flat="true" id="btn-clear">${T("btn.clearBudgets")}</button>
        </div>
      </div>`;
    tach.attach(root.hero);
  }

  /* ------------------------------------------------------------ leaderboard */
  function sortedProjects() {
    const list = [...(S.projects || [])];
    const key = state.sort;
    list.sort((a, b) => {
      if (key === "cpu") return (b.cpuPct || 0) - (a.cpuPct || 0);
      if (key === "share") return (b.share || 0) - (a.share || 0);
      return (b.memMiB || 0) - (a.memMiB || 0);
    });
    return list;
  }

  function matches(project, query) {
    if (!query) return true;
    const haystack = [
      project.label, project.taskLabel, project.taskSub, project.dir, project.basis,
      project.detail ? project.detail.title : "",
      project.detail && Array.isArray(project.detail.models) ? project.detail.models.map((model) => model.name).join(" ") : ""
    ].concat((project.processes || []).flatMap((proc) => [proc.name, proc.prod, proc.task, proc.exe, proc.cmd]))
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  }

  const DETAIL_KEYS = ["engine", "endpoint", "vramUsage", "resident", "modelSource", "queue", "version", "note", "path"];
  const BASIS_KEYS = ["path", "workspace", "script", "exe", "process"];
  const detailLabel = (key) => (DETAIL_KEYS.includes(key) ? T(`detail.${key}`) : key);
  const basisLabel = (basis) => (BASIS_KEYS.includes(basis) ? T(`basis.${basis}`) : basis);

  function renderRow(project, index) {
    const open = state.open.has(project.key);
    const budget = budgetOf(project);
    const over = budget !== null && project.memMiB > budget;
    const maxMem = Math.max(1, ...(S.projects || []).map((row) => row.memMiB || 0));
    const vramWidth = Math.min(100, ((project.memMiB || 0) / maxMem) * 100);
    const budgetMark = budget !== null && budget > 0
      ? `<span class="mark" style="left:${Math.min(100, (budget / maxMem) * 100)}%" title="${esc(T("row.budgetTitle", { value: gib(budget) }))}"></span>`
      : "";
    const kind = project.detail ? project.detail.kind : "";

    const procs = (project.processes || []).map((proc) => `
      <div class="proc" title="${esc(proc.cmd || "")}">
        <span class="dot" data-dead="${proc.alive === false || proc.suspended === true}"></span>
        <span class="pname">${esc(proc.name)}<i>${esc(proc.task || proc.prod || "")}${proc.suspended ? T("row.paused") : ""}</i></span>
        <span class="pmeta">PID ${proc.pid} · ${gib(proc.memMiB)} · CPU ${pct(proc.cpuPct, 1)}</span>
        ${proc.cmd ? `<span class="pcmd">${esc(proc.cmd)}</span>` : ""}
      </div>`).join("");

    const kv = project.detail && Array.isArray(project.detail.items)
      ? project.detail.items.map((item) => `<div class="kv"><k>${esc(detailLabel(item.k))}</k><v>${esc(item.v)}</v></div>`).join("")
      : `<div class="empty">${T("row.noRuntime")}</div>`;

    const models = project.detail && Array.isArray(project.detail.models) && project.detail.models.length
      ? `<div class="dcard">
           <div class="dcard-head">${T("row.models")} <span style="margin-left:auto;opacity:.6">${T("row.modelsCount", { count: project.detail.models.length })}</span></div>
           <div class="models">${project.detail.models.map((model) => `<span class="model">${esc(model.name)}${model.detail ? `<i>${esc(model.detail)}</i>` : ""}</span>`).join("")}</div>
         </div>`
      : "";

    return `
      <article class="row" data-key="${esc(project.key)}" data-open="${open}" style="--accent:${kind === "comfyui" ? "var(--vram)" : "var(--gpu)"}">
        <button class="rowhead" aria-expanded="${open}" aria-controls="d-${index}">
          <span class="rank">${String(index + 1).padStart(2, "0")}</span>
          <span class="rname">${esc(project.label)}</span>
          <span class="tagwrap">
            ${kind ? `<span class="tag" data-kind="1">${esc(kind)}</span>` : `<span class="tag">${esc(basisLabel(project.basis))}</span>`}
            ${over ? `<span class="tag" data-over="true">${T("row.overBudget")}</span>` : ""}
          </span>
          <span class="rmem">${gib(project.memMiB)}</span>
          <span class="rshare">${pct(project.share)}</span>
          <span class="chev">›</span>
        </button>
        <div class="rtask" title="${esc(project.taskSub || "")}">${project.taskLabel ? `<b>${esc(project.taskLabel)}</b>` : "—"}${project.taskSub ? ` · ${esc(project.taskSub)}` : ""}</div>
        <div class="bars">
          <div class="barrow"><span>${T("bar.vram")}</span><div class="track"><i data-tone="vram" style="width:${vramWidth}%"></i>${budgetMark}</div><span class="bv">${gib(project.memMiB)} · ${pct(project.share)}</span></div>
          <div class="barrow"><span>${T("bar.cpu")}</span><div class="track"><i data-tone="cpu" style="width:${Math.min(100, project.cpuPct || 0)}%"></i></div><span class="bv">${pct(project.cpuPct, 1)} · ${T("bar.ram", { value: gib(project.ramMiB) })}</span></div>
        </div>
        <div class="rmeta">
          <span>${T("row.processes", { count: project.processCount })}</span>
          <span>${T("row.peak", { value: gib(project.peakMiB) })}</span>
          <span>${esc(project.dir)}</span>
          ${budget !== null ? `<span>${T("budget.label")} ${gib(budget)}</span>` : ""}
        </div>
        <div class="detail" id="d-${index}">
          <div class="stats">
            <div class="stat" style="--accent:var(--vram)"><k>${T("stat.vram")}</k><v>${gib(project.memMiB)}</v></div>
            <div class="stat" style="--accent:var(--gpu)"><k>${T("stat.gpu")}</k><v>${pct(project.utilPct)}</v></div>
            <div class="stat" style="--accent:var(--cpu)"><k>${T("stat.cpu")}</k><v>${pct(project.cpuPct, 1)}</v></div>
            <div class="stat" style="--accent:var(--ram)"><k>${T("stat.ram")}</k><v>${gib(project.ramMiB)}</v></div>
          </div>
          <div class="dgrid">
            <div class="dcard">
              <div class="dcard-head">${T("row.runtime")} ${kind ? `<span class="kind">${esc(kind)}</span>` : ""}</div>
              ${kv}
            </div>
            ${models || `<div class="dcard"><div class="dcard-head">${T("row.models")}</div><div class="empty">${T("row.noModelList")}</div></div>`}
          </div>
          <div class="dcard" style="margin-top:10px">
            <div class="dcard-head">${T("row.processList")} <span style="margin-left:auto;opacity:.6">${T("row.showing", { count: T("row.processes", { count: project.processCount }), shown: (project.processes || []).length })}</span></div>
            <div class="procs">${procs || `<div class="empty">${T("row.noProcess")}</div>`}</div>
          </div>
          <div class="budget">
            <b>${T("budget.label")}</b>
            <input type="number" min="0" step="256" inputmode="numeric" placeholder="${Math.round(project.memMiB)}" value="${budget === null ? "" : Math.round(budget)}" data-budget="${esc(project.key)}" aria-label="${esc(T("budget.inputAria", { name: project.label }))}">
            <span>MiB</span>
            <button class="btn" data-budget-save="${esc(project.key)}">${T("budget.save")}</button>
            ${budget !== null ? `<button class="btn" data-budget-clear="${esc(project.key)}">${T("budget.clear")}</button>` : ""}
            <span class="note">${budget === null
              ? T("budget.noteSet")
              : over
                ? T("budget.noteOver", { over: gib(project.memMiB - budget) })
                : T("budget.noteUnder", { left: gib(budget - project.memMiB) })}</span>
          </div>
        </div>
      </article>`;
  }

  const MIN_LIST_MIB = 8;

  function renderBoard() {
    const query = state.query.trim().toLowerCase();
    const all = sortedProjects();
    const list = all.filter((project) => {
      if (query) return matches(project, query);
      return (project.memMiB || 0) >= MIN_LIST_MIB;
    });
    const tiny = all.filter((project) => (project.memMiB || 0) < MIN_LIST_MIB).length;
    root.boardcount.textContent = query
      ? T("board.filtered", { shown: list.length, total: all.length })
      : T("board.summary", {
          count: list.length,
          tracked: S.trackedMiB ? gib(S.trackedMiB) : "—",
          sort: T(`sort.${state.sort}`)
        });
    root.rows.innerHTML = list.length
      ? list.map((project, index) => renderRow(project, index)).join("")
      : `<div class="empty" style="padding:26px 15px">${T("board.empty")}</div>`;

    root.boardfoot.innerHTML = `
      <span>${T("board.footSample", {
        samples: (S.history || []).length,
        interval: num((S.collector && S.collector.intervalMs) || 0),
        sample: num((S.collector && S.collector.sampleMs) || 0)
      })}</span>
      <span>${tiny > 0
        ? T("board.hiddenMore", { count: tiny, min: MIN_LIST_MIB, sum: gib(S.hiddenMiB) })
        : T("board.allListed", { count: S.groupCount })} · ${T("board.total", { value: gib(S.trackedMiB) })}</span>`;

    /* hit count inside the search field */
    if (root.fieldcount) {
      if (query) {
        root.fieldcount.textContent = T("search.hits", { count: list.length });
        root.fieldcount.hidden = false;
      } else {
        root.fieldcount.hidden = true;
      }
    }
    syncField();
  }

  /* ------------------------------------------------------------ trend */
  function renderTrend() {
    const history = (S.history || []).slice(-80);
    if (history.length < 2) {
      root.trend.innerHTML = `<div class="card-head"><h2>${T("trend.title")}</h2></div><div class="empty" style="padding:20px 15px">${T("trend.needMore")}</div>`;
      return;
    }
    const W = 720, H = 188, padL = 38, padR = 14, padT = 14, padB = 22;
    const maxMem = Math.max(1, ...history.map((point) => point.usedMiB), (S.gpu && S.gpu.totalMiB) || 0);
    const x = (index) => padL + (index * (W - padL - padR)) / (history.length - 1);
    const yMem = (value) => padT + (1 - value / maxMem) * (H - padT - padB);
    const yCpu = (value) => padT + (1 - Math.min(100, value || 0) / 100) * (H - padT - padB);

    const line = history.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${yMem(point.usedMiB).toFixed(1)}`).join(" ");
    const area = `${line} L${x(history.length - 1).toFixed(1)} ${(H - padB).toFixed(1)} L${padL} ${(H - padB).toFixed(1)} Z`;
    const cpuLine = history.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${yCpu(point.cpuPct).toFixed(1)}`).join(" ");
    const gridlines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const y = padT + ratio * (H - padT - padB);
      return `<line class="gridline" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>
              <text class="axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${(maxMem * (1 - ratio) / 1024).toFixed(0)}G</text>`;
    }).join("");
    const marks = [0, Math.floor(history.length / 2), history.length - 1].map((index) => {
      const anchor = index === 0 ? "start" : index === history.length - 1 ? "end" : "middle";
      return `<text class="axis" x="${x(index).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${clock(history[index].t)}</text>`;
    }).join("");

    root.trend.innerHTML = `
      <div class="card-head">
        <h2>${T("trend.title")}</h2>
        <div class="legend">
          <span><i style="background:var(--vram)"></i>${T("trend.vram")}</span>
          <span><i style="background:var(--cpu);height:0;border-top:2px dashed var(--cpu)"></i>${T("trend.cpu")}</span>
          <span>${T("trend.points", {
            count: history.length,
            seconds: Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 1000))
          })}</span>
        </div>
      </div>
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T("trend.aria"))}">
          <defs>
            <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#8a78e8" stop-opacity=".55"/>
              <stop offset="1" stop-color="#8a78e8" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${gridlines}
          <path class="area" d="${area}" fill="url(#trend-area)"/>
          <path class="line" d="${cpuLine}" stroke="var(--cpu)" stroke-dasharray="3 3" stroke-width="1.1" opacity=".75"/>
          <path class="line" d="${line}" stroke="var(--vram)"/>
          <line class="cross" x1="0" y1="${padT}" x2="0" y2="${H - padB}" hidden/>
          <circle class="cross-dot" r="3" fill="var(--vram)" hidden/>
          <rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent" class="hit"/>
          ${marks}
        </svg>
      </div>`;

    const svg = root.trend.querySelector("svg");
    const cross = svg.querySelector(".cross");
    const dot = svg.querySelector(".cross-dot");
    const hit = svg.querySelector(".hit");
    hit.addEventListener("mousemove", (event) => {
      const box = svg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const px = ratio * W;
      const index = Math.min(history.length - 1, Math.max(0, Math.round(((px - padL) / (W - padL - padR)) * (history.length - 1))));
      const point = history[index];
      cross.hidden = false; dot.hidden = false;
      cross.setAttribute("x1", x(index)); cross.setAttribute("x2", x(index));
      dot.setAttribute("cx", x(index)); dot.setAttribute("cy", yMem(point.usedMiB));
      showTip(event.clientX, event.clientY,
        `<b>${clock(point.t)}</b> ${T("tip.mem", { mem: gib(point.usedMiB), gpu: pct(point.utilPct) })}<br>${T("tip.cpu", { cpu: pct(point.cpuPct, 1), ram: pct(point.ramPct, 1) })}`);
    });
    hit.addEventListener("mouseleave", () => {
      cross.hidden = true; dot.hidden = true; hideTip();
    });
  }

  function showTip(clientX, clientY, html) {
    root.tip.innerHTML = html;
    root.tip.hidden = false;
    root.tip.style.left = `${clientX}px`;
    root.tip.style.top = `${clientY}px`;
  }
  function hideTip() { root.tip.hidden = true; }

  /* ------------------------------------------------------------ workload */
  function renderWorkload() {
    const work = S.workloads || {};
    const flow = work.flowedge;
    const comfy = Array.isArray(work.comfy) ? work.comfy : [];
    const top = sortedProjects()[0];
    const chain = top
      ? T("wl.chain", { mem: gib(top.memMiB), count: top.processCount, task: esc(top.taskLabel || top.label) })
        + (top.detail && top.detail.models && top.detail.models.length ? T("wl.chainWeights", { count: top.detail.models.length }) : "")
      : "—";

    const rows = [
      `<div class="wlrow"><k>${T("wl.chainLabel")}</k><v>${chain}</v></div>`,
      `<div class="wlrow"><k>FlowEdge</k><v>${flow
        ? `<b>${esc(flow.version || T("wl.online"))}</b> <em>${T("wl.uptime", { minutes: Math.floor((flow.uptimeSeconds || 0) / 60) })}</em> · ${T("wl.runningJobs", { count: flow.runningJobs })} · ${T("wl.deps", { list: (flow.runningDeps || []).length ? esc(flow.runningDeps.join(" / ")) : T("wl.none") })}`
        : `<em>${T("wl.flowAbsent")}</em>`}</v></div>`,
      `<div class="wlrow"><k>ComfyUI</k><v>${comfy.length
        ? comfy.map((entry) => `<b>${esc(entry.name)}</b> <em>${esc(entry.endpoint)}</em><div class="chips">${(entry.models || []).map((model) => `<span class="model">${esc(model)}</span>`).join("")}</div>`).join("")
        : `<em>${T("wl.comfyAbsent")}</em>`}</v></div>`,
      `<div class="wlrow"><k>Ollama</k><v>${work.ollama ? `<b>${work.ollama}</b> ${T("wl.ollamaResident", { count: work.ollama })}` : `<em>${T("wl.ollamaAbsent")}</em>`}</v></div>`
    ];

    if ((work.errors || []).length) {
      rows.push(`<div class="wlrow"><k>${T("wl.probeNotes")}</k><v><em>${esc(work.errors.join(" · "))}</em></v></div>`);
    }
    if ((S.warnings || []).length) {
      rows.push(`<div class="wlrow"><k>${T("wl.degraded")}</k><v><em>${esc(S.warnings.join(" · "))}</em></v></div>`);
    }

    root.workload.innerHTML = `
      <div class="card-head">
        <h2>${T("wl.title")}</h2>
        <div class="legend"><span>${work.probedAt ? T("wl.probedAt", { time: clock(work.probedAt) }) : T("wl.notProbed")}</span></div>
      </div>
      <div class="wl">${rows.join("")}</div>`;
  }

  /* ------------------------------------------------------------ how-to */
  function renderHowto() {
    /* The commands themselves (the Chinese sub-commands after /vram-radar) are the real trigger words of the
       skill, so they are shown verbatim in both languages; only the descriptions follow the language. */
    const card = ({ title, body, items, note }) => `
      <div class="card how">
        <h3>${T(title)}</h3>
        <p>${T(body)}</p>
        <div class="cmds">
          ${items.map((item) => `<span class="cmd"><k>${item.cmd}</k><v>${T(item.desc)}</v></span>`).join("")}
        </div>
        ${note ? `<p style="margin-top:2px">${T(note)}</p>` : ""}
      </div>`;

    root.howto.innerHTML = [
      card({
        title: "howto.skill.title",
        body: "howto.skill.body",
        items: [
          { cmd: "/vram-radar", desc: "howto.skill.c1" },
          { cmd: T("howto.skill.c2.cmd"), desc: "howto.skill.c2" },
          { cmd: T("howto.skill.c3.cmd"), desc: "howto.skill.c3" },
          { cmd: T("howto.skill.c4.cmd"), desc: "howto.skill.c4" },
          { cmd: T("howto.skill.c5.cmd"), desc: "howto.skill.c5" }
        ]
      }),
      card({
        title: "howto.live.title",
        body: "howto.live.body",
        items: [
          { cmd: "node web/server.mjs", desc: "howto.live.c1" },
          { cmd: "--port 4800", desc: "howto.live.c2" },
          { cmd: "--once", desc: "howto.live.c3" }
        ],
        note: "howto.live.note"
      }),
      card({
        title: "howto.engine.title",
        body: "howto.engine.body",
        items: [
          { cmd: "--brief", desc: "howto.engine.c1" },
          { cmd: "--json", desc: "howto.engine.c2" },
          { cmd: "--emit-web", desc: "howto.engine.c3" }
        ]
      })
    ].join("");
  }

  /* ------------------------------------------------------------ interaction */
  function syncField() {
    if (!root.field) return;
    const has = state.query.length > 0;
    root.field.dataset.hasValue = String(has);
    if (root.fieldclear) root.fieldclear.hidden = !has;
  }

  /* ------------------------------------------------------------ language menu */
  function bindLangMenu() {
    const button = document.getElementById("langbtn");
    const menu = document.getElementById("langmenu");
    if (!button || !menu) return;

    const close = () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const current = menu.querySelector('[aria-selected="true"]') || menu.querySelector("[data-lang]");
      if (current) current.focus();
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) open(); else close();
    });

    menu.addEventListener("click", (event) => {
      const option = event.target.closest("[data-lang]");
      if (!option) return;
      I18N.setLang(option.dataset.lang);
      close();
      button.focus();
    });

    menu.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const options = Array.from(menu.querySelectorAll("[data-lang]"));
      const index = options.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length].focus();
    });

    document.addEventListener("click", (event) => {
      if (!menu.hidden && !event.target.closest("#lang")) close();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        close();
        button.focus();
      }
    });
  }

  function bind() {
    bindLangMenu();
    root.search.addEventListener("input", (event) => {
      state.query = event.target.value || "";
      syncField();
      renderBoard();
    });

    if (root.fieldclear) {
      root.fieldclear.addEventListener("click", () => {
        state.query = "";
        if (root.search) root.search.value = "";
        syncField();
        renderBoard();
        if (root.search) root.search.focus();
      });
    }

    /* Ctrl/Cmd+K focuses the search field; Esc clears it or blurs */
    document.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (root.search) root.search.focus();
        if (root.search) root.search.select();
        return;
      }
      if (event.key === "Escape" && document.activeElement === root.search) {
        if (state.query) {
          state.query = "";
          if (root.search) root.search.value = "";
          syncField();
          renderBoard();
        } else {
          root.search.blur();
        }
      }
    });

    /* pointer glow: only CSS variables are updated, rAF eases the follow, and it drifts back to center when idle */
    if (root.pointerlight && !window.matchMedia("(prefers-reduced-motion:reduce)").matches) {
      const light = root.pointerlight;
      let tx = window.innerWidth * 0.5, ty = window.innerHeight * 0.32;
      let cx = tx, cy = ty, raf = 0;
      const step = () => {
        cx += (tx - cx) * 0.045;
        cy += (ty - cy) * 0.045;
        light.style.setProperty("--px", `${cx}px`);
        light.style.setProperty("--py", `${cy}px`);
        raf = (Math.abs(tx - cx) > 0.5 || Math.abs(ty - cy) > 0.5) ? requestAnimationFrame(step) : 0;
      };
      const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
      window.addEventListener("pointermove", (event) => {
        tx = event.clientX; ty = event.clientY; kick();
      }, { passive: true });
      kick();
    }

    root.sorttabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-sort]");
      if (!button) return;
      state.sort = button.dataset.sort;
      root.sorttabs.querySelectorAll("button").forEach((item) => {
        item.setAttribute("aria-selected", String(item === button));
      });
      renderBoard();
    });

    root.rows.addEventListener("click", (event) => {
      const head = event.target.closest(".rowhead");
      if (head) {
        const row = head.closest(".row");
        const key = row.dataset.key;
        if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
        row.dataset.open = String(state.open.has(key));
        head.setAttribute("aria-expanded", row.dataset.open);
        if (state.open.has(key)) {
          row.classList.add("just-opened");
          setTimeout(() => row.classList.remove("just-opened"), 460);
        }
        return;
      }
      const save = event.target.closest("[data-budget-save]");
      if (save) {
        const key = save.dataset.budgetSave;
        const input = root.rows.querySelector(`input[data-budget="${CSS.escape(key)}"]`);
        const value = Number(input && input.value);
        if (Number.isFinite(value) && value > 0) state.budgets[key] = Math.round(value);
        else delete state.budgets[key];
        saveBudgets();
        refresh();
        return;
      }
      const clear = event.target.closest("[data-budget-clear]");
      if (clear) {
        delete state.budgets[clear.dataset.budgetClear];
        saveBudgets();
        refresh();
      }
    });

    root.hero.addEventListener("click", (event) => {
      if (event.target.closest("#btn-copy")) copySummary();
      if (event.target.closest("#btn-json")) downloadJson();
      if (event.target.closest("#btn-clear")) {
        state.budgets = {};
        saveBudgets();
        refresh();
      }
    });
  }

  function summaryText() {
    const gpu = S.gpu;
    const lines = [];
    lines.push(T("summary.title", { gpu: gpu ? gpu.name : T("summary.noGpu"), time: stamp(S.generatedAt) }));
    if (gpu) {
      lines.push(T("summary.gpu", {
        used: gib(gpu.usedMiB),
        total: gib(gpu.totalMiB),
        pct: pct((gpu.usedMiB / gpu.totalMiB) * 100),
        util: pct(gpu.utilPct)
      }) + (gpu.tempC === null ? "" : T("summary.temp", { temp: gpu.tempC })));
    }
    lines.push(T("summary.avail", {
      headroom: gib(S.headroomMiB),
      reserved: gib(S.reservedMiB),
      processes: S.processCount,
      groups: S.groupCount
    }));
    lines.push(T("summary.who"));
    sortedProjects().slice(0, 6).forEach((project, index) => {
      const budget = budgetOf(project);
      const flag = budget !== null && project.memMiB > budget ? T("summary.over") : "";
      lines.push(`${String(index + 1).padStart(2, "0")} ${project.label} ${project.taskLabel || ""} ${gib(project.memMiB)} ${pct(project.share)}${flag}`);
    });
    return lines.join("\n");
  }

  async function copySummary() {
    const text = summaryText();
    try {
      await navigator.clipboard.writeText(text);
      flash(T("copy.ok"));
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); flash(T("copy.ok")); } catch { flash(T("copy.fail")); }
      area.remove();
    }
  }

  function flash(message) {
    const button = document.getElementById("btn-copy");
    if (!button) return;
    const original = button.textContent;
    button.textContent = message;
    setTimeout(() => { button.textContent = original; }, 1400);
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vram-radar-${S.generatedAt.replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function refresh() {
    renderTop();
    renderHero();
    renderBoard();
    renderTrend();
    renderWorkload();
  }

  /* ------------------------------------------------------------ animation phase
     Live refresh rebuilds the DOM every 3 seconds, so infinite animations would restart from 0 and look
     like they keep being retriggered. Converting wall-clock time into a negative animation-delay stored in
     a :root variable lets new nodes inherit the same phase, so nothing ever restarts visually. */
  function syncAmbientPhase() {
    const t = Date.now() / 1000;
    const set = (name, d) => document.documentElement.style.setProperty(name, `${(-(t % d)).toFixed(2)}s`);
    set("--pulse-phase", 4.8);
    set("--gauge-phase", 11);
    set("--tip-phase", 6.5);
    set("--corner-phase", 9);
    set("--flow-phase", 7.5);
    set("--track-phase", 8);
    set("--accent-phase", 5.5);
  }

  function render() {
    syncAmbientPhase();
    refresh();
    renderHowto();
  }

  /* live mode: server.mjs writes a new snapshot into __VRAM_SNAPSHOT__ and then pings this handler */
  window.__VRAM_APPLY__ = (next) => {
    if (!next || typeof next !== "object") return;
    Object.keys(next).forEach((key) => { S[key] = next[key]; });
    window.__VRAM_LIVE__ = true;
    render();
  };

  /* language switch: i18n refreshes the static nodes first, then we re-render every JS-generated block */
  I18N.onChange(() => render());

  bind();
  render();

  /* local live mode: server.mjs serves /api/snapshot; if the probe fails under static hosting (file:// or cloud) keep the snapshot. */
  (async () => {
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) return;
      const first = await response.json();
      if (!first || typeof first.gpu === "undefined") return;
      window.__VRAM_APPLY__(first);
      setInterval(async () => {
        try {
          const next = await fetch("/api/snapshot", { cache: "no-store" });
          if (next.ok) window.__VRAM_APPLY__(await next.json());
        } catch { /* keep the previous snapshot if we drop offline */ }
      }, 3000);
    } catch { /* static snapshot */ }
  })();
})();
