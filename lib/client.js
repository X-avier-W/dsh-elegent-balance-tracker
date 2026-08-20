window.__ModuleLoader__.load({
	id: "dsh-elegent-balance-tracker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region styles
		/**
		* Cost line mirrors the composer StatsLine look (12px, centered, tertiary
		* label) so the "费用" readout reads as part of the same stats block.
		*
		* The balance readout sits on the same row as the sidebar settings
		* button WITHOUT touching any official component or layout: we only add
		* `position: relative` to the sidebar foot area (a no-op visually) to
		* establish a positioning context, then absolutely position our own
		* balance button at its bottom-right, right-aligned with the same 10px
		* inset as the settings trigger's own padding. The settings button and
		* the foot layout keep their original geometry untouched.
		*/
		const css = [
			".dsh-ebt-cost{text-align:center;width:100%;color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin:0 auto;font-size:12px;line-height:20px;display:block;padding:2px calc(var(--dsh-composer-side-clearance) + 16px) 4px}",
			/* positioning context only — does not change the official layout */
			"div[class*=\"footArea\"]{position:relative}",
			".dsh-ebt-balance{position:absolute;bottom:15px;right:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px;line-height:20px;margin:0;padding:0 4px;border:none;background:0 0;cursor:pointer;border-radius:6px;user-select:none;z-index:1}",
			".dsh-ebt-balance:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ebt-balance[data-error=true]{color:var(--dsw-alias-state-error-primary)}",
			/* collapsed rail: keep the compact button in normal flow above the settings button */
			".dsh-ebt-balance-collapsed{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:11px;line-height:20px;border:none;background:0 0;cursor:pointer;padding:0 4px;border-radius:6px;user-select:none}",
			".dsh-ebt-balance-collapsed:hover{color:var(--dsw-alias-label-secondary)}",
			".dsh-ebt-balance-collapsed[data-error=true]{color:var(--dsw-alias-state-error-primary)}"
		].join("");
		const tagId = "dsh-elegent-balance-tracker/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-elegent-balance-tracker";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region locales
		const NS = "dsh-elegent-balance-tracker";
		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			"cost": "费用",
			"balance": "余额",
			"costLine": "费用: {amount}元",
			"balanceLine": "余额: {amount}元",
			"balanceLineShort": "¥{amount}",
			"refresh": "刷新",
			"unavailable": "获取失败",
			"loading": "…",
			"costTitle": "当前会话成本（官方峰谷价按消息时间估算）",
			"alignedAt": "对齐时间",
			"clickRefresh": "点击立即同步官方余额",
			"syncNote": "每分钟自动对齐官方余额；期间按本机会话新增成本实时扣减"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"cost": "Cost",
			"balance": "Balance",
			"costLine": "Cost: ¥{amount}",
			"balanceLine": "Balance: ¥{amount}",
			"balanceLineShort": "¥{amount}",
			"refresh": "Refresh",
			"unavailable": "Unavailable",
			"loading": "…",
			"costTitle": "Current session cost (estimated at official peak/off-peak rates by message time)",
			"alignedAt": "Aligned at",
			"clickRefresh": "Click to sync official balance now",
			"syncNote": "Auto-aligns to the official balance every minute; between syncs, new local session cost is deducted in real time"
		};
		//#endregion
		//#region helpers
		function fmt(n) {
			return Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
		}
		function fmtTime(ms) {
			if (!Number.isFinite(ms)) return "—";
			return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		}
		/** Poll a JSON route; refreshes on interval and on window focus. */
		function useJson(route, intervalMs) {
			const [state, setState] = react.useState({ phase: "loading", data: null, error: null });
			const abortRef = react.useRef(null);
			const load = react.useCallback(async () => {
				if (route === "") return;
				abortRef.current?.abort();
				const ctrl = new AbortController();
				abortRef.current = ctrl;
				try {
					const res = await fetch(route, { signal: ctrl.signal, cache: "no-store" });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const json = await res.json();
					if (json === null || typeof json !== "object" || json.ok !== true) throw new Error(json && json.error ? json.error : "bad response");
					setState({ phase: "ready", data: json, error: null });
				} catch (error) {
					if (error && error.name === "AbortError") return;
					setState((prev) => ({ phase: "error", data: prev.data, error: error instanceof Error ? error.message : String(error) }));
				}
			}, [route]);
			react.useEffect(() => {
				if (route === "") return;
				load();
				const timer = window.setInterval(load, intervalMs);
				const onFocus = () => {
					if (document.visibilityState === "visible") load();
				};
				document.addEventListener("visibilitychange", onFocus);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", onFocus);
					abortRef.current?.abort();
				};
			}, [load, intervalMs]);
			return { state, load };
		}
		//#endregion
		//#region CostLine
		/**
		* Composer dock entry rendered right after the stats line: fetches the
		* current session's cost from the host and prints "费用: x.xx元" in the
		* same style as the stats text. Refreshes when the session id or the
		* tokenUsage projection changes (i.e. after each completed model turn),
		* plus a polling interval as a safety net.
		*/
		function CostLine({ sessionId, useProjection, t }) {
			const usage = useProjection("tokenUsage");
			const { state, load } = useJson(
				sessionId === void 0 ? "" : "/api/ebt/cost?session=" + encodeURIComponent(sessionId),
				15000
			);
			// A changed tokenUsage projection means new billed steps: refresh now.
			react.useEffect(() => {
				if (sessionId !== void 0 && usage !== void 0) load();
			}, [usage, sessionId, load]);
			if (sessionId === void 0) return null;
			const ready = state.data !== null;
			const cost = ready ? state.data.cost : null;
			const pricing = ready && typeof state.data.pricing === "string" ? state.data.pricing : "";
			const label = t("costLine", { amount: fmt(cost) });
			return (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-ebt-cost",
				title: t("costTitle") + (pricing !== "" ? " · " + pricing : ""),
				children: label
			});
		}
		//#endregion
		//#region BalanceWidget
		/**
		* Sidebar footer entry: DeepSeek balance, right-aligned on the settings
		* button's row (absolute-positioned into the foot area — no official
		* component or layout is touched). Shows the host's locally estimated
		* balance: the official figure synced every minute, with new local
		* session cost deducted in between. Clicking re-syncs immediately.
		* The collapsed rail shows a compact "¥x.xx" line above the settings button.
		*/
		function BalanceWidget({ wide, t }) {
			const { state, load } = useJson("/api/ebt/balance", 60000);
			const data = state.data;
			const official = data !== null ? data.balance : null;
			const estimated = data !== null && Number.isFinite(data.estimated) ? data.estimated : null;
			const failed = state.phase === "error" || (official !== null && official !== void 0 && official.error !== void 0);
			// Display the estimated balance (official minus local accrued cost).
			const total = estimated !== null ? estimated : (official !== null && official !== void 0 && Number.isFinite(official.totalBalance) ? official.totalBalance : null);
			const label = total === null
				? (failed ? t("unavailable") : t("loading"))
				: (wide ? t("balanceLine", { amount: fmt(total) }) : t("balanceLineShort", { amount: fmt(total) }));
			// Tooltip: line 1 is the balance itself; line 2 the official-sync
			// align time (cumulative top-up / spend are not exposed by the
			// official API, so there is nothing further to show).
			const lines = [t("balanceLine", { amount: total === null ? "—" : fmt(total) })];
			if (official !== null && official !== void 0 && Number.isFinite(official.fetchedAt)) {
				lines.push(t("alignedAt") + ": " + fmtTime(official.fetchedAt));
			}
			lines.push(t("clickRefresh"));
			const title = lines.join("\n");
			if (!wide) {
				return (0, react_jsx_runtime.jsx)(_primitives.Tooltip, {
					label: title,
					delayMs: 400,
					children: (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-ebt-balance-collapsed",
						"data-error": failed ? "true" : "false",
						"aria-label": title,
						onClick: load,
						children: label
					})
				});
			}
			return (0, react_jsx_runtime.jsx)(_primitives.Tooltip, {
				label: title,
				delayMs: 400,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-ebt-balance",
					"data-error": failed ? "true" : "false",
					"aria-label": title,
					onClick: load,
					children: label
				})
			});
		}
		//#endregion
		//#region index
		const inject = ["slots", "locale"];
		/** Register dictionaries and the two UI entries. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-elegent-balance-tracker: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "dsh-ebt-cost",
				order: 1,
				locale: NS
			}, CostLine));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-ebt-balance",
				locale: NS
			}, BalanceWidget));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
