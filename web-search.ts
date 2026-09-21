/**
 * 网络搜索扩展
 *
 * LLM 工具：web_search(query, count?)
 * 手动命令：/search <关键词>
 * 主用 Bing，被限流自动切 Sogou；cookie 预热 + 请求串行限速 + 结果缓存。
 * 安装目录：~/.pi/agent/extensions/web-search.ts
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HEADERS = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	"Upgrade-Insecure-Requests": "1",
};
const TIMEOUT = 8_000;
const MIN_GAP = 1_200;
const COOKIE_TTL = 30 * 60_000;
const CACHE_TTL = 5 * 60_000;
const BLOCK_COOLDOWN = 3 * 60_000;

interface Result {
	title: string;
	url: string;
	snippet: string;
}

// Bing 限流页特征：返回“汉语汉字/字典/中智集团”等无关通用结果
const JUNK = /(汉语汉字|漢典|汉语国学|字的意思|中智集团|shidianguji|zdic\.net)/;

const cache = new Map<string, { at: number; items: Result[] }>();
let cookies = "";
let cookieAt = 0;
let bingBlockedUntil = 0;

// ---- 请求串行化 + 限速 ----
let lastRequest = 0;
let chain: Promise<unknown> = Promise.resolve();
function polite<T>(fn: () => Promise<T>): Promise<T> {
	const p = chain.then(async () => {
		const wait = lastRequest + MIN_GAP - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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

async function bingCookies(signal: AbortSignal): Promise<string> {
	if (cookies && Date.now() - cookieAt < COOKIE_TTL) return cookies;
	const res = await polite(() => fetch("https://www.bing.com/", { headers: HEADERS, signal }));
	const raw = res.headers.getSetCookie?.();
	const list = raw ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
	cookies = list.map((c) => c.split(";")[0]).join("; ");
	cookieAt = Date.now();
	return cookies;
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
		.filter((r): r is Result => r !== null);
}

function looksBlocked(items: Result[]): boolean {
	if (items.length < 2) return true;
	return items.filter((r) => JUNK.test(r.title)).length >= 2;
}

async function searchOnce(query: string, signal: AbortSignal): Promise<Result[]> {
	if (Date.now() >= bingBlockedUntil) {
		try {
			const ck = await bingCookies(signal);
			const res = await polite(() =>
				fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&form=QBLH`, {
					headers: { ...HEADERS, Cookie: ck },
					signal,
				}),
			);
			if (res.ok) {
				const items = parseBing(await res.text());
				if (!looksBlocked(items)) return items;
			}
		} catch {
			/* 落到 Sogou */
		}
		bingBlockedUntil = Date.now() + BLOCK_COOLDOWN;
	}

	const res = await polite(() =>
		fetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, { headers: HEADERS, signal }),
	);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const items = parseSogou(await res.text());
	if (looksBlocked(items)) throw new Error("搜索被限流，稍后重试或换个关键词");
	return items;
}

/** 带缓存 + 超时/取消包装的入口 */
async function getResults(query: string, external?: AbortSignal): Promise<Result[]> {
	const hit = cache.get(query);
	if (hit && Date.now() - hit.at <= CACHE_TTL) return hit.items;
	const { signal, done } = makeSignal(external);
	try {
		const items = await searchOnce(query, signal);
		cache.set(query, { at: Date.now(), items });
		return items;
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
