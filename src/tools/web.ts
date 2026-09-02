/**
 * tools/web.ts —— 联网检索与网页抓取
 *
 * 搜索走 DuckDuckGo 的 HTML 端点（无需 API Key）。
 * 若网络不通或被拦截，会明确报错而不是返回空结果——避免模型拿空输入瞎编。
 */
import type { Tool } from "./types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** DuckDuckGo 的跳转链接里真实地址在 uddg 参数上 */
function realUrl(href: string): string {
  try {
    const m = href.match(/uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (href.startsWith("//")) return "https:" + href;
    return href;
  } catch {
    return href;
  }
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: "联网搜索（DuckDuckGo），返回标题、链接与摘要。用于查行情/新闻/技术资料。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      limit: { type: "number", description: "结果条数，默认 6" },
    },
    required: ["query"],
  },
  run: async (a, ctx) => {
    const q = String(a.query ?? "").trim();
    if (!q) return { ok: false, output: "", error: "query 为空" };
    const limit = Math.min(15, Math.max(1, Number(a.limit) || 6));
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    ctx.log?.(`[search] ${q}`);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      const r = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return { ok: false, output: "", error: `搜索失败 HTTP ${r.status}` };
      const html = await r.text();

      const items: string[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,600}?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && items.length < limit) {
        const title = unescapeHtml(stripTags(m[2])).trim();
        const snippet = unescapeHtml(stripTags(m[3])).trim();
        const link = realUrl(unescapeHtml(m[1]));
        items.push(`${items.length + 1}. ${title}\n   ${link}\n   ${snippet.slice(0, 260)}`);
      }
      if (!items.length) {
        // 兜底：抓任意外链
        const alt = [...html.matchAll(/<a[^>]+href="(\/\/duckduckgo\.com\/l\/\?uddg=[^"]+)"/gi)]
          .slice(0, limit)
          .map((x, i) => `${i + 1}. ${realUrl(x[1])}`);
        if (alt.length) return { ok: true, output: alt.join("\n") };
        return { ok: false, output: "", error: "未解析到搜索结果（可能是网络不通或页面结构变化）" };
      }
      return { ok: true, output: `搜索「${q}」\n${items.join("\n\n")}` };
    } catch (e) {
      return { ok: false, output: "", error: `搜索异常：${String(e)}` };
    }
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "抓取网页正文（去掉脚本与样式后转成纯文本），用于读具体文章/文档。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) 链接" },
      maxChars: { type: "number", description: "返回最大字符数，默认 8000" },
    },
    required: ["url"],
  },
  run: async (a, ctx) => {
    const url = String(a.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, output: "", error: "只支持 http(s) 链接" };
    const maxChars = Math.min(40_000, Math.max(500, Number(a.maxChars) || 8000));
    ctx.log?.(`[fetch] ${url}`);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25_000);
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return { ok: false, output: "", error: `抓取失败 HTTP ${r.status}` };
      const txt = stripTags(unescapeHtml(await r.text()));
      return { ok: true, output: txt.slice(0, maxChars) || "（页面无文本内容）" };
    } catch (e) {
      return { ok: false, output: "", error: `抓取异常：${String(e)}` };
    }
  },
};

export const webTools: Tool[] = [webSearchTool, webFetchTool];
