window.__ModuleLoader__.load({
	id: "dsh-gpu-governor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		// createElement keeps this hand-written bundle readable: no JSX, no build.
		const h = React.createElement;
		//#region styles
		// HUD / supercar-cluster language: carbon-black plate, clipped corners,
		// cyan primary, amber CPU, violet VRAM, redline red. Numbers are monospace.
		const css = [
			// --- composer badge (outside the panel: literal colours) --------------
			// Supercar-plate language: mini VRAM dial up front (no dead space),
			// semantic-coloured readings, a pressure meter along the bottom edge.
			".xgg_badge{position:relative;align-items:center;gap:8px;height:26px;flex:none;padding:0 11px;border:1px solid rgba(255,255,255,.15);border-radius:7px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.015));color:#e6e9ec;cursor:pointer;outline:none;font-size:11px;font-weight:500;display:inline-flex;font-variant-numeric:tabular-nums;letter-spacing:.02em;font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;overflow:hidden;transition:background .2s ease,border-color .2s ease,box-shadow .35s ease}",
			".xgg_badge:hover{border-color:rgba(53,198,212,.55);box-shadow:0 0 0 1px rgba(53,198,212,.16),0 0 18px -4px rgba(53,198,212,.55)}",
			".xgg_badge::before{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 20%,rgba(53,198,212,.16) 50%,transparent 80%);transform:translateX(-120%);transition:transform .9s cubic-bezier(.3,.7,.3,1)}",
			".xgg_badge:hover::before{transform:translateX(120%)}",
			".xgg_badge:disabled{opacity:.55;cursor:default}",
			".xgg_badge[data-live=false]{opacity:.92}",
			".xgg_badge svg{display:block;flex:none}",
			".xgg_bstat{display:inline-flex;align-items:baseline;gap:4px}",
			".xgg_bk{font-style:normal;color:#77828e;font-weight:400;font-size:9.5px;letter-spacing:.06em}",
			".xgg_bgpu{color:#4fd6e2;font-weight:600}",
			".xgg_bvram{color:#a08ff0;font-weight:600}",
			".xgg_bvram[data-hot=true]{color:#ff8f93;animation:xgg_hot 1.4s ease-in-out infinite}",
			".xgg_bcpu{color:#e8b054;font-weight:600}",
			"@keyframes xgg_hot{0%,100%{opacity:1}50%{opacity:.55}}",
			".xgg_badgeDial{width:15px;height:15px;filter:drop-shadow(0 0 4px rgba(53,198,212,.35))}",
			".xgg_badgeDialBack{fill:rgba(255,255,255,.04)}",
			".xgg_badgeDialTrack{fill:none;stroke:rgba(255,255,255,.12);stroke-width:2}",
			".xgg_badgeDialFill{fill:none;stroke:#35c6d4;stroke-width:2;stroke-linecap:round;transform:rotate(-90deg);transform-origin:10px 10px;transition:stroke-dasharray .9s cubic-bezier(.2,.7,.3,1);animation:xgg_dial_breathe 5.5s ease-in-out infinite}",
			".xgg_badgeDialFill[data-level=warn]{stroke:#d99a2b}",
			".xgg_badgeDialFill[data-level=crit]{stroke:#e5484d;animation-duration:1.3s}",
			".xgg_badgeDialFill[data-level=idle]{stroke:#5b6670;animation:none}",
			".xgg_badgeDialPip{fill:#35c6d4;animation:xgg_dial_breathe 5.5s ease-in-out infinite}",
			".xgg_badgeDialPip[data-level=warn]{fill:#d99a2b}",
			".xgg_badgeDialPip[data-level=crit]{fill:#e5484d}",
			".xgg_badgeDialPip[data-level=idle]{fill:#3a424b}",
			"@keyframes xgg_dial_breathe{0%,100%{opacity:.72}50%{opacity:1}}",
			".xgg_badgeMeter{position:absolute;left:0;bottom:0;height:2px;border-radius:0 2px 2px 0;background:linear-gradient(90deg,rgba(53,198,212,.85),rgba(138,120,232,.95));box-shadow:0 0 8px rgba(53,198,212,.7);transition:width .9s cubic-bezier(.2,.7,.3,1)}",
			".xgg_badgeMeter[data-level=warn]{background:linear-gradient(90deg,rgba(217,154,43,.85),rgba(229,72,77,.8));box-shadow:0 0 8px rgba(217,154,43,.6)}",
			".xgg_badgeMeter[data-level=crit]{background:linear-gradient(90deg,rgba(229,72,77,.95),rgba(229,72,77,.7));box-shadow:0 0 9px rgba(229,72,77,.8)}",
			".xgg_badgeMeter[data-level=idle]{background:rgba(255,255,255,.14);box-shadow:none}",
			// --- panel: graphite plate + modelling grid ---------------------------
			".xgg_panel{--xl:rgba(255,255,255,.10);--xl2:rgba(255,255,255,.20);--xi1:#e6e9ec;--xi2:#9aa3ad;--xi3:#626c78;--xgpu:#35c6d4;--xvram:#8a78e8;--xcpu:#d99a2b;--xmem:#7d8a96;--xok:#3fb27f;--xcrit:#e5484d;position:fixed;right:16px;bottom:88px;width:672px;max-width:calc(100vw - 24px);max-height:min(92vh,calc(100vh - 100px),820px);display:flex;flex-direction:column;z-index:2147482000;color-scheme:dark;color:var(--xi1);font-size:12px;line-height:1.45;font-family:ui-monospace,'Cascadia Mono',Consolas,'Microsoft YaHei',monospace;border:1px solid var(--xl2);border-radius:8px;overflow:hidden;background-color:#0b0c0e;background-image:radial-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(180deg,rgba(255,255,255,.025),transparent 46%);background-size:16px 16px,100% 100%;animation:xgg_in .16s cubic-bezier(.2,.7,.3,1)}",
			".xgg_panel::before{content:'';position:absolute;left:6px;top:6px;width:9px;height:9px;border-left:1px solid var(--xl2);border-top:1px solid var(--xl2);pointer-events:none;z-index:2}",
			".xgg_panel::after{content:'';position:absolute;right:6px;bottom:6px;width:9px;height:9px;border-right:1px solid var(--xl2);border-bottom:1px solid var(--xl2);pointer-events:none;z-index:2}",
			"@keyframes xgg_in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}",
			"@media (max-height:720px){.xgg_panel{bottom:12px;max-height:calc(100vh - 24px)}}",
			// --- head ---------------------------------------------------------------
			".xgg_head{position:relative;padding:9px 14px 8px;display:flex;flex-direction:column;gap:8px;flex:none}",
			".xgg_head::after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:1px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.22) 0 5px,transparent 5px 10px)}",
			".xgg_titleRow{display:flex;align-items:center;gap:8px;min-width:0}",
			".xgg_state{width:6px;height:6px;flex:none;border-radius:50%;background:var(--xok);transition:background .25s ease}",
			".xgg_state[data-level=warn]{background:var(--xcpu)}",
			".xgg_state[data-level=crit]{background:var(--xcrit)}",
			".xgg_state[data-level=idle]{background:#3a424b}",
			".xgg_appName{font-size:12px;font-weight:600;letter-spacing:.16em;color:var(--xi1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".xgg_sub{font-size:9.5px;color:var(--xi3);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:236px}",
			".xgg_grow{flex:1;min-width:0}",
			".xgg_chipLine{display:flex;gap:0;flex-wrap:wrap;align-items:center}",
			".xgg_chip{font-size:9.5px;letter-spacing:.02em;padding:1px 8px;border:1px solid var(--xl);border-left:0;color:var(--xi2);background:rgba(255,255,255,.02);font-variant-numeric:tabular-nums}",
			".xgg_chip:first-child{border-left:1px solid var(--xl)}",
			".xgg_chip[data-hot=true]{color:#ffb3b6;border-color:rgba(229,72,77,.45);background:rgba(229,72,77,.10)}",
			".xgg_chip[data-warn=true]{color:#efc684;border-color:rgba(217,154,43,.42);background:rgba(217,154,43,.10)}",
			".xgg_iconBtn{border:1px solid transparent;background:0 0;color:var(--xi3);cursor:pointer;padding:4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;line-height:1;transition:color .12s ease,background .12s ease}",
			".xgg_iconBtn:hover{color:var(--xi1);background:rgba(255,255,255,.06)}",
			".xgg_iconBtn[data-spin=true] svg{animation:xgg_spin 1s linear infinite}",
			"@keyframes xgg_spin{to{transform:rotate(360deg)}}",
			// --- three bays: wireframe cages -----------------------------------------
			".xgg_cluster{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:stretch;height:clamp(156px,22vh,200px)}",
			".xgg_cell{position:relative;padding:8px 10px 7px;border:1px solid var(--xl);background:rgba(255,255,255,.018);overflow:hidden;display:flex;flex-direction:column;min-height:0}",
			".xgg_cell::before{content:'';position:absolute;left:0;top:0;width:11px;height:11px;border-left:1px solid var(--xgg-accent,#35c6d4);border-top:1px solid var(--xgg-accent,#35c6d4);opacity:.75}",
			".xgg_cell::after{content:'';position:absolute;right:0;bottom:0;width:11px;height:11px;border-right:1px solid var(--xgg-accent,#35c6d4);border-bottom:1px solid var(--xgg-accent,#35c6d4);opacity:.4}",
			".xgg_cell>*{position:relative;z-index:1}",
			".xgg_cellHead{display:flex;align-items:center;gap:6px;font-size:9.5px;letter-spacing:.12em;color:var(--xi3);font-weight:500}",
			".xgg_cellHead b{margin-left:auto;font-size:9px;color:#4f5963;font-weight:400;letter-spacing:.08em}",
			".xgg_dial{position:relative;flex:1 1 0;min-height:0;overflow:hidden;margin:1px 0 0}",
			".xgg_dial svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}",
			".xgg_spark{position:relative;height:14px;min-width:0}",
			".xgg_spark:empty{display:none}",
			".xgg_spark svg{display:block;width:100%;height:100%}",
			".xgg_cluster[data-compact=true]{height:auto}",
			".xgg_mini{position:relative;display:flex;align-items:baseline;gap:7px;padding:6px 10px 8px;border:1px solid var(--xl);background:rgba(255,255,255,.018);min-width:0}",
			".xgg_miniLabel{font-size:9.5px;letter-spacing:.12em;color:var(--xi3);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".xgg_miniVal{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--xi1);letter-spacing:-.01em}",
			".xgg_miniBar{position:absolute;left:10px;right:10px;bottom:0;height:2px;background:rgba(255,255,255,.06)}",
			".xgg_miniBar i{position:absolute;left:0;top:0;bottom:0;background:var(--xgg-accent,#35c6d4);opacity:.85}",
			".xgg_cellFoot{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;margin-top:2px;font-size:9.5px;color:var(--xi3);font-variant-numeric:tabular-nums;letter-spacing:.06em;min-height:14px}",
			// --- memory / cores / scope ----------------------------------------------
			".xgg_vitals{display:flex;flex-direction:column;gap:6px;padding:7px 14px 2px}",
			".xgg_ramRow{display:flex;align-items:center;gap:9px}",
			".xgg_ramLabel{font-size:9.5px;letter-spacing:.12em;color:var(--xi3);font-weight:500;width:34px;flex:none}",
			".xgg_ramTrack{position:relative;flex:1;height:6px;border:1px solid var(--xl);background:repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0 1px,transparent 1px 8px);overflow:hidden}",
			".xgg_ramFill{position:absolute;inset:0 auto 0 0;background:repeating-linear-gradient(45deg,rgba(159,176,189,.85) 0 2px,rgba(159,176,189,.28) 2px 5px);transition:width .5s cubic-bezier(.22,.61,.36,1)}",
			".xgg_ramVal{font-size:9.5px;color:var(--xi2);font-variant-numeric:tabular-nums;width:116px;text-align:right;flex:none;letter-spacing:.04em}",
			".xgg_coreRow{display:flex;align-items:center;gap:9px}",
			".xgg_coreLabel{font-size:9.5px;letter-spacing:.12em;color:var(--xi3);font-weight:500;width:52px;flex:none}",
			".xgg_cores{display:flex;gap:2px;flex-wrap:wrap;flex:1;align-items:flex-end}",
			".xgg_core{flex:1 1 0;max-width:12px;min-width:3px;height:13px;background:rgba(255,255,255,.05);position:relative;overflow:hidden}",
			".xgg_coreFill{position:absolute;left:0;right:0;bottom:0;transition:height .4s cubic-bezier(.22,.61,.36,1),background .3s ease}",
			".xgg_trend{display:flex;flex-direction:column;gap:3px}",
			".xgg_scope{position:relative;height:46px;padding:3px 4px;border:1px solid var(--xl);background:rgba(255,255,255,.015);overflow:hidden}",
			".xgg_scope::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:100% 18px,48px 100%;pointer-events:none}",
			".xgg_scope svg{position:relative;display:block;width:100%;height:100%}",
			".xgg_legend{display:flex;gap:14px;font-size:9px;color:var(--xi3);align-items:center;letter-spacing:.1em;font-weight:400}",
			".xgg_legendDot{width:12px;height:1px;display:inline-block;margin-right:5px;vertical-align:middle}",
			// --- body / list -----------------------------------------------------------
			".xgg_body{overflow:auto;padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;scrollbar-width:thin;mask-image:linear-gradient(180deg,#000 calc(100% - 14px),transparent)}",
			".xgg_body>*{flex:none}",
			".xgg_sec{display:flex;align-items:center;gap:9px;font-size:9.5px;font-weight:500;color:var(--xi3);letter-spacing:.12em}",
			".xgg_secLine{flex:1;height:1px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.20) 0 4px,transparent 4px 8px)}",
			".xgg_tabs{display:inline-flex}",
			".xgg_tab{border:1px solid var(--xl);border-right:0;border-radius:0;background:0 0;color:var(--xi3);font:inherit;font-size:9px;letter-spacing:.08em;padding:2px 8px;cursor:pointer;transition:background .12s ease,color .12s ease}",
			".xgg_tab:last-child{border-right:1px solid var(--xl)}",
			".xgg_tab:hover{color:var(--xi1)}",
			".xgg_tab[data-active=true]{background:rgba(53,198,212,.16);color:#bfeef3;font-weight:600}",
			".xgg_row{position:relative;display:flex;flex-direction:column;gap:5px;padding:8px 11px 7px 13px;cursor:pointer;background:rgba(255,255,255,.014);border:1px solid transparent;transition:background .12s ease,border-color .12s ease}",
			".xgg_row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--xgg-row,#35c6d4);opacity:.85}",
			".xgg_row:hover{background:rgba(53,198,212,.06);border-color:rgba(53,198,212,.22)}",
			".xgg_row[data-over=true]::before{background:var(--xcrit)}",
			".xgg_row[data-over=true]{border-color:rgba(229,72,77,.3)}",
			".xgg_rowHead{display:flex;align-items:center;gap:8px;min-width:0}",
			".xgg_rank{width:16px;flex:none;font-size:9px;font-weight:500;color:#4f5963;font-variant-numeric:tabular-nums;letter-spacing:.06em}",
			".xgg_name{font-weight:600;font-size:11px;color:var(--xi1);letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".xgg_tag{flex:none;font-size:8.5px;line-height:14px;padding:0 5px;border:1px solid var(--xl);color:var(--xi3);letter-spacing:.06em;font-weight:400}",
			".xgg_tag[data-basis=workspace]{color:#bfeef3;border-color:rgba(53,198,212,.45);background:rgba(53,198,212,.10)}",
			".xgg_chev{flex:none;color:#3f4852;font-size:11px}",
			".xgg_bars{display:grid;grid-template-columns:1fr 1fr;gap:3px 16px;align-items:center}",
			".xgg_barLine{display:flex;align-items:center;gap:8px}",
			".xgg_barLabel{width:28px;flex:none;font-size:8.5px;color:var(--xi3);text-align:right;letter-spacing:.04em}",
			".xgg_bar{position:relative;height:4px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.07) 0 1px,transparent 1px 6px);border:1px solid rgba(255,255,255,.06);overflow:hidden;flex:1}",
			".xgg_fill{position:absolute;inset:0 auto 0 0;transition:width .45s cubic-bezier(.22,.61,.36,1)}",
			".xgg_budgetMark{position:absolute;top:-2px;bottom:-2px;width:1px;background:var(--xcrit)}",
			".xgg_barVal{width:74px;flex:none;font-size:9px;color:var(--xi2);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;letter-spacing:.02em}",
			".xgg_meta{display:flex;align-items:center;gap:8px;font-size:9px;color:var(--xi3);font-variant-numeric:tabular-nums;letter-spacing:.04em;min-width:0}",
			".xgg_over{color:var(--xcrit);font-weight:600}",
			".xgg_task{font-size:10px;color:var(--xi2);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}",
			// --- detail sheet -------------------------------------------------------------
			".xgg_back{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--xl);background:rgba(255,255,255,.02);color:var(--xi2);font:inherit;font-size:9.5px;letter-spacing:.06em;padding:2px 8px;cursor:pointer;transition:background .12s ease,color .12s ease}",
			".xgg_back:hover{color:var(--xi1);background:rgba(53,198,212,.12)}",
			".xgg_statGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--xl)}",
			".xgg_stat{position:relative;padding:7px 9px;background:#0b0c0e}",
			".xgg_stat::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--xgg-accent,#35c6d4);opacity:.7}",
			".xgg_statK{font-size:8.5px;color:var(--xi3);letter-spacing:.12em;font-weight:400}",
			".xgg_statV{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.5;color:var(--xi1);letter-spacing:-.01em}",
			".xgg_card{border:1px solid var(--xl);background:rgba(255,255,255,.012)}",
			".xgg_cardHead{display:flex;align-items:center;gap:7px;padding:7px 10px;font-size:9px;font-weight:500;color:var(--xi3);letter-spacing:.12em;border-bottom:1px solid var(--xl)}",
			".xgg_kind{font-size:8.5px;font-weight:400;padding:0 5px;color:#bfeef3;border:1px solid rgba(53,198,212,.4);letter-spacing:.06em}",
			".xgg_kvRows{display:flex;flex-direction:column}",
			".xgg_kvRow{display:flex;gap:10px;padding:4px 10px;font-size:10.5px;border-top:1px solid rgba(255,255,255,.06)}",
			".xgg_kvK{width:44px;flex:none;color:var(--xi3);font-size:9.5px;letter-spacing:.08em;font-weight:400}",
			".xgg_kvV{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--xi2)}",
			".xgg_model{display:flex;flex-direction:column;gap:1px;padding:5px 10px;border-top:1px solid rgba(255,255,255,.06)}",
			".xgg_modelName{font-size:10.5px;color:var(--xi1);overflow-wrap:anywhere}",
			".xgg_modelMeta{font-size:9px;color:var(--xi3);overflow-wrap:anywhere;letter-spacing:.04em}",
			".xgg_job{padding:6px 10px;border-top:1px solid rgba(255,255,255,.06)}",
			".xgg_jobTitle{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:500;color:var(--xi1)}",
			".xgg_pill{font-size:8.5px;padding:0 5px;color:var(--xi2);border:1px solid var(--xl);font-variant-numeric:tabular-nums;font-weight:400;letter-spacing:.04em}",
			".xgg_jobPrompt{font-size:9.5px;color:var(--xi3);line-height:1.55;margin-top:2px;overflow-wrap:anywhere}",
			".xgg_emptyNote{padding:11px 10px;font-size:9.5px;color:var(--xi3);line-height:1.6}",
			// --- processes ------------------------------------------------------------------
			".xgg_procs{display:flex;flex-direction:column}",
			".xgg_proc{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.06);min-width:0}",
			".xgg_procHead{display:flex;align-items:center;gap:8px;min-width:0}",
			".xgg_procDot{width:4px;height:4px;flex:none;background:var(--xok)}",
			".xgg_procDot[data-dead=true]{background:#3a424b}",
			".xgg_procName{color:var(--xi1);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}",
			".xgg_procMeta{font-size:9px;color:var(--xi3);letter-spacing:.04em;padding-left:12px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".xgg_paused{color:var(--xcpu);flex:none}",
			".xgg_procActions{display:flex;gap:5px;margin-left:auto;flex:none}",
			// --- buttons / inputs --------------------------------------------------------------
			".xgg_btn{border:1px solid var(--xl);background:0 0;color:var(--xi2);padding:2px 8px;font:inherit;font-size:9px;letter-spacing:.08em;cursor:pointer;line-height:15px;white-space:nowrap;font-weight:400;transition:background .12s ease,color .12s ease,border-color .12s ease}",
			".xgg_btn:hover:not(:disabled){background:rgba(53,198,212,.14);color:var(--xi1);border-color:rgba(53,198,212,.4)}",
			".xgg_btn:disabled{opacity:.28;cursor:default}",
			".xgg_btn[data-danger=true]{color:#f0a3a6;border-color:rgba(229,72,77,.4)}",
			".xgg_btn[data-danger=true]:hover:not(:disabled){background:rgba(229,72,77,.18);color:#ffe0e1}",
			".xgg_btn[data-armed=true]{background:var(--xcrit);color:#fff;border-color:var(--xcrit)}",
			".xgg_btn[data-primary=true]{color:#04191c;background:var(--xgpu);border-color:var(--xgpu);font-weight:600}",
			".xgg_btn[data-primary=true]:hover:not(:disabled){background:#6fdfe9;color:#02141a}",
			".xgg_input{width:78px;background:rgba(255,255,255,.03);border:1px solid var(--xl);color:var(--xi1);padding:2px 7px;font:inherit;font-size:10.5px;font-variant-numeric:tabular-nums;outline:none;transition:border-color .12s ease}",
			".xgg_input:focus{border-color:rgba(53,198,212,.6)}",
			".xgg_budgetRow{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--xl);font-size:9.5px;color:var(--xi3)}",
			// --- footer --------------------------------------------------------------------------
			".xgg_foot{border-top:1px solid var(--xl);padding:7px 14px 5px;display:flex;flex-direction:column;gap:7px;flex:none}",".xgg_foot::after{content:'';display:block;height:5px;margin-top:1px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.26) 0 1px,transparent 1px 9px);opacity:.45}",
			".xgg_footRow{display:flex;align-items:center;gap:9px;font-size:9.5px;color:var(--xi3);letter-spacing:.06em}",
			".xgg_footLabel{font-size:9.5px;color:var(--xi3);font-weight:400;white-space:nowrap;letter-spacing:.08em}",
			".xgg_hint{font-size:9px;color:#4f5963;line-height:1.55;letter-spacing:.04em}",
			".xgg_toast{font-size:10px;padding:6px 9px;color:var(--xi1);background:rgba(53,198,212,.10);border-left:1px solid var(--xgpu);line-height:1.45}",
			".xgg_toast[data-kind=error]{color:#ffc2c4;background:rgba(229,72,77,.12);border-left-color:var(--xcrit)}",
			".xgg_toast[data-kind=ok]{color:#a9e8cd;background:rgba(63,178,127,.10);border-left-color:var(--xok)}",
			".xgg_banner{font-size:9.5px;padding:6px 9px;color:#efc684;background:rgba(217,154,43,.10);border-left:1px solid var(--xcpu);line-height:1.45}",
			// --- skeleton / empty -------------------------------------------------------------------
			".xgg_skel{display:flex;flex-direction:column;gap:8px;padding:2px 0}",
			".xgg_skelRow{height:34px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.045) 0 1px,transparent 1px 12px);border:1px solid rgba(255,255,255,.05)}",
			".xgg_empty{padding:24px 12px;text-align:center;color:var(--xi3);font-size:10px;line-height:1.7;letter-spacing:.04em}",
			".xgg_empty b{display:block;color:var(--xi1);font-size:10px;margin-bottom:5px;font-weight:500;letter-spacing:.1em}",
			// --- harness composer: a little tighter ---------------------------------------------------
			// The composer belongs to the client shell, not to this plugin, but the
			// governor badge lives inside it: shaving its vertical gaps keeps the badge
			// on one line and hands the conversation a few rows back. Names come from
			// InputBar.module.css; a shell rename turns this into a no-op, not a break.
			".VERcba_root{padding-bottom:2px !important}",
			".VERcba_root .VERcba_card{gap:9px !important;padding-top:6px !important}",
			".VERcba_root .VERcba_input{min-height:30px !important;padding:2px 8px 0 13px !important}",
			".VERcba_hero .VERcba_input{min-height:42px !important}",
			".VERcba_root .VERcba_row{gap:9px !important;padding:0 8px 4px !important}",
			// Short viewport: the three bays already carry per-bay trends, so the big scope
			// is the redundant one and the ranking list is what the user came for.
			"@media (max-height:620px){.xgg_trend{display:none}}",
			// One soft drop shadow separates the plate from the conversation. The tinted
			// halo and the lit heading gradient that used to sit here read as glow.
			".xgg_panel{box-shadow:0 18px 44px rgba(0,0,0,.55)}",
			// --- motion ------------------------------------------------------------------
			// Motion is feedback, not decoration: one short fade per view change, one slow
			// settle per number change, nothing that loops forever. The previous build ran
			// a rotating sweep, an expanding ping, a header scan line, a hover bloom and
			// pulsing tips at once -- five animations competing is the noise being removed.
			".xgg_panel{border-top-color:rgba(53,198,212,.28)}",
			".xgg_view{animation:xgg_view .18s cubic-bezier(.2,.7,.3,1)}",
			"@keyframes xgg_view{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}",
			".xgg_toast{animation:xgg_view .16s ease-out}",
			// --- flow ---------------------------------------------------------------------
			// A light sweeps across the whole bar: the shine band is as wide as the fill, so
			// the bar lights up end to end as it passes. The dial's bright band travels along
			// the arc the same way (masked to the filled span).
			".xgg_sweep{transform-box:view-box;transform-origin:100px 76px;animation:xgg_sweep 6s linear infinite}",
			"@keyframes xgg_sweep{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
			// Segmented halo dial: needle settles with a spring-ish ease; the cluster
			// plays one ignition bloom per open (never on re-render).
			".xgg_needle{transform-box:view-box;transform-origin:100px 76px;transition:transform .6s cubic-bezier(.34,1.3,.4,1)}",
			".xgg_cluster:not([data-compact=true]){animation:xgg_ignite .5s cubic-bezier(.2,.7,.3,1)}",
			"@keyframes xgg_ignite{from{opacity:.1;transform:scale(.965)}to{opacity:1;transform:none}}",
			".xgg_tickHot{animation:xgg_hot 1.3s ease-in-out infinite}",
			"@keyframes xgg_hot{0%,100%{opacity:.45}50%{opacity:1}}",
			".xgg_panel::before,.xgg_panel::after{animation:xgg_corner 9s ease-in-out infinite}",
			".xgg_panel::after{animation-delay:-4.5s}",
			"@keyframes xgg_corner{0%,100%{opacity:.4}50%{opacity:.9}}",
			".xgg_fill{overflow:hidden}",
			".xgg_fill::after{content:'';position:absolute;top:0;bottom:0;left:0;width:100%;pointer-events:none;background:linear-gradient(100deg,transparent 0%,rgba(255,255,255,.06) 26%,rgba(255,255,255,.40) 50%,rgba(255,255,255,.06) 74%,transparent 100%);transform:translateX(-100%);animation:xgg_shine 2.8s cubic-bezier(.4,0,.2,1) infinite}",
			"@keyframes xgg_shine{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}",
			// Respect the OS setting: the numbers are the product, motion is optional.
			"@media (prefers-reduced-motion:reduce){.xgg_panel,.xgg_view,.xgg_toast,.xgg_sweep,.xgg_fill::after,.xgg_cluster,.xgg_tickHot,.xgg_panel::before,.xgg_panel::after,.xgg_badgeDialFill,.xgg_badgeDialPip,.xgg_bvram[data-hot=true]{animation:none!important}}",
			// --- narrow shells ----------------------------------------------------------------------------
			"@media (max-width:760px){.xgg_badge .xgg_bstat:nth-child(n+3){display:none}}",
			"@media (max-width:640px){.xgg_cluster{grid-template-columns:1fr 1fr}.xgg_statGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}"
		].join("");
		const tagId = "dsh-gpu-governor/GpuPanel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-gpu-governor";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region locales
		const zh = {
			badge: "显卡", badgeHint: "显卡雷达：显卡 / 显存 / 处理器实时监控，点项目看具体模型与任务",
			title: "显卡雷达", vram: "显存", cpu: "处理器", ram: "内存", gpuUtil: "显卡",
			used: "占用", allocatable: "可分配", reserve: "保留余量", load: "利用率",
			util: "利用率", temp: "温度", power: "功耗", top: "项目占用排行", others: "其余项目",
			cores: "核心负载", coreUnit: "核", threadUnit: "线程", trend: "近 10 分钟",
			peak: "峰值", procs: "个进程", pause: "暂停", resume: "恢复", kill: "结束",
			confirmKill: "确认终止", budget: "预算", setBudget: "显存预算 (MiB)", clearBudget: "清除",
			saved: "保存", noBudget: "未设预算", overBudget: "超预算",
			noData: "读取中", collecting: "首次采集较慢，稍等", failed: "操作失败",
			paused: "已暂停（显存仍占用）", resumed: "已恢复", killed: "已终止，显存已释放",
			stale: "数据过期", sampleMs: "采样", every: "刷新", refresh: "刷新", month: "项",
			basisWorkspace: "工作区", basisDesktop: "桌面", basisPath: "路径", basisSoftware: "软件",
			basisSystem: "系统", basisExe: "程序", basisProcess: "进程",
			headroomHint: "可分配 = 剩余 − 保留", killHint: "结束才释放显存；暂停只冻结计算。",
			armedHint: "再点一次终止该进程及其子进程", applied: "个进程",
			noProcesses: "没有活动进程", projectPause: "暂停整个项目", projectResume: "恢复整个项目",
			restartHint: "宿主版本较旧，重启客户端后可用",
			sortVram: "显存", sortCpu: "处理器", sortRam: "内存",
			back: "返回", detailTitle: "项目详情", detailWork: "运行概况", detailModels: "在用的模型",
			detailJobs: "正在跑的任务", detailProcs: "进程", noWork: "未识别到已知引擎（FlowEdge / ComfyUI / Ollama），只有进程级数据。",
			noModels: "当前没有模型驻留记录", noJobs: "当前没有运行中的任务",
			engine: "引擎", endpoint: "端点", loaded: "已加载", running: "运行中", idle: "空闲",
			overBudgetShort: "个超预算", pressureCrit: "显存紧张",
			reserveSuggest: "用建议", reserveHint: "按显存总量的 6% 计算（512MiB–4G），把余量留给桌面与驱动", reserveApplied: "保留已设",
			hostOld: "宿主未重启：处理器与运行概况暂不可用", jobsRunning: "个任务在跑",
			share: "占整卡", memLabel: "内存", loadout: "负载", activeRuns: "正在运行",
			showLess: "关闭", showAll: "全部"
		};
		const en = {
			badge: "GPU", badgeHint: "GPU radar: live GPU / VRAM / CPU monitor; click a project for models and jobs",
			title: "GPU RADAR", vram: "VRAM", cpu: "CPU", ram: "RAM", gpuUtil: "GPU",
			used: "used", allocatable: "allocatable", reserve: "reserve", load: "load",
			util: "util", temp: "temp", power: "power", top: "Resource consumers", others: "other projects",
			cores: "core load", coreUnit: "cores", threadUnit: "T", trend: "last 10 min",
			peak: "peak", procs: "proc(s)", pause: "Pause", resume: "Resume", kill: "Kill",
			confirmKill: "Confirm kill", budget: "Budget", setBudget: "VRAM budget (MiB)", clearBudget: "Clear",
			saved: "Save", noBudget: "no budget", overBudget: "over budget",
			noData: "Reading", collecting: "First sample is slow, hang on", failed: "Action failed",
			paused: "Paused (VRAM still held)", resumed: "Resumed", killed: "Killed, VRAM released",
			stale: "stale", sampleMs: "sample", every: "every", refresh: "Refresh", month: "items",
			basisWorkspace: "workspace", basisDesktop: "desktop", basisPath: "path", basisSoftware: "software",
			basisSystem: "system", basisExe: "binary", basisProcess: "process",
			headroomHint: "allocatable = free − reserve", killHint: "Kill frees VRAM; pause only freezes compute.",
			armedHint: "Click again to kill this process and its children", applied: "proc(s)",
			noProcesses: "no live process", projectPause: "Pause whole project", projectResume: "Resume whole project",
			restartHint: "older Host build, restart the client",
			sortVram: "VRAM", sortCpu: "CPU", sortRam: "RAM",
			back: "Back", detailTitle: "Project detail", detailWork: "Overview", detailModels: "Loaded models",
			detailJobs: "Running jobs", detailProcs: "Processes", noWork: "No known engine (FlowEdge / ComfyUI / Ollama) matched, process data only.",
			noModels: "no model resident", noJobs: "no running job",
			engine: "engine", endpoint: "endpoint", loaded: "loaded", running: "running", idle: "idle",
			overBudgetShort: "over budget", pressureCrit: "VRAM tight",
			reserveSuggest: "suggest", reserveHint: "6% of the board (512MiB-4G), leaving room for the desktop and driver", reserveApplied: "reserve set to",
			hostOld: "Host not restarted: CPU and workload detail unavailable", jobsRunning: "jobs running",
			share: "of board", memLabel: "MEM", loadout: "LOADOUT", activeRuns: "ACTIVE RUNS",
			showLess: "Close", showAll: "All"
		};
		//#endregion
		//#region remote
		const noopCodec = () => ({
			parse: (value) => value,
			safeParse: (value) => ({ success: true, data: value })
		});
		const requestParameter = (typeSymbol) => ({
			name: "request",
			wire: "request",
			source: "json",
			codec: { mode: "strict", typeSymbol, create: noopCodec }
		});
		const TYPERT_REMOTE = {
			package: "dsh-gpu-governor",
			descriptors: [
				{
					id: "dsh-gpu-governor#gpuGovernor/snapshot",
					service: "gpuGovernor",
					namespace: "gpuGovernor",
					method: "snapshot",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "dsh-gpu-governor#gpuGovernor/snapshot:result", create: noopCodec },
					sourceLocation: { file: "lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-gpu-governor#gpuGovernor/act",
					service: "gpuGovernor",
					namespace: "gpuGovernor",
					method: "act",
					invocation: { kind: "direct" },
					parameters: [requestParameter("dsh-gpu-governor/types#GpuActRequest")],
					cancellation: { parameter: "signal" },
					result: { mode: "strict", typeSymbol: "dsh-gpu-governor#gpuGovernor/act:result", create: noopCodec },
					sourceLocation: { file: "lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-gpu-governor#gpuGovernor/setBudget",
					service: "gpuGovernor",
					namespace: "gpuGovernor",
					method: "setBudget",
					invocation: { kind: "direct" },
					parameters: [requestParameter("dsh-gpu-governor/types#GpuBudgetRequest")],
					cancellation: { parameter: "signal" },
					result: { mode: "strict", typeSymbol: "dsh-gpu-governor#gpuGovernor/setBudget:result", create: noopCodec },
					sourceLocation: { file: "lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-gpu-governor#gpuGovernor/setPolicy",
					service: "gpuGovernor",
					namespace: "gpuGovernor",
					method: "setPolicy",
					invocation: { kind: "direct" },
					parameters: [requestParameter("dsh-gpu-governor/types#GpuPolicyRequest")],
					cancellation: { parameter: "signal" },
					result: { mode: "strict", typeSymbol: "dsh-gpu-governor#gpuGovernor/setPolicy:result", create: noopCodec },
					sourceLocation: { file: "lib/client.js", line: 1, column: 1 }
				}
			]
		};
		//#endregion
		//#region helpers
		function gib(mib) {
			if (typeof mib !== "number" || !isFinite(mib)) return "—";
			return (mib / 1024).toFixed(mib >= 10240 ? 0 : 1) + "G";
		}
		function ram(mib) {
			if (typeof mib !== "number" || !isFinite(mib) || mib <= 0) return "—";
			if (mib >= 1024) return (mib / 1024).toFixed(mib >= 10240 ? 0 : 1) + "G";
			return Math.round(mib) + "M";
		}
		function pct(value) {
			if (typeof value !== "number" || !isFinite(value)) return "0%";
			return Math.round(value) + "%";
		}
		/** Unwrap the Gateway Result envelope into a value or an error message. */
		function unwrap(result) {
			if (result !== null && typeof result === "object" && result.ok === true) return { value: result.value };
			const error = result?.error;
			const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Remote call failed";
			return { error: message };
		}
		/** Three-tier severity for board occupancy (>=92% critical, >=80% warning). */
		function levelOf(ratio) {
			if (ratio >= 0.92) return "crit";
			if (ratio >= 0.8) return "warn";
			return "ok";
		}
		function colorOf(level) {
			if (level === "crit") return "#c8454a";
			if (level === "warn") return "#b98a2f";
			return "#5b6a76";
		}
		const ACCENT = {
			gpu: "#35c6d4",
			vram: "#8a78e8",
			cpu: "#d99a2b",
			ram: "#7d8a96"
		};
		// The Host half still emits English keys and a few English phrasings; the panel is
		// Chinese, so translate at the display boundary instead of asking for a restart.
		const KV_KEY = {
			engine: "引擎", services: "服务", jobs: "任务", endpoint: "端点", loaded: "已加载",
			models: "模型", model: "模型", pid: "进程号", port: "端口", base: "地址",
			workspace: "项目", runner: "运行器", gpu: "显卡", cpu: "处理器", vram: "显存",
			vramusage: "显存占用", resident: "驻留权重", modelsource: "模型来源", queue: "队列"
		};
		const KV_VAL = {
			"none running": "未在运行", idle: "空闲", "no live prompt": "无进行中的提示",
			"no model resident": "无模型驻留", "no model": "无模型"
		};
		/** Map a Host-supplied detail key to Chinese; unknown keys pass through. */
		function kvKey(key) {
			const raw = String(key ?? "");
			return KV_KEY[raw.toLowerCase()] ?? raw;
		}
		/** Map a Host-supplied detail value to Chinese, including "N running". */
		function kvValue(value) {
			const raw = String(value ?? "");
			if (KV_VAL[raw] !== undefined) return KV_VAL[raw];
			const running = /^(\d+)\s+running$/.exec(raw);
			return running === null ? raw : running[1] + " 个在跑";
		}
		const basisKey = {
			workspace: "basisWorkspace", desktop: "basisDesktop", path: "basisPath",
			software: "basisSoftware", system: "basisSystem", exe: "basisExe", process: "basisProcess"
		};
		//#endregion
		//#region primitives
		/**
		 * Segmented halo dial (ported from the web panel's final recipe):
		 * 36 LED segments light up as the value flows in (the leading segment burns
		 * hottest), a single needle marks the reading, hairline bezel, red zone past
		 * 82%. Opening the panel plays one ignition bloom; live updates only retint
		 * opacities and rotate the needle — nothing replays.
		 */
		function Dial({ ratio, accent, value, phase = 0 }) {
			const safe = typeof ratio === "number" && isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
			const cx = 100;
			const cy = 76;
			const r = 55;
			const START = 135;
			const SWEEP = 270;
			const SEGMENTS = 36;
			const REDLINE_AT = 0.82;
			const rad = (deg) => (deg * Math.PI) / 180;
			const angleOf = (fraction) => START + SWEEP * Math.max(0, Math.min(1, fraction));
			const point = (fraction, radius) => [
				cx + Math.cos(rad(angleOf(fraction))) * radius,
				cy + Math.sin(rad(angleOf(fraction))) * radius
			];
			const level = levelOf(safe);
			const valueColor = level === "crit" ? "#ffb3b6" : level === "warn" ? "#efc684" : "#e6e9ec";
			const ease = { transition: "opacity .48s cubic-bezier(.33,1,.68,1)" };
			const segs = [];
			const litTo = safe <= 0 ? 0 : Math.max(1, Math.round(safe * SEGMENTS));
			for (let index = 0; index < SEGMENTS; index += 1) {
				const t0 = index / SEGMENTS;
				const t1 = (index + 1) / SEGMENTS;
				const pad = t1 - t0;
				const hot = t1 > REDLINE_AT;
				const [x1, y1] = [cx + Math.cos(rad(START + SWEEP * (t0 + pad * 0.08))) * r, cy + Math.sin(rad(START + SWEEP * (t0 + pad * 0.08))) * r];
				const [x2, y2] = [cx + Math.cos(rad(START + SWEEP * (t1 - pad * 0.30))) * r, cy + Math.sin(rad(START + SWEEP * (t1 - pad * 0.30))) * r];
				const on = index < litTo;
				const lead = on && index === litTo - 1;
				segs.push(h("path", {
					key: index,
					d: `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
					fill: "none",
					stroke: hot ? "#e5484d" : accent,
					strokeWidth: 8,
					strokeLinecap: "butt",
					opacity: on ? (lead ? 1 : 0.78) : (hot ? 0.15 : 0.09),
					style: ease
				}));
			}
			const ticks = [];
			for (let index = 0; index <= 8; index += 1) {
				const fraction = index / 8;
				const red = fraction >= REDLINE_AT;
				const inner = point(fraction, r + 6);
				const outer = point(fraction, r + 11);
				ticks.push(h("line", {
					key: index,
					x1: inner[0], y1: inner[1], x2: outer[0], y2: outer[1],
					className: red && level === "crit" ? "xgg_tickHot" : undefined,
					stroke: red ? "rgba(229,72,77,.60)" : "rgba(255,255,255,.26)",
					strokeWidth: 1.3
				}));
			}
			return h("div", { className: "xgg_dial" }, h("svg", {
				key: "svg", viewBox: "30 8 140 140", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true"
			}, [
				h("circle", { key: "bezel", cx, cy, r: r + 4.6, fill: "none", stroke: "rgba(255,255,255,.10)", strokeWidth: .8 }),
				...ticks,
				...segs,
				h("g", {
					key: "needle", className: "xgg_needle",
					style: { transform: `rotate(${(angleOf(safe) + 90).toFixed(2)}deg)`, animationDelay: `${(-phase * 1.3).toFixed(1)}s` }
				}, [
					h("path", { key: "blade", d: `M${cx - 1.8} ${cy + 6}L${cx + 1.8} ${cy + 6}L${cx + 0.7} ${cy - r + 10}L${cx - 0.7} ${cy - r + 10}Z`, transform: "", fill: level === "crit" ? "#ff8f93" : accent, opacity: .95, style: { filter: `drop-shadow(0 0 3px ${accent})` } })
				]),
				h("circle", { key: "hubOuter", cx, cy, r: 4.6, fill: "#20262c", stroke: "rgba(255,255,255,.22)", strokeWidth: .8 }),
				h("circle", { key: "hub", cx, cy, r: 2.2, fill: level === "crit" ? "#ff8f93" : accent, style: { filter: `drop-shadow(0 0 4px ${accent})` } }),
				h("text", {
					key: "v", x: cx, y: cy + 34, textAnchor: "middle", fill: valueColor,
					fontSize: 22, fontWeight: 700, letterSpacing: "-.03em",
					style: { fontFamily: "ui-monospace,'Cascadia Mono',Consolas,monospace", paintOrder: "stroke", stroke: "#0b0c0e", strokeWidth: 4, strokeLinejoin: "round" }
				}, value)
			]));
		}
		/** Oscilloscope: VRAM occupancy (solid) and CPU load (dashed) over 0-100%. */
		function Scope({ points, totalMiB }) {
			if (!Array.isArray(points) || points.length < 2) return h("div", { className: "xgg_scope" });
			const width = 100;
			const height = 40;
			const series = (values) => values.map((value, index) => {
				const x = (index / (values.length - 1)) * width;
				const y = height - (Math.max(0, Math.min(100, value)) / 100) * (height - 4) - 2;
				return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
			}).join(" ");
			const vram = series(points.map((point) => (totalMiB > 0 ? ((point.usedMiB ?? 0) / totalMiB) * 100 : 0)));
			const cpu = series(points.map((point) => (typeof point.cpuPct === "number" ? point.cpuPct : 0)));
			return h("div", { className: "xgg_scope" }, h("svg", {
				key: "svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none"
			}, [
				h("defs", { key: "defs" }, [h("linearGradient", { key: "g", id: "xgg_scope_fill", x1: "0", y1: "0", x2: "0", y2: "1" }, [
					h("stop", { key: "a", offset: "0%", stopColor: ACCENT.gpu, stopOpacity: "0.10" }),
					h("stop", { key: "b", offset: "100%", stopColor: ACCENT.gpu, stopOpacity: "0" })
				])]),
				h("path", { key: "area", d: `${vram} L${width} ${height} L0 ${height} Z`, fill: "url(#xgg_scope_fill)", stroke: "none" }),
				h("path", {
					key: "vram", d: vram, fill: "none", stroke: ACCENT.gpu, strokeWidth: "1.1",
					strokeLinejoin: "round", vectorEffect: "non-scaling-stroke"
				}),
				h("path", {
					key: "cpu", d: cpu, fill: "none", stroke: ACCENT.cpu, strokeWidth: "1",
					strokeDasharray: "4 3", vectorEffect: "non-scaling-stroke", opacity: "0.95"
				})
			]));
		}

		/**
		 * Mini trend line for one bay: 0-100% fixed scale, so three bays stay comparable.
		 * The dial answers "how much now"; this answers "is it climbing", which is the
		 * question that actually decides whether to start another job.
		 */
		function Spark({ values, color, label }) {
			const list = Array.isArray(values) ? values.filter((value) => typeof value === "number" && isFinite(value)) : [];
			if (list.length < 2) return h("div", { className: "xgg_spark" });
			const width = 100;
			const height = 100;
			const at = (value) => height - (Math.max(0, Math.min(100, value)) / 100) * (height - 8) - 4;
			const path = list.map((value, index) => {
				const x = (index / (list.length - 1)) * width;
				return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${at(value).toFixed(1)}`;
			}).join(" ");
			return h("div", { className: "xgg_spark", title: label }, h("svg", {
				viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": "true"
			}, [
				h("line", { key: "base", x1: 0, y1: height - 4, x2: width, y2: height - 4, stroke: "rgba(255,255,255,.10)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" }),
				h("line", { key: "mid", x1: 0, y1: height / 2, x2: width, y2: height / 2, stroke: "rgba(255,255,255,.05)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" }),
				h("path", { key: "line", d: path, fill: "none", stroke: color, strokeWidth: 1.2, strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" }),
				h("circle", { key: "tip", cx: width - 1.5, cy: at(list[list.length - 1]), r: 1.8, fill: color })
			]));
		}

		/** Per-core RPM strip: one clipped bar per sampled core. */
		function CoreRow({ cores, t }) {
			if (!Array.isArray(cores) || cores.length === 0) return null;
			return h("div", { className: "xgg_coreRow" }, [
				h("span", { key: "l", className: "xgg_coreLabel" }, t("cores")),
				h("div", { key: "bars", className: "xgg_cores" }, cores.map((value, index) => {
					const level = value >= 85 ? "crit" : value >= 50 ? "warn" : "ok";
					return h("span", { key: index, className: "xgg_core", title: `#${index} ${pct(value)}` },
						h("i", {
							className: "xgg_coreFill",
							style: { height: `${Math.max(6, Math.min(100, value))}%`, background: colorOf(level), opacity: level === "ok" ? 0.55 : 1 }
						}));
				})),
				h("span", { key: "c", className: "xgg_barVal", style: { width: "46px" } }, String(cores.length) + " " + t("coreUnit"))
			]);
		}

		/** Horizontal RAM bar with the same segment mask as the project meters. */
		function RamRow({ label, usedMiB, totalMiB, ratio }) {
			return h("div", { className: "xgg_ramRow" }, [
				h("span", { key: "l", className: "xgg_ramLabel" }, label),
				h("div", { key: "t", className: "xgg_ramTrack" },
					h("div", { className: "xgg_ramFill", style: { width: `${Math.min(100, Math.max(0, ratio * 100))}%` } })),
				h("span", { key: "v", className: "xgg_ramVal" }, `${gib(usedMiB)} / ${gib(totalMiB)} · ${pct(ratio * 100)}`)
			]);
		}

		/** One project row: clipped plate, rank tab, two segmented meters. */
		function ProjectRow({ t, group, rank, totalMiB, onOpen }) {
			const vramRatio = totalMiB > 0 ? group.memMiB / totalMiB : 0;
			const cpuRatio = (typeof group.cpuPct === "number" ? group.cpuPct : 0) / 100;
			const level = levelOf(vramRatio);
			const budgetPct = group.budgetMiB !== null && group.budgetMiB > 0 && totalMiB > 0
				? Math.min(100, (group.budgetMiB / totalMiB) * 100)
				: null;
			const hasWork = group.detail !== undefined && group.detail !== null;
			const dominant = vramRatio >= cpuRatio ? ACCENT.vram : ACCENT.cpu;
			const vramFill = level === "crit"
				? "linear-gradient(90deg,#ff5d78,#ffc2cb,#ff5d78)"
				: "linear-gradient(90deg,#6f5cf0,#b7a8ff,#6f5cf0)";
			const cpuFill = "linear-gradient(90deg,#c1872a,#f7c979,#c1872a)";
			return h("div", {
				className: "xgg_row",
				"data-over": group.overBudget ? "true" : "false",
				style: { "--xgg-row": dominant },
				onClick: onOpen,
				title: group.dir || group.label,
				role: "button",
				tabIndex: 0,
				onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") onOpen(); }
			}, [
				h("div", { key: "head", className: "xgg_rowHead" }, [
					h("span", { key: "r", className: "xgg_rank" }, String(rank).padStart(2, "0")),
					h("span", { key: "n", className: "xgg_name xgg_grow" }, group.label),
					hasWork ? h("span", { key: "w", className: "xgg_tag", "data-basis": "workspace" }, group.detail.kind) : null,
					h("span", { key: "b", className: "xgg_tag", "data-basis": group.basis }, t(basisKey[group.basis] ?? "basisProcess"))
				]),
				group.taskLabel ? h("div", { key: "task", className: "xgg_task", title: group.taskSub || group.taskLabel }, group.taskLabel) : null,
				h("div", { key: "bars", className: "xgg_bars" }, [
					h("div", { key: "vram", className: "xgg_barLine" }, [
						h("span", { key: "l", className: "xgg_barLabel" }, t("vram")),
						h("div", { key: "bar", className: "xgg_bar" }, [
							h("div", { key: "f", className: "xgg_fill", style: { width: `${Math.min(100, vramRatio * 100)}%`, backgroundImage: vramFill } }),
							budgetPct === null ? null : h("div", { key: "m", className: "xgg_budgetMark", style: { left: `calc(${budgetPct}% - 1px)` } })
						]),
						h("span", { key: "v", className: "xgg_barVal" }, gib(group.memMiB) + " · " + pct(vramRatio * 100))
					]),
					h("div", { key: "cpu", className: "xgg_barLine" }, [
						h("span", { key: "l", className: "xgg_barLabel" }, t("cpu")),
						h("div", { key: "bar", className: "xgg_bar" },
							h("div", { key: "f", className: "xgg_fill", style: { width: `${Math.min(100, cpuRatio * 100)}%`, backgroundImage: cpuFill } })),
						h("span", { key: "v", className: "xgg_barVal" }, pct(group.cpuPct ?? 0) + " · " + ram(group.ramMiB))
						])
					]),
				h("div", { key: "meta", className: "xgg_meta" }, [
					h("span", { key: "p" }, t("peak") + " " + gib(group.peakMiB ?? group.memMiB)),
					h("span", { key: "s1" }, "/"),
					h("span", { key: "c" }, String(group.processCount ?? 0) + " " + t("procs")),
					group.utilPct > 0 ? h("span", { key: "u" }, "/ " + t("util") + " " + pct(group.utilPct)) : null,
					group.overBudget ? h("span", { key: "o", className: "xgg_over" }, "/ " + t("overBudget")) : null,
					h("span", { key: "sp", className: "xgg_grow" }),
					h("span", { key: "chev", className: "xgg_chev" }, "›")
				])
			]);
		}

		/** Read-only key/value block. */
		function KvRows({ rows }) {
			return h("div", { className: "xgg_kvRows" }, rows.map((row, index) => h("div", { key: index, className: "xgg_kvRow" }, [
				h("span", { key: "k", className: "xgg_kvK" }, row.k),
				h("span", { key: "v", className: "xgg_kvV" }, row.v)
			])));
		}
		//#endregion
		//#region detail sheet
		/**
		 * Project view: readout strip, workload attribution (which model, which
		 * job), process controls and the soft VRAM budget.
		 */
		function ProjectDetail(props) {
			const {
				t, group, data, busy, armedKill, budgetEdit, budgetValue,
				onBack, onPidAction, onProjectAction, onBudgetOpen, onBudgetChange, onBudgetSave, onBudgetClear, onBudgetCancel
			} = props;
			const processes = group.processes ?? [];
			const detail = group.detail ?? null;
			const anySuspended = processes.some((proc) => proc.suspended === true);
			const projectBusy = busy["project:" + group.key] === true;

			const stats = h("div", { className: "xgg_statGrid" }, [
				h("div", { key: "v", className: "xgg_stat", style: { "--xgg-accent": ACCENT.vram } }, [
					h("div", { key: "k", className: "xgg_statK" }, t("vram")),
					h("div", { key: "d", className: "xgg_statV" }, gib(group.memMiB))
				]),
				h("div", { key: "u", className: "xgg_stat", style: { "--xgg-accent": ACCENT.gpu } }, [
					h("div", { key: "k", className: "xgg_statK" }, t("gpuUtil")),
					h("div", { key: "d", className: "xgg_statV" }, pct(group.utilPct ?? 0))
				]),
				h("div", { key: "c", className: "xgg_stat", style: { "--xgg-accent": ACCENT.cpu } }, [
					h("div", { key: "k", className: "xgg_statK" }, t("cpu")),
					h("div", { key: "d", className: "xgg_statV" }, pct(group.cpuPct ?? 0))
				]),
				h("div", { key: "r", className: "xgg_stat", style: { "--xgg-accent": ACCENT.ram } }, [
					h("div", { key: "k", className: "xgg_statK" }, t("ram")),
					h("div", { key: "d", className: "xgg_statV" }, ram(group.ramMiB ?? 0))
				])
			]);

			const workload = detail === null ? null : h("div", { className: "xgg_card" }, [
				h("div", { key: "head", className: "xgg_cardHead" }, [
					h("span", { key: "l", className: "xgg_grow" }, t("detailWork")),
					h("span", { key: "k", className: "xgg_kind" }, detail.kind)
				]),
				h("div", { key: "items" }, h(KvRows, { rows: (detail.items ?? []).map((row) => ({ k: kvKey(row.k), v: kvValue(row.v) })) })),
				(detail.models ?? []).length === 0 ? null : h("div", { key: "models" }, [
					h("div", { key: "h", className: "xgg_cardHead", style: { borderTop: "1px solid rgba(0,229,255,.13)" } }, t("detailModels")),
					...(detail.models ?? []).map((model, index) => h("div", { key: index, className: "xgg_model" }, [
						h("div", { key: "n", className: "xgg_modelName" }, model.name),
						(model.source || model.detail) ? h("div", { key: "m", className: "xgg_modelMeta" }, [model.source, model.detail].filter(Boolean).join(" · ")) : null
					]))
				]),
				h("div", { key: "jobs" }, [
					h("div", { key: "h", className: "xgg_cardHead", style: { borderTop: "1px solid rgba(0,229,255,.13)" } }, [
						h("span", { key: "l", className: "xgg_grow" }, t("detailJobs")),
						h("span", { key: "c" }, String((detail.jobs ?? []).length))
					]),
					(detail.jobs ?? []).length === 0
						? h("div", { key: "none", className: "xgg_emptyNote" }, t("noJobs"))
						: (detail.jobs ?? []).map((job, index) => h("div", { key: index, className: "xgg_job" }, [
							h("div", { key: "t", className: "xgg_jobTitle" }, [
								h("span", { key: "n", className: "xgg_grow" }, job.title),
								job.progress ? h("span", { key: "p", className: "xgg_pill" }, job.progress) : null,
								job.status ? h("span", { key: "s", className: "xgg_pill" }, job.status) : null
							]),
							job.detail ? h("div", { key: "d", className: "xgg_jobPrompt" }, job.detail) : null,
							job.meta ? h("div", { key: "m", className: "xgg_jobPrompt", style: { opacity: ".7" } }, job.meta) : null
						]))
				])
			]);

			const procRows = processes.length === 0
				? h("div", { className: "xgg_emptyNote" }, t("noProcesses"))
				: h("div", { className: "xgg_procs" }, processes.map((proc) => {
					const suspended = proc.suspended === true;
					const armed = armedKill === proc.pid;
					return h("div", { key: proc.pid, className: "xgg_proc" }, [
						h("div", { key: "head", className: "xgg_procHead" }, [
							h("span", { key: "d", className: "xgg_procDot", "data-dead": proc.alive === true ? "false" : "true" }),
							h("span", { key: "n", className: "xgg_procName", title: (proc.task ?? proc.name) + "  ·  " + (proc.cmd || proc.exe || "") }, proc.task ?? proc.name ?? ("pid " + proc.pid)),
							suspended ? h("span", { key: "s", className: "xgg_paused", title: t("paused") }, "⏸") : null,
							h("div", { key: "a", className: "xgg_procActions" }, [
							suspended
								? h("button", {
									key: "resume", type: "button", className: "xgg_btn",
									disabled: busy[proc.pid + ":resume"] === true,
									onClick: () => onPidAction(proc.pid, "resume", group.label)
								}, t("resume"))
								: h("button", {
									key: "pause", type: "button", className: "xgg_btn",
									disabled: busy[proc.pid + ":suspend"] === true || proc.alive !== true,
									title: t("killHint"),
									onClick: () => onPidAction(proc.pid, "suspend", group.label)
								}, t("pause")),
							h("button", {
								key: "kill", type: "button", className: "xgg_btn",
								"data-danger": "true", "data-armed": armed ? "true" : "false",
								disabled: busy[proc.pid + ":kill"] === true || proc.alive !== true,
								title: armed ? t("armedHint") : t("killHint"),
								onClick: () => onPidAction(proc.pid, armed ? "kill-confirmed" : "kill-arm", group.label)
							}, armed ? t("confirmKill") : t("kill"))
							])
						]),
						h("div", { key: "meta", className: "xgg_procMeta" },
							[
								`显存 ${gib(proc.memMiB)}`,
								`处理器 ${pct(proc.cpuPct ?? 0)}`,
								`内存 ${ram(proc.ramMiB ?? 0)}`,
								`进程号 ${String(proc.pid)}`,
								proc.sub ? proc.sub : ""
							].filter((part) => part.length > 0).join("  ·  "))
					]);
				}));

			const budgetRow = h("div", { className: "xgg_budgetRow" }, budgetEdit
				? [
					h("span", { key: "l" }, t("setBudget")),
					h("input", {
						key: "i", className: "xgg_input", type: "number", min: "0",
						value: budgetValue, autoFocus: true,
						onChange: (event) => onBudgetChange(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") onBudgetSave(group.key);
							if (event.key === "Escape") onBudgetCancel();
						}
					}),
					h("button", { key: "s", type: "button", className: "xgg_btn", onClick: () => onBudgetSave(group.key) }, t("saved")),
					h("button", { key: "c", type: "button", className: "xgg_btn", onClick: () => onBudgetClear(group.key) }, t("clearBudget")),
					h("button", { key: "x", type: "button", className: "xgg_btn", onClick: onBudgetCancel }, "×")
				]
				: [
					h("span", { key: "l" }, group.budgetMiB === null ? t("noBudget") : t("budget") + " " + String(group.budgetMiB) + " MiB"),
					h("button", {
						key: "e", type: "button", className: "xgg_btn",
						style: { marginLeft: "auto" },
						onClick: (event) => { event.stopPropagation(); onBudgetOpen(group); }
					}, t("budget"))
				]);

			return h("div", { key: "detail-body", className: "xgg_body xgg_view" }, [
				h("div", { key: "top", className: "xgg_rowHead", style: { gap: "8px" } }, [
					h("button", { key: "b", type: "button", className: "xgg_back", onClick: onBack }, "‹ " + t("back")),
					h("span", { key: "n", className: "xgg_name xgg_grow" }, group.label),
					h("button", {
						key: "p", type: "button", className: "xgg_btn", "data-primary": "true",
						disabled: projectBusy,
						title: anySuspended ? t("projectResume") : t("projectPause"),
						onClick: () => onProjectAction(group.key, anySuspended ? "resume" : "suspend", group.label)
					}, anySuspended ? t("resume") : t("pause"))
				]),
				group.taskLabel ? h("div", { key: "task", className: "xgg_task", title: group.taskSub || group.taskLabel }, group.taskLabel) : null,
				group.dir ? h("div", { key: "dir", className: "xgg_hint", title: group.dir }, group.dir) : null,
				stats,
				workload === null ? h("div", { key: "nowork", className: "xgg_emptyNote" }, t("noWork")) : workload,
				h("div", { key: "procs", className: "xgg_card" }, [
					h("div", { key: "h", className: "xgg_cardHead" }, [
						h("span", { key: "l", className: "xgg_grow" }, t("detailProcs")),
						h("span", { key: "c" }, String(processes.length))
					]),
					h("div", { key: "rows" }, procRows),
					budgetRow
				])
			]);
		}
		//#endregion
		//#region component
		/** Composer badge plus the observatory cockpit. */
		function GpuGovernorButton(props) {
			const t = props.t;
			const snapshot = props.snapshot;
			const act = props.act;
			const setBudget = props.setBudget;
			const setPolicy = props.setPolicy;
			const [open, setOpen] = React.useState(false);
			const [view, setView] = React.useState(null);
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState({});
			const [armedKill, setArmedKill] = React.useState(null);
			const [toast, setToast] = React.useState(null);
			const [budgetEdit, setBudgetEdit] = React.useState(null);
			const [budgetValue, setBudgetValue] = React.useState("");
			const [reserveValue, setReserveValue] = React.useState("");
			const [sortMode, setSortMode] = React.useState("vram");
			const [refreshToken, setRefreshToken] = React.useState(0);
			const [refreshing, setRefreshing] = React.useState(false);
			const aliveRef = React.useRef(true);
			const openRef = React.useRef(open);
			const badgeRef = React.useRef(null);
			const panelRef = React.useRef(null);
			// Fallback trend when the Host half is an older build without history.
			const localHistoryRef = React.useRef([]);
			openRef.current = open;
			React.useEffect(() => () => { aliveRef.current = false; }, []);
			const flash = React.useCallback((kind, text) => {
				setToast({ kind, text });
				window.setTimeout(() => {
					if (aliveRef.current) setToast((current) => (current !== null && current.text === text ? null : current));
				}, 4000);
			}, []);
			React.useEffect(() => {
				let timer = null;
				let cancelled = false;
				const tick = async () => {
					try {
						const result = await snapshot();
						if (cancelled || !aliveRef.current) return;
						const next = unwrap(result);
						if (next.error !== undefined) {
							setError(next.error);
						} else {
							setError(null);
							setData(next.value);
							const reserved = next.value?.reservedMiB;
							setReserveValue((current) => (current.length === 0 && typeof reserved === "number" ? String(reserved) : current));
							const board = next.value?.gpu;
							if (board !== null && board !== undefined && typeof board.usedMiB === "number") {
								const points = localHistoryRef.current;
								points.push({
									t: Date.now(),
									usedMiB: board.usedMiB,
									utilPct: Math.round(board.utilPct ?? 0),
									cpuPct: Math.round(next.value?.cpu?.utilPct ?? 0)
								});
								if (points.length > 150) points.shift();
							}
						}
					} catch (failure) {
						if (!cancelled && aliveRef.current) setError(failure instanceof Error ? failure.message : String(failure));
					} finally {
						if (!cancelled && aliveRef.current) {
							setRefreshing(false);
							timer = window.setTimeout(tick, openRef.current ? 2500 : 6000);
						}
					}
				};
				tick();
				return () => {
					cancelled = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [snapshot, refreshToken]);
			React.useEffect(() => {
				if (!open) return void 0;
				const onPointerDown = (event) => {
					const panel = panelRef.current;
					const badge = badgeRef.current;
					if (panel !== null && panel.contains(event.target)) return;
					if (badge !== null && badge.contains(event.target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (view !== null) setView(null);
					else setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("mousedown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open, view]);

			const gpu = data?.gpu ?? null;
			const cpu = data?.cpu ?? null;
			const projects = React.useMemo(() => {
				const rows = Array.isArray(data?.projects) ? data.projects : null;
				if (rows !== null) return rows;
				const byKey = new Map((data?.top ?? []).map((row) => [row.key, row.processes ?? []]));
				return (data?.all ?? data?.top ?? []).map((row) => ({ ...row, processes: row.processes ?? byKey.get(row.key) ?? [] }));
			}, [data]);
			const sorted = React.useMemo(() => {
				const copy = [...projects];
				if (sortMode === "cpu") copy.sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
				else if (sortMode === "ram") copy.sort((a, b) => (b.ramMiB ?? 0) - (a.ramMiB ?? 0));
				else copy.sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0));
				return copy;
			}, [projects, sortMode]);
			const usedRatio = gpu === null || gpu.totalMiB <= 0 ? 0 : gpu.usedMiB / gpu.totalMiB;
			const level = gpu === null ? "idle" : levelOf(usedRatio);
			const stale = data !== null && data.stale === true;
			const hostOld = data !== null && data.projects === undefined;
			const ramInfo = cpu?.ram ?? null;

			const refresh = () => {
				setRefreshing(true);
				setRefreshToken((current) => current + 1);
			};

			const runAction = async (payload, busyKey, doneKey) => {
				setBusy((current) => ({ ...current, [busyKey]: true }));
				try {
					const result = await act(payload);
					const next = unwrap(result);
					if (next.error !== undefined) {
						const legacy = /controllable|unknown-pid|bad-pid/i.test(next.error);
						flash("error", legacy ? next.error + " · " + t("restartHint") : next.error);
					} else if (next.value?.ok !== true) {
						const applied = next.value?.applied;
						const failed = next.value?.failed;
						flash("error", typeof applied === "number"
							? `${next.value?.message ?? t("failed")} (${String(applied)}/${String(applied + failed)})`
							: next.value?.message ?? t("failed"));
					} else {
						const count = next.value?.applied;
						flash("ok", typeof count === "number" && count > 1 ? `${String(count)} ${t("applied")}` : t(doneKey));
					}
				} catch (failure) {
					flash("error", failure instanceof Error ? failure.message : String(failure));
				} finally {
					if (aliveRef.current) {
						setBusy((current) => { const clone = { ...current }; delete clone[busyKey]; return clone; });
						setRefreshToken((current) => current + 1);
					}
				}
			};

			const onPidAction = (pid, action, label) => {
				if (action === "kill-arm") {
					setArmedKill(pid);
					window.setTimeout(() => {
						if (aliveRef.current) setArmedKill((current) => (current === pid ? null : current));
					}, 4000);
					return;
				}
				setArmedKill(null);
				const real = action === "kill-confirmed" ? "kill" : action;
				const doneKey = real === "suspend" ? "paused" : real === "resume" ? "resumed" : "killed";
				runAction({ pid, action: real, label }, pid + ":" + real, doneKey);
			};
			const onProjectAction = (project, action, label) => {
				const doneKey = action === "suspend" ? "paused" : "resumed";
				runAction({ project, action, label }, "project:" + project, doneKey);
			};
			const openBudget = (group) => {
				setBudgetEdit(group.key);
				setBudgetValue(group.budgetMiB === null ? "" : String(group.budgetMiB));
			};
			const saveBudget = async (project) => {
				const parsed = Number(budgetValue);
				if (!isFinite(parsed) || parsed < 0) {
					flash("error", t("setBudget"));
					return;
				}
				try {
					const result = await setBudget({ project, budgetMiB: Math.round(parsed) });
					const next = unwrap(result);
					if (next.error !== undefined) flash("error", next.error);
					else {
						flash("ok", t("saved"));
						setBudgetEdit(null);
						setRefreshToken((current) => current + 1);
					}
				} catch (failure) {
					flash("error", failure instanceof Error ? failure.message : String(failure));
				}
			};
			const saveReserve = async () => {
				const parsed = Number(reserveValue);
				if (!isFinite(parsed) || parsed < 0) return;
				try {
					const result = await setPolicy({ reservedMiB: Math.round(parsed) });
					const next = unwrap(result);
					if (next.error !== undefined) flash("error", next.error);
					else {
						flash("ok", t("saved"));
						setRefreshToken((current) => current + 1);
					}
				} catch (failure) {
					flash("error", failure instanceof Error ? failure.message : String(failure));
				}
			};

			// A reserve that came from a habit ("2048") vs one from the board size: offer
			// the computed suggestion once, instead of silently overriding a chosen value.
			const applySuggestedReserve = async () => {
				if (data === null || typeof data.reserveSuggestedMiB !== "number") return;
				const target = Math.round(data.reserveSuggestedMiB);
				try {
					const result = await setPolicy({ reservedMiB: target });
					const next = unwrap(result);
					if (next.error !== undefined) flash("error", next.error);
					else {
						setReserveValue(String(target));
						flash("ok", t("reserveApplied") + " " + gib(target));
						setRefreshToken((current) => current + 1);
					}
				} catch (failure) {
					flash("error", failure instanceof Error ? failure.message : String(failure));
				}
			};

			// ---- badge ---------------------------------------------------------
			// The Host already grades pressure (80% / 92%); re-deriving it here would let the
			// two disagree after a policy change. Fall back to the local verdict only when
			// the snapshot predates the field.
			const dotLevel = stale ? "idle" : (typeof data?.pressure === "string" && data.pressure.length > 0 ? data.pressure : level);
			const vramFrac = gpu === null || !gpu.totalMiB ? 0 : Math.min(1, Math.max(0, gpu.usedMiB / gpu.totalMiB));
			const badge = h("button", {
				key: "badge",
				ref: badgeRef,
				type: "button",
				className: "xgg_badge",
				"data-live": stale || gpu === null ? "false" : "true",
				title: error === null ? t("badgeHint") : String(error),
				"aria-label": t("badgeHint"),
				"aria-expanded": open,
				onMouseDown: (event) => event.preventDefault(),
				onClick: () => setOpen((current) => !current)
			}, [
				h("svg", { key: "dial", className: "xgg_badgeDial", viewBox: "0 0 20 20", "aria-hidden": "true" }, [
					h("circle", { key: "bg", className: "xgg_badgeDialBack", cx: 10, cy: 10, r: 10 }),
					h("circle", { key: "track", className: "xgg_badgeDialTrack", cx: 10, cy: 10, r: 7 }),
					h("circle", { key: "fill", className: "xgg_badgeDialFill", cx: 10, cy: 10, r: 7, "data-level": dotLevel, strokeDasharray: (vramFrac * 43.98).toFixed(2) + " 43.98" }),
					h("circle", { key: "pip", className: "xgg_badgeDialPip", cx: 10, cy: 3, r: 1.6, "data-level": dotLevel })
				]),
				h("span", { key: "g", className: "xgg_bstat" }, [
					h("i", { key: "k", className: "xgg_bk" }, t("gpuUtil")),
					h("b", { key: "v", className: "xgg_bgpu" }, gpu === null ? (error === null ? "—" : "⚠") : pct(gpu.utilPct))
				]),
				gpu === null ? null : h("span", { key: "m", className: "xgg_bstat" }, [
					h("i", { key: "k", className: "xgg_bk" }, t("vram")),
					h("b", { key: "v", className: "xgg_bvram", "data-hot": vramFrac >= 0.9 ? "true" : "false" }, gib(gpu.usedMiB).replace(/G$/, "") + "/" + gib(gpu.totalMiB))
				]),
				cpu === null ? null : h("span", { key: "c", className: "xgg_bstat" }, [
					h("i", { key: "k", className: "xgg_bk" }, t("cpu")),
					h("b", { key: "v", className: "xgg_bcpu" }, pct(cpu.utilPct))
				]),
				h("span", { key: "meter", className: "xgg_badgeMeter", "data-level": dotLevel, style: { width: (vramFrac * 100).toFixed(1) + "%" } })
			]);

			if (!open) return badge;

			// ---- cockpit header + cluster --------------------------------------
			const flowedge = data?.workloads?.flowedge ?? null;
			const headerTitle = flowedge !== null
				? (flowedge.runningJobs > 0 ? `${String(flowedge.runningJobs)} ${t("jobsRunning")}` : t("idle"))
				: t("idle");
			// Trend inputs for the three bays. Fixed 0-100 scale on purpose: a per-series
			// max would make a 3% wiggle look like a mountain.
			const historyPoints = Array.isArray(data?.history) ? data.history : [];
			const boardMiB = gpu?.totalMiB ?? 0;
			const trend = {
				gpu: historyPoints.map((point) => Math.max(0, Math.min(100, point.utilPct ?? 0))),
				vram: historyPoints.map((point) => (boardMiB > 0 ? ((point.usedMiB ?? 0) / boardMiB) * 100 : 0)),
				cpu: historyPoints.map((point) => Math.max(0, Math.min(100, point.cpuPct ?? 0)))
			};

			const header = h("div", { key: "header", className: "xgg_head" }, [
				h("div", { key: "title", className: "xgg_titleRow" }, [
					h("span", { key: "dot", className: "xgg_state", "data-level": dotLevel }),
					h("span", { key: "name", className: "xgg_appName" }, t("title")),
					h("span", { key: "sub", className: "xgg_sub" }, headerTitle + (gpu === null ? "" : " · " + gpu.name)),
					h("span", { key: "sp", className: "xgg_grow" }),
					h("button", {
						key: "refresh", type: "button", className: "xgg_iconBtn",
						"data-spin": refreshing ? "true" : "false",
						title: t("refresh"), "aria-label": t("refresh"),
						onClick: refresh
					}, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }, [
						h("path", { key: "arc", d: "M13.5 8a5.5 5.5 0 1 1-1.9-4.2" }),
						h("path", { key: "tip", d: "M13.6 1.9v3.1h-3.1" })
					])),
					h("button", {
						key: "close", type: "button", className: "xgg_iconBtn",
						title: t("showLess"), "aria-label": t("showLess"),
						onClick: () => setOpen(false)
					}, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }, [
						h("path", { key: "x", d: "M4 4l8 8M12 4l-8 8" })
					]))
				]),
				h("div", { key: "chipLine", className: "xgg_chipLine" }, [
					h("span", { key: "v", className: "xgg_chip" }, t("vram") + " " + gib(gpu?.usedMiB ?? 0) + " / " + gib(gpu?.totalMiB ?? 0)),
					h("span", { key: "r", className: "xgg_chip" }, t("ram") + " " + gib(ramInfo?.usedMiB ?? 0) + " / " + gib(ramInfo?.totalMiB ?? 0)),
					h("span", { key: "p", className: "xgg_chip" }, String(data?.processCount ?? 0) + " " + t("procs")),
					typeof data?.overBudgetCount === "number" && data.overBudgetCount > 0
					? h("span", { key: "ob", className: "xgg_chip", "data-hot": "true" },
						String(data.overBudgetCount) + " " + t("overBudgetShort"))
					: null,
				hostOld ? h("span", { key: "old", className: "xgg_chip", "data-warn": "true" }, t("hostOld")) : null
				]),
			gpu === null && cpu === null ? null : view !== null
				? h("div", { key: "cluster", className: "xgg_cluster", "data-compact": "true" }, [
					h("div", { key: "gpu", className: "xgg_mini", style: { "--xgg-accent": ACCENT.gpu } }, [
						h("i", { key: "dot", className: "xgg_cellDot" }),
						h("span", { key: "l", className: "xgg_miniLabel" }, t("gpuUtil")),
						h("span", { key: "v", className: "xgg_miniVal" }, pct(gpu?.utilPct ?? 0)),
						h("div", { key: "bar", className: "xgg_miniBar" }, h("i", { style: { width: pct(gpu?.utilPct ?? 0) } }))
					]),
					h("div", { key: "vram", className: "xgg_mini", style: { "--xgg-accent": ACCENT.vram } }, [
						h("i", { key: "dot", className: "xgg_cellDot" }),
						h("span", { key: "l", className: "xgg_miniLabel" }, t("vram")),
						h("span", { key: "v", className: "xgg_miniVal" }, pct(usedRatio * 100)),
						h("div", { key: "bar", className: "xgg_miniBar" }, h("i", { style: { width: pct(usedRatio * 100) } }))
					]),
					h("div", { key: "cpu", className: "xgg_mini", style: { "--xgg-accent": ACCENT.cpu } }, [
						h("i", { key: "dot", className: "xgg_cellDot" }),
						h("span", { key: "l", className: "xgg_miniLabel" }, t("cpu")),
						h("span", { key: "v", className: "xgg_miniVal" }, pct(cpu?.utilPct ?? 0)),
						h("div", { key: "bar", className: "xgg_miniBar" }, h("i", { style: { width: pct(cpu?.utilPct ?? 0) } }))
					]),
				])
				: h("div", { key: "cluster", className: "xgg_cluster" }, [
					h("div", { key: "gpu", className: "xgg_cell", style: { "--xgg-accent": ACCENT.gpu } }, [
						h("div", { key: "h", className: "xgg_cellHead" }, [h("i", { key: "dot", className: "xgg_cellDot" }), t("gpuUtil"), h("b", { key: "b" }, t("util"))]),
						h(Dial, { key: "d", phase: 0, ratio: (gpu?.utilPct ?? 0) / 100, accent: ACCENT.gpu, value: pct(gpu?.utilPct ?? 0) }),
						h("div", { key: "f", className: "xgg_cellFoot" }, [
							h("span", { key: "a" }, (gpu?.tempC ?? "—") + "°C"),
							h(Spark, { key: "s", values: trend.gpu, color: ACCENT.gpu, label: t("trend") }),
							h("span", { key: "b" }, (typeof gpu?.powerW === "number" ? gpu.powerW.toFixed(0) : "—") + "W")
						])
					]),
					h("div", { key: "vram", className: "xgg_cell", style: { "--xgg-accent": ACCENT.vram } }, [
						h("div", { key: "h", className: "xgg_cellHead" }, [h("i", { key: "dot", className: "xgg_cellDot" }), t("vram"), h("b", { key: "b" }, t("used"))]),
						h(Dial, { key: "d", phase: 1, ratio: usedRatio, accent: ACCENT.vram, value: pct(usedRatio * 100) }),
						h("div", { key: "f", className: "xgg_cellFoot" }, [
							h("span", { key: "a" }, gib(gpu?.totalMiB ?? 0)),
							h(Spark, { key: "s", values: trend.vram, color: ACCENT.vram, label: t("trend") }),
							h("span", { key: "b" }, t("allocatable") + " " + gib(data?.headroomMiB ?? 0))
						])
					]),
					h("div", { key: "cpu", className: "xgg_cell", style: { "--xgg-accent": ACCENT.cpu } }, [
						h("div", { key: "h", className: "xgg_cellHead" }, [h("i", { key: "dot", className: "xgg_cellDot" }), t("cpu"), h("b", { key: "b" }, t("load"))]),
						h(Dial, { key: "d", phase: 2, ratio: (cpu?.utilPct ?? 0) / 100, accent: ACCENT.cpu, value: pct(cpu?.utilPct ?? 0) }),
						h("div", { key: "f", className: "xgg_cellFoot" }, [
							h("span", { key: "a" }, String(cpu?.logicalCores ?? "—") + t("threadUnit")),
							h(Spark, { key: "s", values: trend.cpu, color: ACCENT.cpu, label: t("trend") }),
							h("span", { key: "b" }, String(cpu?.coreCount ?? 0) + " " + t("coreUnit"))
						])
					]),
				])
			]);

			// ---- vitals: memory bar + core strip + scope -----------------------
			const vitals = h("div", { key: "vitals", className: "xgg_vitals" }, [
				ramInfo === null ? null : h(RamRow, {
					key: "ram", label: t("memLabel"),
					usedMiB: ramInfo.usedMiB, totalMiB: ramInfo.totalMiB,
					ratio: (ramInfo.pct ?? 0) / 100
				}),
				view === null ? h(CoreRow, { key: "cores", cores: cpu?.cores, t }) : null,
				view === null ? h("div", { key: "scope", className: "xgg_trend" }, [
					h(Scope, {
						key: "s",
						points: Array.isArray(data?.history) && data.history.length >= 2 ? data.history : localHistoryRef.current,
						totalMiB: gpu?.totalMiB ?? 0
					}),
					h("div", { key: "legend", className: "xgg_legend" }, [
						h("span", { key: "v" }, [h("i", { key: "d", className: "xgg_legendDot", style: { background: ACCENT.gpu } }), t("vram")]),
						h("span", { key: "c" }, [h("i", { key: "d", className: "xgg_legendDot", style: { background: ACCENT.cpu } }), t("cpu")]),
						h("span", { key: "sp", className: "xgg_grow" }),
						h("span", { key: "h" }, t("trend"))
						])
					]) : null,
				stale ? h("div", { key: "banner", className: "xgg_banner" }, t("stale") + " · " + Math.round((data.ageMs ?? 0) / 1000) + "s") : null
			]);

			// ---- body ----------------------------------------------------------
			const selected = view === null ? null : (sorted.find((row) => row.key === view) ?? null);
			let body;
			if (data === null) {
				body = h("div", { key: "loading-body", className: "xgg_body" }, [
					error !== null
						? h("div", { key: "err", className: "xgg_empty" }, [h("b", { key: "b" }, t("failed")), error])
						: h("div", { key: "skel", className: "xgg_skel" }, [0, 1, 2].map((index) => h("div", { key: index, className: "xgg_skelRow" })))
				]);
			} else if (selected !== null) {
				body = h(ProjectDetail, {
					key: "detail",
					t, group: selected, data, busy, armedKill, budgetEdit, budgetValue,
					onBack: () => setView(null),
					onPidAction, onProjectAction, onBudgetOpen: openBudget,
					onBudgetChange: setBudgetValue, onBudgetSave: saveBudget,
					onBudgetClear: (project) => { setBudgetValue("0"); saveBudget(project); },
					onBudgetCancel: () => setBudgetEdit(null)
				});
			} else {
				body = h("div", { key: "list-body", className: "xgg_body" }, [
					h("div", { key: "sec", className: "xgg_sec" }, [
						h("span", { key: "l" }, t("top")),
						h("span", { key: "line", className: "xgg_secLine" }),
						h("div", { key: "tabs", className: "xgg_tabs" }, ["vram", "cpu", "ram"].map((mode) => h("button", {
							key: mode, type: "button", className: "xgg_tab",
							"data-active": sortMode === mode ? "true" : "false",
							onClick: () => setSortMode(mode)
						}, t(mode === "vram" ? "sortVram" : mode === "cpu" ? "sortCpu" : "sortRam"))))
					]),
					...sorted.slice(0, 12).map((group, index) => h(ProjectRow, {
						key: group.key,
						t,
						group,
						rank: index + 1,
						totalMiB: gpu?.totalMiB ?? 0,
						onOpen: () => { setView(group.key); setBudgetEdit(null); }
					})),
					sorted.length > 12 ? h("div", { key: "more", className: "xgg_hint" }, t("others") + " " + String(sorted.length - 12)) : null
				]);
			}

			// ---- footer --------------------------------------------------------
			const footer = h("div", { key: "footer", className: "xgg_foot" }, [
				toast === null ? null : h("div", { key: "toast", className: "xgg_toast", "data-kind": toast.kind }, toast.text),
				h("div", { key: "reserve", className: "xgg_footRow" }, [
					h("span", { key: "l", className: "xgg_footLabel", title: t("headroomHint") }, t("reserve") + " (MiB)"),
					h("input", {
						key: "i", className: "xgg_input", type: "number", min: "0",
						value: reserveValue,
						onChange: (event) => setReserveValue(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") saveReserve(); }
					}),
					h("button", { key: "s", type: "button", className: "xgg_btn", onClick: saveReserve }, t("saved")),
				data === null || typeof data.reserveSuggestedMiB !== "number" || Math.abs(data.reserveSuggestedMiB - (typeof data.reservedMiB === "number" ? data.reservedMiB : 0)) < 256
					? null
					: h("button", {
						key: "sug", type: "button", className: "xgg_btn", title: t("reserveHint"),
						onClick: applySuggestedReserve
					}, t("reserveSuggest") + " " + gib(data.reserveSuggestedMiB)),
					h("span", { key: "sp", className: "xgg_grow" }),
					h("span", { key: "info", className: "xgg_hint" }, data === null ? "" : t("sampleMs") + " " + String(data.collector.sampleMs) + "ms / " + (data.collector.intervalMs / 1000).toFixed(0) + "s")
				])
			]);

			return h(React.Fragment, null, [
				badge,
				h("div", { key: "panel", ref: panelRef, className: "xgg_panel", role: "dialog", "aria-modal": "true", "aria-label": t("title"), "data-pressure": dotLevel }, [header, vitals, body, footer])
			]);
		}
		//#endregion
		//#region plugin
		const NS = "gpuGovernor";
		const inject = ["remote", "slots", "locale"];
		/**
		 * Browser half: mount the Remote contribution, register dictionaries, and
		 * place the governor badge beside the composer.
		 * @param ctx - client root context.
		 * @returns the joined Remote and UI disposer.
		 */
		async function apply(ctx) {
			// The service is resolved lazily through this ref: the badge must appear
			// even when the Host half is missing or older, because a visible entry
			// point that reports "service unavailable" beats an icon that silently
			// vanished from the composer.
			const service = { current: null };
			let disposeRemote = null;
			try {
				disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			} catch (error) {
				if (typeof console !== "undefined") console.warn("[gpu-governor] remote mount failed", error);
			}
			const remoteUi = ctx.inject(["remote.gpuGovernor"], (child) => {
				service.current = child.remote.gpuGovernor;
				child.effect(() => () => { service.current = null; }, "gpu-governor: release remote");
			});
			// A Host without this service leaves the inject pending forever; that is
			// fine (the badge renders), but a rejection must not surface as unhandled.
			if (typeof remoteUi?.catch === "function") remoteUi.catch(() => {});
			const unavailable = () => Promise.resolve({
				ok: false,
				error: "gpuGovernor 服务不可用：宿主半未加载或版本过旧，重启桌面客户端后重试"
			});
			const actions = {
				snapshot: () => (service.current === null ? unavailable() : service.current.snapshot()),
				act: (request, signal) => (service.current === null ? unavailable() : service.current.act(request, signal)),
				setBudget: (request, signal) => (service.current === null ? unavailable() : service.current.setBudget(request, signal)),
				setPolicy: (request, signal) => (service.current === null ? unavailable() : service.current.setPolicy(request, signal))
			};
			const ui = ctx.inject(["slots", "locale"], (child) => {
				child.effect(() => child.locale.register(NS, { zh, en }), "gpu-governor: dictionaries");
				child.slots.inject("conversation.input.left", () => child.slots.register({
					name: "conversation.input.left",
					id: "gpu-governor",
					order: 20,
					locale: NS,
					inject: () => actions
				}, GpuGovernorButton));
			});
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				if (typeof remoteUi?.dispose === "function") await remoteUi.dispose();
				if (disposeRemote !== null) await disposeRemote();
				throw error;
			}
			return async () => {
				await ui.dispose();
				if (typeof remoteUi?.dispose === "function") await remoteUi.dispose();
				if (disposeRemote !== null) await disposeRemote();
			};
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});







