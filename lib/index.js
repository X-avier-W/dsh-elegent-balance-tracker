// dsh-elegent-balance-tracker — host half.
// Provides two HTTP routes:
//   GET /api/ebt/balance  — DeepSeek account balance (official API, cached)
//   GET /api/ebt/cost     — current session cost, computed from the
//                                   session log event-by-event (token usage ×
//                                   official peak/off-peak pricing by message time)
// The client half renders the cost line under the composer stats and the
// balance readout next to the sidebar settings button, polling these routes.
//
// The host deliberately imports no third-party packages: the profile loads
// this entry from the plugin's own directory, where only the plugin's own
// files are guaranteed to resolve. All helpers (dsh home resolution, API-key
// refs, pricing) are implemented inline below.
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const name = "dsh-elegent-balance-tracker";
const inject = ["webServer"];

/** Resolve the DSH home directory (mirrors @deepseek-ai/dsh-home-paths). */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  const home = fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh");
  return resolve(home);
}

/** Default configuration; merged over whatever the profile supplies. */
const Config = {
  /** Credential ref resolving to the DeepSeek API key. */
  apiKeyRef: "DEEPSEEK_API_KEY",
  /** Balance endpoint base; empty resolves $DEEPSEEK_BASE_URL then api.deepseek.com. */
  baseURL: "",
  /** Per-model CNY pricing overrides (per 1M tokens), merged over the defaults. */
  prices: {},
  /**
  * Date-gated peak/off-peak price tables, applied per event by its local
  * (Asia/Shanghai) date and hour. Entries: { from: "YYYY-MM-DD", peak: {...}, idle: {...} }.
  */
  priceSchedule: [],
  /** Balance response cache TTL in ms. */
  balanceCacheMs: 60000,
  /** Cost response cache TTL in ms (session logs are re-read on expiry). */
  costCacheMs: 2000,
  /** Optional explicit sessions-root override (default: <dsh home>/sessions). */
  sessionsRoot: ""
};

/**
 * Official DeepSeek prices in CNY per 1M tokens (cache hit / cache miss /
 * output), effective before the 2026-08-17 adjustment.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 */
const DEFAULT_PRICES = {
  "deepseek-v4-flash": { input: 1, cacheRead: 0.02, output: 2 },
  "deepseek-v4-pro": { input: 3, cacheRead: 0.025, output: 6 }
};
/**
 * Date-gated pricing (peak/off-peak). From 2026-08-17 00:00 (Beijing time)
 * DeepSeek moves to peak/off-peak rates: peak 9:00-12:00 and 14:00-18:00
 * (Beijing), off-peak is half the peak price. `from` is the local (Beijing)
 * date from which the entry applies; the latest matching entry wins.
 */
const DEFAULT_PRICE_SCHEDULE = [
  {
    from: "2026-08-17",
    peak: {
      "deepseek-v4-flash": { input: 3, cacheRead: 0.1, output: 9 },
      "deepseek-v4-pro": { input: 9, cacheRead: 0.3, output: 27 }
    },
    idle: {
      "deepseek-v4-flash": { input: 1.5, cacheRead: 0.05, output: 4.5 },
      "deepseek-v4-pro": { input: 4.5, cacheRead: 0.15, output: 13.5 }
    }
  }
];
/** Fallback pricing for models absent from every table. */
const FALLBACK_PRICE = { input: 1, cacheRead: 0.02, output: 2 };

