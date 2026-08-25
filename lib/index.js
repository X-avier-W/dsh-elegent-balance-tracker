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
  sessionsRoot: "",
  /**
  * Automatic official pricing sync. When enabled, the plugin fetches the
  * official pricing page (https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
  * on startup and every `syncIntervalMs`, parsing model names and peak/off-peak
  * prices so new models and pricing changes are picked up without a release.
  * Priority: explicit user config (prices/priceSchedule) > official sync > built-in defaults.
  */
  priceSync: {
    enabled: true,
    url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    intervalMs: 12 * 3600 * 1000,
    timeoutMs: 10000
  }
};

/**
 * Official DeepSeek prices in CNY per 1M tokens (cache hit / cache miss /
 * output), effective before the 2026-08-17 adjustment.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 */
const DEFAULT_PRICES = {
  "deepseek-v4-flash": { input: 1, cacheRead: 0.02, output: 2 },
  "deepseek-v4-flash-vision-exp": { input: 1, cacheRead: 0.02, output: 2 },
  "deepseek-v4-pro": { input: 3, cacheRead: 0.025, output: 6 }
};
/**
 * Date-gated pricing (peak/off-peak). From 2026-08-17 00:00 (Beijing time)
 * DeepSeek moves to peak/off-peak rates: peak 9:00-12:00 and 14:00-18:00
 * (Beijing), Monday-Friday only — weekends are off-peak all day. `from` is
 * the local (Beijing) date from which the entry applies; the latest matching
 * entry wins.
 */
const DEFAULT_PRICE_SCHEDULE = [
  {
    from: "2026-08-17",
    peak: {
      "deepseek-v4-flash": { input: 3, cacheRead: 0.1, output: 9 },
      "deepseek-v4-flash-vision-exp": { input: 3, cacheRead: 0.1, output: 9 },
      "deepseek-v4-pro": { input: 9, cacheRead: 0.3, output: 27 }
    },
    idle: {
      "deepseek-v4-flash": { input: 1.5, cacheRead: 0.05, output: 4.5 },
      "deepseek-v4-flash-vision-exp": { input: 1.5, cacheRead: 0.05, output: 4.5 },
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
    priceSchedule: [...DEFAULT_PRICE_SCHEDULE, ...(config?.priceSchedule ?? [])].sort((a, b) => a.from.localeCompare(b.from)),
    priceSync: { ...Config.priceSync, ...(config?.priceSync ?? {}) }
  };
}

/**
 * Strip HTML tags/entities from a chunk of the official pricing page into
 * readable text (the page is Docusaurus static HTML with plain text prices).
 * @param html - raw HTML chunk.
 * @returns whitespace-normalized text.
 */
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gs, " ")
    .replace(/<style[^>]*>.*?<\/style>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&yen;/g, "¥")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the official DeepSeek pricing page for model price tables and the
 * peak/off-peak window rule. The page structure (2026-08+):
 *   models listed as deepseek-v4-* ids; the price table emits one compact row
 *   per billing bucket: "百万tokens<kind> 空闲时段 A元 B元 ... 高峰时段 D元 E元 ..."
 *   where the number of prices per side equals the number of billed model
 *   columns — the parser adapts to any column count (new/removed models).
 * @param html - full pricing page HTML.
 * @returns { models, peakRule, sourceNote } or null when the page cannot be parsed.
 */
function parseOfficialPricing(html) {
  const text = htmlToText(html);
  const modelIds = [...new Set(text.match(/deepseek-v4-[a-z0-9-]+/g) ?? [])];
  if (modelIds.length === 0) return null;

  // Each bucket row: kind prefix + "空闲时段 <prices> 高峰时段 <prices>".
  const bucketRe = /百万tokens(输入\s*[（(]缓存命中[）)]|输入\s*[（(]缓存未命中[）)]|输出)\s*空闲时段\s*((?:[0-9.]+元\s*)+)高峰时段\s*((?:[0-9.]+元\s*)+)/g;
  const buckets = [];
  let m;
  while ((m = bucketRe.exec(text)) !== null) {
    const idle = [...m[2].matchAll(/([0-9.]+)元/g)].map((x) => Number(x[1]));
    const peak = [...m[3].matchAll(/([0-9.]+)元/g)].map((x) => Number(x[1]));
    if (idle.length === 0 || idle.length !== peak.length) continue;
    buckets.push({
      kind: m[1].includes("缓存命中") ? "cacheRead" : m[1].includes("未命中") ? "input" : "output",
      idle,
      peak
    });
  }
  if (buckets.length < 3) return null;

  // Column count = number of prices per side. The price table's column order
  // mirrors the model list order; the billed-model set is the intersection of
  // the table columns with the model ids seen on the page.
  const cols = Math.min(...buckets.map((b) => b.idle.length));
  if (cols === 0) return null;

  const byKind = {};
  for (const b of buckets) byKind[b.kind] = b;

  const models = {};
  const targetIds = modelIds.slice(0, cols);
  for (let c = 0; c < cols; c++) {
    const id = targetIds[c];
    const read = (kind) => {
      const cell = byKind[kind];
      if (cell === void 0 || c >= cell.idle.length) return void 0;
      return { idle: cell.idle[c], peak: cell.peak[c] };
    };
    const input = read("input");
    const cacheRead = read("cacheRead");
    const output = read("output");
    if (input === void 0 || output === void 0) continue;
    models[id] = { input, cacheRead: cacheRead ?? input, output };
  }
  if (Object.keys(models).length === 0) return null;

  return { models, peakRule: parsePeakRule(text), sourceNote: "official" };
}

