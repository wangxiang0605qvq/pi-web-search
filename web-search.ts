/**
 * 网络搜索扩展（抗限流版）
 *
 * LLM 工具：web_search(query, count?)
 * 手动命令：/search <关键词>
 *
 * 策略：
 * 1. 若配置了搜索 API Key（TAVILY_API_KEY / SERPER_API_KEY / BRAVE_API_KEY），优先走 API，不爬页面。
 * 2. 否则多引擎降级：Bing → DuckDuckGo → Sogou → 360 → Baidu。
 * 3. 单引擎被限流只冷却该引擎（指数退避 2→4→8→15min），不影响其他引擎。
 * 4. 请求串行 + 最小间隔 + UA 轮换 + 429/503 重试 + 结果缓存 + 失败负缓存。
 *
 * 安装目录：~/.pi/agent/extensions/web-search.ts
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const UAS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
];

const TIMEOUT = 10_000;
const MIN_GAP = 900;
const CACHE_TTL = 5 * 60_000;
const FAIL_TTL = 20_000;
const COOKIE_TTL = 30 * 60_000;
const COOLDOWN_BASE = 60_000;
const COOLDOWN_MAX = 15 * 60_000;
const MAX_RESULTS = 10;

interface Result {
	title: string;
	url: string;
	snippet: string;
}

// 被限流时返回的无关通用结果
const JUNK = /(汉语汉字|漢典|汉语国学|字的意思|中智集团|shidianguji|zdic\.net|请输入验证码|异常流量|安全验证)/;

const cache = new Map<string, { at: number; items: Result[] }>();
let failAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 请求串行化 + 限速 ----
let lastRequest = 0;
let chain: Promise<unknown> = Promise.resolve();
function polite<T>(fn: () => Promise<T>): Promise<T> {
	const p = chain.then(async () => {
		const wait = lastRequest + MIN_GAP - Date.now();
		if (wait > 0) await sleep(wait);
		lastRequest = Date.now();
		return fn();
	});
	chain = p.catch(() => {});
	return p;
}

// ---- 兼容旧运行时的超时/取消：不用 AbortSignal.any ----
function makeSignal(external?: AbortSignal): { signal: AbortSignal; done: () => void } {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
	const onAbort = () => ctrl.abort();
	if (external) {
		if (external.aborted) ctrl.abort();
		else external.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: ctrl.signal,
		done: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

function reqHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"User-Agent": UAS[Math.floor(Math.random() * UAS.length)],
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		"Upgrade-Insecure-Requests": "1",
		...extra,
	};
}

/** 带一次重试的抓取；429/503 读 Retry-After，其余指数退避。 */
async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await polite(() => fetch(url, { ...init, signal }));
			if (res.status !== 429 && res.status !== 503) return res;
			const retryAfter = Number(res.headers.get("retry-after")) * 1000;
			lastError = new Error(`HTTP ${res.status}`);
			if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter, 5_000));
			else await sleep(400 * 2 ** attempt + Math.random() * 300);
		} catch (error) {
			lastError = error;
			if (signal.aborted) throw error;
			await sleep(400 * 2 ** attempt + Math.random() * 300);
		}
	}
	throw lastError;
}

function decodeHtml(s: string): string {
	return s
		.replace(/<[^>]+>/g, "")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;|&ensp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Bing 有时用 /ck/a?u=a1<base64> 包装真实链接 */
function realUrl(href: string): string {
	const m = href.match(/[?&]u=a1([^&]+)/);
	if (!m) return href;
	try {
		const b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
		return Buffer.from(b64, "base64").toString("utf8");
	} catch {
		return href;
	}
}

/** DDG 用 /l/?uddg= 包装真实链接 */
function ddgUrl(href: string): string {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		const real = url.searchParams.get("uddg");
		return real ? decodeURIComponent(real) : href.startsWith("//") ? `https:${href}` : href;
	} catch {
		return href;
	}
}

function parseBing(html: string): Result[] {
	return html
		.split(/<li class="b_algo"/)
		.slice(1)
		.map((block) => {
			const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
			if (!a) return null;
			const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
			return { url: realUrl(a[1]), title: decodeHtml(a[2]), snippet: p ? decodeHtml(p[1]) : "" };
		})
		.filter((r): r is Result => r !== null);
}

