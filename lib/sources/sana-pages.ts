import { load } from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

const DATE_RE =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}/;

const CONFIG: Record<
  string,
  { url: string; maxAgeDays: number; skipPath?: string }
> = {
  "sana-investment": {
    url: "https://sana.sy/en/investment/",
    maxAgeDays: 7,
  },
  "china-syria": {
    url: "https://sana.sy/en/tag/china/",
    maxAgeDays: 7,
    skipPath: "/en/international/", // 纯中国新闻（台风、泥石流、军演等）不进中叙合作
  },
};

export async function fetchSanaPage(sourceId: string): Promise<RawArticle[]> {
  const conf = CONFIG[sourceId];
  if (!conf) return [];
  const text = await curlFetch(conf.url, HEADERS);
  const $ = load(text);
  const items: RawArticle[] = [];
  const seen = new Set<string>();

  $("h3 a[href]").each((_, el) => {
    const url = $(el).attr("href") ?? "";
    if (!url.startsWith("https://sana.sy/en/")) return;
    if (conf.skipPath && url.includes(conf.skipPath)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const title = $(el).text().trim();
    if (!title) return;

    // 日期：取 h3 后 4 个兄弟元素内的 "Month D, YYYY"
    let node = $(el);
    let publishedAt: Date | undefined;
    for (let i = 0; i < 4 && !publishedAt; i++) {
      node = node.next();
      if (!node.length) break;
      const m = DATE_RE.exec(node.text());
      if (m) publishedAt = new Date(m[0]);
    }
    if (!publishedAt) return; // 无日期剔除，防旧文混入
    if (Date.now() - publishedAt.getTime() > conf.maxAgeDays * 86400_000)
      return;

    items.push({ sourceId, title, url, publishedAt, category: "finance" });
  });

  console.log(`[sana-page] ${sourceId} matched=${items.length}`);
  return items.slice(0, 15);
}