/**
 * Parse the peak-window rule footnote: "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00".
 * @param text - normalized page text.
 * @returns { weekdayOnly, windows } — weekdayOnly true when only Mon-Fri are peak;
 * windows is an array of [startHour, endHour].
 */
function parsePeakRule(text) {
  const ruleMatch = text.match(/高峰时段为北京时间([^（(。]*)/);
  const rule = ruleMatch?.[1] ?? "";
  const weekdayOnly = /周一至周五|周一到周五|工作日/.test(rule) || /周末/.test(text.slice(0, 2000));
  const windows = [];
  const hourPairs = [...text.matchAll(/([0-9]{1,2})\s*:\s*00\s*-\s*([0-9]{1,2})\s*:\s*00/g)];
  for (const m of hourPairs) {
    const s = Number(m[1]);
    const e = Number(m[2]);
    if (Number.isFinite(s) && Number.isFinite(e) && s < e) windows.push([s, e]);
  }
  return { weekdayOnly, windows: windows.length > 0 ? windows : [[9, 12], [14, 18]] };
}

/**
 * Compose a priceSchedule entry list from parsed official data: one entry with
 * `from: "1970-01-01"` (applies to all dates) carrying peak/idle tables.
 * @param parsed - parseOfficialPricing result.
 * @returns schedule entry array.
 */
function officialScheduleFrom(parsed) {
  if (parsed === null || typeof parsed !== "object") return null;
  const peak = {};
  const idle = {};
  for (const [id, p] of Object.entries(parsed.models)) {
    if (typeof p.input === "object" && p.input !== null) {
      peak[id] = { input: p.input.peak, cacheRead: p.cacheRead.peak, output: p.output.peak };
      idle[id] = { input: p.input.idle, cacheRead: p.cacheRead.idle, output: p.output.idle };
    }
  }
  if (Object.keys(peak).length === 0) return null;
  return [{
    from: "1970-01-01",
    weekdayOnly: parsed.peakRule?.weekdayOnly ?? true,
    windows: parsed.peakRule?.windows ?? [[9, 12], [14, 18]],
    peak,
    idle
  }];
}

/** Fetch and parse the official pricing page; returns schedule + models or null. */
async function fetchOfficialPricing(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "accept-language": "zh-CN,zh;q=0.9" } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let html;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  const parsed = parseOfficialPricing(html);
  if (parsed === null) return null;
  const schedule = officialScheduleFrom(parsed);
  if (schedule === null) return null;
  return { schedule, modelIds: Object.keys(parsed.models), peakRule: parsed.peakRule, sourceNote: parsed.sourceNote };
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

/** Weekday (0=Sunday..6=Saturday) in the pricing timezone (Asia/Shanghai). */
function shanghaiWeekday(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short"
  }).formatToParts(new Date(ms));
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const raw = parts.find((p) => p.type === "weekday")?.value ?? "";
  return map[raw] ?? 0;
}

/**
 * Whether `ms` falls in DeepSeek's peak window. Windows are Beijing hours
 * (default 9:00-12:00 and 14:00-18:00); when `weekdayOnly` is true, only
 * Monday-Friday count — weekends are off-peak all day.
 * @param ms - event timestamp.
 * @param weekdayOnly - whether peak applies to weekdays only.
 * @param windows - array of [startHour, endHour] peak windows.
 */
function isPeakHour(ms, weekdayOnly, windows) {
  const h = shanghaiHour(ms);
  if (weekdayOnly) {
    const wd = shanghaiWeekday(ms);
    if (wd === 0 || wd === 6) return false; // weekend: idle all day
  }
  const wins = windows ?? [[9, 12], [14, 18]];
  return wins.some(([s, e]) => h >= s && h < e);
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
    const peak = isPeakHour(timeMs, entry.weekdayOnly === true, entry.windows);
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
  const userPrices = resolved.prices;
  const userSchedule = resolved.priceSchedule;
  /**
  * Effective pricing: mutable, refreshed by official sync when enabled.
  * Priority: explicit user config > official sync > built-in defaults.
  * `schedule` entries may carry `weekdayOnly` / `windows` for peak-window rules.
  */
  let prices = { ...userPrices };
  let schedule = [...userSchedule];
  let priceSyncNote = "";
  const applyOfficialPricing = (fresh) => {
    const nextPrices = { ...DEFAULT_PRICES, ...userPrices };
    const nextSchedule = [...fresh.schedule, ...userSchedule].sort((a, b) => a.from.localeCompare(b.from));
    // models from the official page fill gaps in user config, never override it
    prices = nextPrices;
    schedule = nextSchedule;
    priceSyncNote = `官方同步 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · ${fresh.sourceNote ?? ""}`.trim();
  };
  const syncPricing = async () => {
    if (!resolved.priceSync.enabled) return;
    try {
      const fresh = await fetchOfficialPricing(resolved.priceSync.url, resolved.priceSync.timeoutMs);
      if (fresh !== null) applyOfficialPricing(fresh);
    } catch { /* keep last known prices on network errors */ }
  };
  if (resolved.priceSync.enabled) {
    ctx.effect(() => {
      syncPricing();
      const timer = setInterval(syncPricing, resolved.priceSync.intervalMs);
      return () => clearInterval(timer);
    }, "dsh-elegent-balance-tracker: official pricing sync");
  }
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
        priceSync: priceSyncNote,
        ...sessionCost(sessionId)
      });
    }
  }), "dsh-elegent-balance-tracker: /api/ebt/cost route");
}

export { DEFAULT_PRICES, DEFAULT_PRICE_SCHEDULE, apply, collectAllLogs, computeSessionCost, decodeSessionLog, fetchOfficialPricing, findSessionLog, htmlToText, inject, name, officialScheduleFrom, parseOfficialPricing, parsePeakRule };