/** Merge user config over the defaults (shallow for nested tables). */
function resolveConfig(config) {
  return {
    ...Config,
    ...(config ?? {}),
    prices: { ...DEFAULT_PRICES, ...(config?.prices ?? {}) },
    priceSchedule: [...DEFAULT_PRICE_SCHEDULE, ...(config?.priceSchedule ?? [])].sort((a, b) => a.from.localeCompare(b.from))
  };
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // 0xFD2FB528 LE

function zstdFrames(data) {
  const starts = [];
  let idx = data.indexOf(ZSTD_MAGIC);
  while (idx !== -1) {
    starts.push(idx);
    idx = data.indexOf(ZSTD_MAGIC, idx + 1);
  }
  return starts;
}

function decodeSessionLog(data) {
  const starts = zstdFrames(data);
  let text = "";
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : data.length;
    try {
      text += zstdDecompressSync(data.subarray(starts[i], end)).toString("utf8");
    } catch {
      // torn/incomplete final frame (live append) — skip
    }
  }
  return text;
}

/**
 * Locate a session's log file under the sessions root by its id directory.
 * Layout: <sessionsRoot>/<workspace slug>/<sessionId>/session.jsonl.zstd
 * @param root - sessions root directory.
 * @param sessionId - UI session id (directory name, e.g. "session-0fbeac5e-...").
 * @returns the log path and its mtime, or null.
 */
function findSessionLog(root, sessionId) {
  if (!/^session-[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === sessionId) {
          for (const logName of ["session.jsonl.zstd", "session.jsonl"]) {
            const logPath = join(full, logName);
            try {
              const lst = statSync(logPath);
              if (lst.size > 0) return { path: logPath, mtimeMs: lst.mtimeMs };
            } catch { /* try next name */ }
          }
          return null;
        }
        const hit = walk(full);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

/** Local (Asia/Shanghai) date key YYYY-MM-DD. */
function shanghaiDayKey(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Hour of day (0-23) in the pricing timezone (Asia/Shanghai). */
function shanghaiHour(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false
  }).formatToParts(new Date(ms));
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(raw) % 24;
}

/** Whether `ms` falls in DeepSeek's peak window (Beijing 9-12 / 14-18). */
function isPeakHour(ms) {
  const h = shanghaiHour(ms);
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * Resolve the price table for one event: the latest schedule entry whose
 * `from` (local date) is <= the event date, then peak/idle by the event's
 * Beijing hour; fall back to the base `prices` table.
 * @returns the price entry and a short regime label.
 */
function priceFor(model, timeMs, prices, schedule) {
  const key = shanghaiDayKey(timeMs);
  let entry = null;
  for (const candidate of schedule) {
    if (candidate.from <= key) entry = candidate;
  }
  if (entry !== null) {
    const peak = isPeakHour(timeMs);
    const table = peak ? entry.peak : entry.idle;
    return {
      price: table[model] ?? FALLBACK_PRICE,
      label: `${entry.from} 起 · ${peak ? "高峰" : "空闲"}`
    };
  }
  return { price: prices[model] ?? FALLBACK_PRICE, label: "现行价格" };
}

/**
 * Compute the billed cost of one assistant step from its usage record.
 * cacheWrite tokens are billed as ordinary (cache-miss) input.
 * @returns cost in CNY, or null when no billable usage is present.
 */
function stepCost(usage, price) {
  if (usage === null || typeof usage !== "object") return null;
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input + cacheRead + cacheWrite + output === 0) return null;
  return {
    cost: (input + cacheWrite) / 1e6 * price.input
      + cacheRead / 1e6 * price.cacheRead
      + output / 1e6 * price.output,
    tokens: { input, cacheRead, cacheWrite, output },
    calls: 1
  };
}

/**
 * Compute the cost of one session from its log: follow `request/header`
 * model switches, then bill every `assistant/message` usage record at the
 * price in force at that event's timestamp.
 * @returns { cost, tokens, calls, steps, pricing } — pricing is the regime
 * label of the most recent billed step.
 */
function computeSessionCost(logPath, prices, schedule) {
  let data;
  try {
    data = readFileSync(logPath);
  } catch {
    return { cost: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, calls: 0, steps: 0, pricing: "无法读取日志" };
  }
  let text;
  try {
    text = decodeSessionLog(data);
  } catch {
    return { cost: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, calls: 0, steps: 0, pricing: "日志解码失败" };
  }
  let currentModel = "(unknown)";
  let totalCost = 0;
  let calls = 0;
  let steps = 0;
  let lastPricing = "";
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "request/header" && ev.data?.header?.config?.model) {
      currentModel = ev.data.header.config.model;
      continue;
    }
    if (ev.type !== "assistant/message") continue;
    const time = typeof ev.time === "number" ? ev.time : Date.now();
    const { price, label } = priceFor(currentModel, time, prices, schedule);
    const billed = stepCost(ev.data?.usage ?? null, price);
    if (billed === null) continue;
    totalCost += billed.cost;
    calls += billed.calls;
    steps += 1;
    tokens.input += billed.tokens.input;
    tokens.cacheRead += billed.tokens.cacheRead;
    tokens.cacheWrite += billed.tokens.cacheWrite;
    tokens.output += billed.tokens.output;
    lastPricing = label;
  }
  return {
    cost: Math.round(totalCost * 10000) / 10000,
    tokens,
    calls,
    steps,
    pricing: lastPricing || "无计费调用"
  };
}

