import { load } from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const HOME_URL = "https://english.enabbaladi.net/";
const FEED_URL = "https://english.enabbaladi.net/feed/";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function fetchEnabBaladi(sourceId: string): Promise<RawArticle[]> {
  const seen = new Set<string>();
  const now = new Date();
  const monthPath = `/archives/${now.getUTCFullYear()}/${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}/`;

  // ── 路线 1：首页 HTML（含 10-15/16 最新文章）──
  try {
    const home = await curlFetch(HOME_URL, HEADERS);
    console.log(
      `[enab] home len=${home.length} head=${home.slice(0, 100).replace(/\n/g, " ")}`
    );
    const $ = load(home);
    const items: RawArticle[] = [];
    $("h3 a[href]").each((_, el) => {
      const url = $(el).attr("href") ?? "";
      if (!url.startsWith("https://english.enabbaladi.net/archives/")) return;
      if (!url.includes(monthPath)) return; // 只留当月文章，剔首页推荐旧闻
      if (seen.has(url)) return;
      seen.add(url);
      items.push({
        sourceId,
        title: $(el).text().trim(),
        url,
        category: "finance",
      });
    });
    console.log(`[enab] home matched=${items.length}`);
    if (items.length > 0) return items.slice(0, 15);
  } catch (e) {
    console.log(`[enab] home failed: ${String(e).slice(0, 100)}`);
  }

  // ── 路线 2：feed XML（有 pubDate，cheerio xmlMode 容忍坏字符）──
  try {
    const feed = await curlFetch(FEED_URL, HEADERS);
    console.log(
      `[enab] feed len=${feed.length} head=${feed.slice(0, 100).replace(/\n/g, " ")}`
    );
    const $f = load(feed, { xmlMode: true });
    const items: RawArticle[] = [];
    $f("item").each((_, el) => {
      const node = $f(el);
      const url = node.find("link").first().text().trim();
      const title = node.find("title").first().text().trim();
      if (!url || !title) return;
      if (!url.startsWith("https://english.enabbaladi.net/archives/")) return;
      if (seen.has(url)) return;
      seen.add(url);
      const pub = node.find("pubDate").first().text().trim();
      items.push({
        sourceId,
        title,
        url,
        publishedAt: pub ? new Date(pub) : undefined,
        category: "finance",
      });
    });
    console.log(`[enab] feed matched=${items.length}`);
    return items.slice(0, 15);
  } catch (e) {
    console.log(`[enab] feed failed: ${String(e).slice(0, 100)}`);
    return [];
  }
}
