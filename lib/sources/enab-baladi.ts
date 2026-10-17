import { load } from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const HOME_URL = "https://english.enabbaladi.net/";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function fetchEnabBaladi(sourceId: string): Promise<RawArticle[]> {
  const html = await curlFetch(HOME_URL, HEADERS);
  const $ = load(html);
  const items: RawArticle[] = [];

  $("h3 a[href]").each((_i, el) => {
    const title = $(el).text().trim();
    const url = $(el).attr("href") ?? "";
    if (!title || !url) return;
    // 只保留英文主站文章，排除 daraya 等阿拉伯语子站内容
    if (!url.startsWith("https://english.enabbaladi.net/archives/")) return;
    const excerpt = $(el)
      .parent()
      .nextAll("p")
      .first()
      .text()
      .trim()
      .slice(0, 300);
    items.push({
      sourceId,
      title,
      url,
      excerpt,
      category: "finance",
    });
  });

  return items.slice(0, 15);
}