/**
 * Recursively collect every session log under a sessions root.
 * @param root - sessions root directory.
 * @returns array of { sessionId, path, mtimeMs } entries.
 */
function collectAllLogs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry !== "session.jsonl.zstd" && entry !== "session.jsonl") continue;
      if (st.size <= 0) continue;
      const sessionId = /^session-[A-Za-z0-9-]+$/.test(dir.split(/[\\/]/).pop() ?? "") ? dir.split(/[\\/]/).pop() : "";
      out.push({ sessionId, path: full, mtimeMs: st.mtimeMs });
    }
  };
  walk(root);
  return out;
}

function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const prices = resolved.prices;
  const schedule = resolved.priceSchedule;
  let balanceCache = { at: 0, value: null };
  let costCache = { at: 0, value: null, sessionId: "", logPath: "", mtimeMs: 0 };
  /** Per-session cost cache: sessionId -> { mtimeMs, cost } (delta accounting). */
  const sessionCostCache = /* @__PURE__ */ new Map();
  /** All-session total cost at the moment the official balance was last synced. */
  let baselineTotalCost = 0;
  const sessionsRoot = resolved.sessionsRoot !== ""
    ? resolved.sessionsRoot
    : join(resolveDshHome(), "sessions");

  const resolveApiKey = async () => {
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(resolved.apiKeyRef);
      if (hit !== void 0 && typeof hit.value === "string" && hit.value.trim() !== "") return hit.value.trim();
    }
    const ambient = process.env[resolved.apiKeyRef];
    if (ambient !== void 0 && ambient.trim() !== "") return ambient.trim();
    return void 0;
  };

  const balanceBase = () => {
    if (resolved.baseURL !== "") return resolved.baseURL.replace(/\/+$/, "");
    return (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  };

  /** Compute one session's cost and refresh its delta-cache entry. */
  const computeSession = (sessionId) => {
    const hit = findSessionLog(sessionsRoot, sessionId);
    if (hit === null) return null;
    const cached = sessionCostCache.get(sessionId);
    if (cached !== void 0 && cached.mtimeMs === hit.mtimeMs) return cached;
    const value = computeSessionCost(hit.path, prices, schedule);
    const entry = { mtimeMs: hit.mtimeMs, cost: value.cost };
    sessionCostCache.set(sessionId, entry);
    return entry;
  };

  /** Sum of every session's cost (incremental: unchanged logs are cached). */
  const allSessionsTotal = () => {
    let total = 0;
    for (const log of collectAllLogs(sessionsRoot)) {
      if (log.sessionId === "") continue;
      const entry = computeSession(log.sessionId);
      if (entry !== null) total += entry.cost;
    }
    return total;
  };

  const fetchOfficialBalance = async () => {
    const now = Date.now();
    const key = await resolveApiKey();
    if (key === void 0) {
      return { available: false, error: `未配置 API Key（${resolved.apiKeyRef}）` };
    }
    try {
      const res = await fetch(`${balanceBase()}/user/balance`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 200);
        } catch { /* ignore */ }
        return { available: false, error: `balance API ${res.status}: ${detail}` };
      }
      const data = await res.json();
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : void 0;
      return {
        available: data?.is_available === true,
        currency: info?.currency ?? "CNY",
        totalBalance: Number(info?.total_balance),
        grantedBalance: Number(info?.granted_balance),
        toppedUpBalance: Number(info?.topped_up_balance),
        fetchedAt: now
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * Balance view: the official figure (re-synced every balanceCacheMs) minus
   * the session cost accrued since the last sync, so spend made between
   * official refreshes is deducted immediately from a locally estimated
   * balance; the next official sync re-aligns to the exact figure.
   */
  const balanceView = async () => {
    const now = Date.now();
    if (balanceCache.value === null || now - balanceCache.at >= resolved.balanceCacheMs) {
      const fresh = await fetchOfficialBalance();
      if (fresh.available) {
        baselineTotalCost = allSessionsTotal();
        balanceCache = { at: now, value: fresh };
      } else if (balanceCache.value === null) {
        // First sync failed: surface the error, keep trying on the next call.
        balanceCache = { at: now - resolved.balanceCacheMs + 5000, value: { available: false, error: fresh.error } };
      }
    }
    const official = balanceCache.value;
    if (official === null || !official.available) {
      return { official, estimated: null, delta: 0, baselineTotalCost, totalCost: allSessionsTotal() };
    }
    const totalCost = allSessionsTotal();
    const delta = Math.max(0, totalCost - baselineTotalCost);
    const estimated = Math.max(0, Math.round((official.totalBalance - delta) * 10000) / 10000);
    return { official, estimated, delta, baselineTotalCost, totalCost };
  };

  const sessionCost = (sessionId) => {
    const now = Date.now();
    const hit = findSessionLog(sessionsRoot, sessionId);
    if (hit === null) {
      return { ok: false, error: `未找到会话日志（${sessionId}）`, cost: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, calls: 0, steps: 0, pricing: "" };
    }
    if (costCache.sessionId === sessionId
      && costCache.logPath === hit.path
      && costCache.mtimeMs === hit.mtimeMs
      && now - costCache.at < resolved.costCacheMs) {
      return { ok: true, ...costCache.value };
    }
    const value = computeSessionCost(hit.path, prices, schedule);
    sessionCostCache.set(sessionId, { mtimeMs: hit.mtimeMs, cost: value.cost });
    costCache = { at: now, sessionId, logPath: hit.path, mtimeMs: hit.mtimeMs, value };
    return { ok: true, ...value };
  };

  const writeJson = (res, body) => {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(body));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/ebt/balance",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const view = await balanceView();
        writeJson(res, { ok: true, generatedAt: Date.now(), balance: view.official, estimated: view.estimated, delta: view.delta, baselineTotalCost: view.baselineTotalCost, totalCost: view.totalCost });
      } catch (error) {
        writeJson(res, { ok: false, error: error instanceof Error ? error.message : String(error), generatedAt: Date.now() });
      }
    }
  }), "dsh-elegent-balance-tracker: /api/ebt/balance route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/ebt/cost",
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      const sessionId = url.searchParams.get("session") ?? "";
      writeJson(res, {
        ok: true,
        generatedAt: Date.now(),
        session: sessionId,
        ...sessionCost(sessionId)
      });
    }
  }), "dsh-elegent-balance-tracker: /api/ebt/cost route");
}

export { DEFAULT_PRICES, DEFAULT_PRICE_SCHEDULE, apply, collectAllLogs, computeSessionCost, decodeSessionLog, findSessionLog, inject, name };