function parseDDG(html: string): Result[] {
	const titles = [...html.matchAll(/<a[^>]*class="[^"]*result__a(?![-\w])[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [
		...html.matchAll(/class="[^"]*(?:result__snippet|result-snippet)(?![-\w])[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g),
	];
	return titles
		.map((m, i) => ({
			url: ddgUrl(m[1]),
			title: decodeHtml(m[2]),
			snippet: snippets[i] ? decodeHtml(snippets[i][1]) : "",
		}))
		.filter((r) => r.url.startsWith("http") && r.title.length > 0);
}

function parseSogou(html: string): Result[] {
	return html
		.split('class="vrwrap"')
		.slice(1)
		.map((block) => {
			const a = block.match(/<h3 class="vr-title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
			if (!a) return null;
			const s = block.match(/class="fz-mid[^"]*"[^>]*>([\s\S]*?)<\/div>/);
			const href = block.match(/<a[^>]*name="dttl"[^>]*href="([^"]+)"/);
			return {
				title: decodeHtml(a[1]),
				snippet: s ? decodeHtml(s[1]) : "",
				url: href ? `https://www.sogou.com${href[1]}` : "",
			};
		})
		.filter((r): r is Result => r !== null && r.url !== "");
}

function parseSo360(html: string): Result[] {
	return html
		.split(/<li class="res-list/)
		.slice(1)
		.map((block) => {
			const a = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
			if (!a) return null;
			const p = block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/);
			return { url: a[1], title: decodeHtml(a[2]), snippet: p ? decodeHtml(p[1]) : "" };
		})
		.filter((r): r is Result => r !== null);
}

function parseBaidu(html: string): Result[] {
	return html
		.split(/<div[^>]+class="result[^"]*c-container/)
		.slice(1)
		.map((block) => {
			const a = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
			if (!a) return null;
			const p = block.match(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/);
			return { url: a[1], title: decodeHtml(a[2]), snippet: p ? decodeHtml(p[1]) : "" };
		})
		.filter((r): r is Result => r !== null);
}

interface Engine {
	name: string;
	url: (q: string) => string;
	parse: (html: string) => Result[];
	init?: (signal: AbortSignal) => Promise<void>;
	headers?: () => Record<string, string>;
}

// ---- Bing Cookie 预热（复用可显著降低被限流概率）----
let bingCookies = "";
let bingCookieAt = 0;
async function warmBing(signal: AbortSignal): Promise<void> {
	if (bingCookies && Date.now() - bingCookieAt < COOKIE_TTL) return;
	const res = await polite(() => fetch("https://www.bing.com/", { headers: reqHeaders(), signal }));
	const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
	const list = raw ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
	bingCookies = list.map((c) => c.split(";")[0]).join("; ");
	bingCookieAt = Date.now();
}

const ENGINES: Engine[] = [
	{
		name: "bing",
		url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`,
		parse: parseBing,
		init: warmBing,
		headers: () => (bingCookies ? { Cookie: bingCookies } : {}),
	},
	{
		name: "ddg",
		url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
		parse: parseDDG,
	},
	{
		name: "sogou",
		url: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
		parse: parseSogou,
	},
	{
		name: "360",
		url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
		parse: parseSo360,
	},
	{
		name: "baidu",
		url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=10`,
		parse: parseBaidu,
	},
];

// ---- 可选：官方 API（配置了 Key 就优先用，最稳）----
async function apiSearch(query: string, signal: AbortSignal): Promise<Result[] | null> {
	const { TAVILY_API_KEY, SERPER_API_KEY, BRAVE_API_KEY } = process.env;
	try {
		if (TAVILY_API_KEY) {
			const res = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: MAX_RESULTS }),
				signal,
			});
			if (res.ok) {
				const json: any = await res.json();
				return (json.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
			}
		}
		if (SERPER_API_KEY) {
			const res = await fetch("https://google.serper.dev/search", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
				body: JSON.stringify({ q: query, num: MAX_RESULTS }),
				signal,
			});
			if (res.ok) {
				const json: any = await res.json();
				return (json.organic ?? []).map((r: any) => ({ title: r.title ?? "", url: r.link ?? "", snippet: r.snippet ?? "" }));
			}
		}
		if (BRAVE_API_KEY) {
			const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${MAX_RESULTS}&q=${encodeURIComponent(query)}`, {
				headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_API_KEY },
				signal,
			});
			if (res.ok) {
				const json: any = await res.json();
				return (json.web?.results ?? []).map((r: any) => ({
					title: r.title ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
				}));
			}
		}
	} catch (error) {
		process.stderr.write(`[web-search] API 搜索失败：${String(error)}\n`);
	}
	return null;
}

// ---- 引擎冷却状态 ----
const cooldowns = new Map<string, { until: number; fails: number }>();

/** 多引擎降级：命中一个可用引擎就返回，单引擎失败只冷却它自己。 */
async function searchOnce(query: string, signal: AbortSignal): Promise<Result[]> {
	const api = await apiSearch(query, signal);
	if (api && api.length) return api;

	const errors: string[] = [];
	const cooling: number[] = [];
	for (const engine of ENGINES) {
		const state = cooldowns.get(engine.name);
		if (state && state.until > Date.now()) {
			cooling.push(state.until - Date.now());
			continue;
		}

		try {
			if (engine.init) await engine.init(signal);
			const res = await request(engine.url(query), { headers: reqHeaders(engine.headers?.()) }, signal);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const items = engine.parse(await res.text());
			if (!items.length || items.filter((r) => JUNK.test(r.title)).length >= 2) throw new Error("被限流");
			cooldowns.set(engine.name, { until: 0, fails: 0 });
			return items;
		} catch (error) {
			if (signal.aborted) throw error;
			const fails = (cooldowns.get(engine.name)?.fails ?? 0) + 1;
			const cool = Math.min(COOLDOWN_BASE * 2 ** (fails - 1), COOLDOWN_MAX);
			cooldowns.set(engine.name, { until: Date.now() + cool, fails });
			const reason = error instanceof Error ? error.message : String(error);
			errors.push(`${engine.name}(${reason})`);
			process.stderr.write(`[web-search] ${engine.name} 失败 x${fails}，冷却 ${Math.round(cool / 60_000)}min：${reason}\n`);
		}
	}
	if (!errors.length) {
		const wait = Math.ceil(Math.min(...cooling) / 1000);
		throw new Error(`所有引擎均在限流冷却中，最快 ${wait}s 后重试；也可换个关键词`);
	}
	throw new Error(`所有引擎均限流/失败：${errors.join("；")}。稍后再试或换个关键词`);
}

/** 带缓存 + 负缓存 + 超时/取消包装的入口 */
async function getResults(query: string, external?: AbortSignal): Promise<Result[]> {
	const hit = cache.get(query);
	if (hit && Date.now() - hit.at <= CACHE_TTL) return hit.items;
	if (!hit && Date.now() - failAt < FAIL_TTL) throw new Error("刚刚搜索失败，请 20 秒后重试");

	const { signal, done } = makeSignal(external);
	try {
		const items = await searchOnce(query, signal);
		cache.set(query, { at: Date.now(), items });
		failAt = 0;
		return items;
	} catch (error) {
		failAt = Date.now();
		throw error;
	} finally {
		done();
	}
}

const webSearch = defineTool({
	name: "web_search",
	label: "Web Search",
	description: "通过搜索引擎查询实时网络信息。输入关键词，返回标题、链接和摘要。",
	promptSnippet: "搜索网络获取实时信息（新闻、文档、事实等）",
	parameters: Type.Object({
		query: Type.String({ description: "搜索关键词" }),
		count: Type.Optional(Type.Number({ description: "返回结果数，默认 3，最多 8" })),
	}),

	async execute(_toolCallId, params, signal) {
		const query = String(params.query ?? "").trim();
		if (!query) throw new Error("query 不能为空");
		const limit = Math.min(Math.max(Math.trunc(params.count ?? 3), 1), 8);
		const items = await getResults(query, signal);
		const results = items.slice(0, limit);
		const text = results
			.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
			.join("\n\n");
		return { content: [{ type: "text", text }], details: { query, count: results.length, results } };
	},
});

function format(results: Result[]): string {
	return results
		.slice(0, 3)
		.map((r, i) => `${i + 1}. ${r.title}\n${r.url}`)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearch);

	pi.registerCommand("search", {
		description: "手动网络搜索：/search 关键词",
		handler: async (args: string, ctx: ExtensionContext) => {
			const query = (args ?? "").trim();
			if (!query) {
				ctx.ui.notify("用法：/search 关键词", "warning");
				return;
			}
			try {
				const items = await getResults(query);
				ctx.ui.notify(format(items), "info");
			} catch (error) {
				ctx.ui.notify(`搜索失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
