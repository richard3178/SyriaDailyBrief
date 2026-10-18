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
  { url: string; maxAgeDays: number; allowPaths?: string[]; skipPath?: string }
> = {
  "sana-investment": {
    url: "https://sana.sy/en/investment/",
    maxAgeDays: 2,
    allowPaths: ["/en/investment/", "/en/economic/"], // 只留投资/经济文
  },
  "china-syria": {
    url: "https://sana.sy/en/tag/china/",
    maxAgeDays: 2,
    skipPath: "/en/international/", // 剔纯中国新闻
  },
      "sana-economy": {
      maxAgeDays: 3,
      limit: 12,
    },
    "sana-en": {
      maxAgeDays: 3,
      limit: 15,
    },
    "sana-syria": {
      maxAgeDays: 3,
      limit: 15,
    },
};

function extractDate($: any, el: any): Date | undefined {
  // 1) 标题所在父容器内，前后 4 个兄弟元素里找 "Month D, YYYY"
  const parent = $(el).parent();
  const sibs = parent.children();
  const idx = sibs.index($(el));
  const lo = Math.max(0, idx - 4);
  const hi = Math.min(sibs.length - 1, idx + 4);
  for (let i = lo; i <= hi; i++) {
    const m = DATE_RE.exec(sibs.eq(i).text());
    if (m) return new Date(m[0]);
  }
  // 2) 向上回溯 2 层容器（文本不超 1500 字符，防串到别的文章日期）
  let container = parent;
  for (let depth = 0; depth < 2; depth++) {
    container = container.parent();
    if (!container.length) break;
    const t = container.text();
    if (t.length > 1500) break;
    const m = DATE_RE.exec(t);
    if (m) return new Date(m[0]);
  }
  return undefined;
}

export async function fetchSanaPage(sourceId: string): Promise<RawArticle[]> {
  const conf = CONFIG[sourceId];
  if (!conf) return [];
  const text = await curlFetch(conf.url, HEADERS);
  // 诊断日志：curl 到底拿到什么
  console.log(
    `[sana-page] ${sourceId} len=${text.length} head=${text.slice(0, 120).replace(/\n/g, " ")}`
  );
  const $ = load(text);
  const items: RawArticle[] = [];
  const seen = new Set<string>();
  let total = 0;
  let noDate = 0;

  $("h2 a[href], h3 a[href], h4 a[href]").each((_, el) => {
    const url = $(el).attr("href") ?? "";
    if (!url.startsWith("https://sana.sy/en/")) return;
    if (conf.allowPaths && !conf.allowPaths.some((p) => url.includes(p)))
      return;
    if (conf.skipPath && url.includes(conf.skipPath)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const title = $(el).text().trim();
    if (!title) return;
    total++;

    const publishedAt = extractDate($, el);
    if (!publishedAt) {
      noDate++;
      return;
    }
    if (Date.now() - publishedAt.getTime() > conf.maxAgeDays * 86400_000)
      return;

    items.push({ sourceId, title, url, publishedAt, category: "finance" });
  });

  console.log(
    `[sana-page] ${sourceId} links=${total} noDate=${noDate} kept=${items.length}`
  );
  return items.slice(0, 15);
}
