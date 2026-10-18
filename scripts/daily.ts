import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
} from "../lib/ai/pipeline";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichXViralSummaries,
  filterByTheme,
  classifySyriaArticles,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { todayKey } from "../lib/utils";
// ══ 新增：中叙合作关键词（命中即强制归"中叙合作" tab，不进其他 tab） ══
// 标准：必须命中两国往来/合作/交往（政经人文均可）；泛涉中或泛涉叙的新闻不算
const CHINA_SYRIA_KEYWORDS = {
  // 明确的中叙双边表述，单独命中即归位
  strong: [
    "中叙", "叙中", "中国和叙利亚", "叙利亚和中国", "中叙两国",
    "china-syria", "syria-china", "china and syria", "syria and china",
    "sino-syrian", "sino-syria", "syrian-chinese", "china-syrian",
  ],
  // 中国实体词，需与下方合作词同时命中才算
  china: ["china", "chinese", "beijing", "中国", "中方", "北京"],
  // 两国往来/合作/交往词（政经人文）
  coop: [
    "cooperat", "partnership", "memorandum", "mou", "agreement", "deal", "ties",
    "bilateral", "joint", "visit", "talks", "meeting", "forum", "exchange",
    "delegation", "ambassador", "embassy", "consul", "trade", "investment",
    "aid", "assistance", "project", "cultural", "humanitarian", "scholarship",
    "heritage", "discuss",
    "合作", "往来", "会谈", "会晤", "访问", "协议", "协定", "贸易", "投资",
    "交流", "代表团", "大使", "使馆", "双边", "共建", "援助", "人文", "文化",
    "奖学金", "留学", "文物",
  ],
};
// ══ 新增结束 ══

const OUTPUT_DIR = "daily_reports";

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }
  return articles;
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}
/**
 * finance:investment is rendered as a merged time-sorted list. Enrich
 * exactly the items that will be displayed (see MERGED_SUBGROUP_LIMITS).
 */
async function enrichFinanceInvestment(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "investment");
}
/**
 * finance:china-syria is rendered as a merged time-sorted list. Enrich
 * exactly the items that will be displayed (see MERGED_SUBGROUP_LIMITS).
 */
async function enrichFinanceChinaSyria(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "china-syria");
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, 20);
  if (xPosts.length === 0) return;
  console.log(`[daily] enriching ${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    xPosts.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of xPosts) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${xPosts.length}`,
  );
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[]): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, 20);
  if (papers.length === 0) return;
  console.log(
    `[daily] enriching ${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    papers.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of papers) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${papers.length}`,
  );
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics",
  subcategory: string,
): Promise<void> {
  // 按文章自身的分类字段取数（不再按信源配置归属）
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Top-N respects all enabled sources (so we don't reshape the merged
  // timeline). Enrichment only targets items NOT already in the target
  // language within that slice.
  const top = articles
    .filter((a) => a.category === category && a.subcategory === subcategory)
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top;
  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length}/${top.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}
/**
 * finance 各 tab：先按现有逻辑截断到上限，再做主题过滤（宁缺毋滥），
 * 最后对保留项做中文摘要。返回被剔除的 url，供 main() 从分桶中排除。
 */
async function enrichMergedSubgroupFiltered(
  articles: ArticleInput[],
  category: "finance",
  subcategory: string,
  themeRule: string,
): Promise<Set<string>> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;

  const top = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);

  const kept = await filterByTheme(
    top.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt, source: a.source })),
    themeRule,
  );

  const filteredTop = top.filter((a) => kept.has(a.url));
  const toEnrich = filteredTop.filter((a) => !sameLocaleIds.has(a.sourceId));
  if (toEnrich.length > 0) {
    const summaries = await enrichFinanceNewsSummaries(toEnrich);
    for (const a of toEnrich) {
      const s = summaries.get(a.url);
      if (s) a.summary = s;
    }
  }

  return new Set(top.filter((a) => !kept.has(a.url)).map((a) => a.url));
}
/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  validateBackendCredentials();

  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  const articles = await fetchAll();
// ══ 新增：当日 URL 去重（同一天不同源抓到同一 URL 只留一条） ══
{
  const seen = new Set<string>();
  const before = articles.length;
  const kept = articles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
  if (kept.length !== before) {
    console.log(`[daily] same-day dedup: removed ${before - kept.length}/${before} duplicate urls`);
  }
  articles.length = 0;
  articles.push(...kept);
}
// ══ 新增结束 ══
  
// ══ 新增：跨天去重——昨天出现过的 url 今天剔除（旧闻不复用） ══
{
  const yesterdayKey = todayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const yPath = path.join(OUTPUT_DIR, yesterdayKey, `${yesterdayKey}-articles.json`);
  const stale = new Set<string>();
  try {
    if (fs.existsSync(yPath)) {
      const prev = JSON.parse(fs.readFileSync(yPath, "utf8"));
      for (const a of prev.articles ?? []) stale.add(a.url);
      console.log(`[daily] dedup: loaded ${stale.size} yesterday urls (${yesterdayKey})`);
    } else {
      console.log(`[daily] dedup: no ${yPath} — skip dedup`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] dedup: could not read ${yPath} — ${msg}`);
  }
  if (stale.size > 0) {
    const before = articles.length;
    const kept = articles.filter((a) => !stale.has(a.url));
    articles.length = 0;
    articles.push(...kept);
    console.log(`[daily] dedup: removed ${before - kept.length}/${before} stale items`);
  }
}
// ══ 新增结束 ══

  console.log(`\n[daily] total articles: ${articles.length}`);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // ══ 新增：统一时间窗口（RSS 与页面源都生效） ══
  const MAX_AGE_DAYS = 3; // 要 2 天就改这个数；不要窗口就删下面 {} 整块
  {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const before = articles.length;
    const kept = articles.filter((a) => {
      const t = a.publishedAt ? new Date(a.publishedAt).getTime() : Number.POSITIVE_INFINITY;
      return t >= cutoff;
    });
    articles.length = 0;
    articles.push(...kept);
    console.log(`[daily] window: dropped ${before - kept.length}/${before} older than ${MAX_AGE_DAYS}d`);
  }

  // ══ 新增：中叙关键词强制归 tab（零 LLM 成本；命中即进中叙合作，不进其他 tab） ══
    let chinaUrls = new Set<string>();
  for (const a of articles) {
    const hay = `${a.title ?? ""} ${a.excerpt ?? ""}`.toLowerCase();
    const hit =
      CHINA_SYRIA_KEYWORDS.strong.some((k) => hay.includes(k)) ||
      (CHINA_SYRIA_KEYWORDS.china.some((k) => hay.includes(k)) &&
        CHINA_SYRIA_KEYWORDS.coop.some((k) => hay.includes(k)));
    if (hit) {
      chinaUrls.add(a.url);
      a.category = "finance";
      a.subcategory = "china-syria";
    }
  }
  console.log(`[daily] classify: keyword=${chinaUrls.size} 命中中叙合作关键词强制归位`);

  // ══ 新增：LLM 单次批量分类（未命中关键词的剩余文章一次调用；未返回的 url 视为丢弃） ══
  {
    const pending = articles.filter((a) => !chinaUrls.has(a.url));
    const classMap = await classifySyriaArticles(
      pending.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt, source: a.source })),
    );
    const dropped = new Set<string>();
    for (const a of pending) {
      const cls = classMap.get(a.url);
      if (!cls) { dropped.add(a.url); continue; }
      a.category = cls.category;
      a.subcategory = cls.subcategory;
    }
    const keptArticles = articles.filter((a) => !dropped.has(a.url));
    const droppedCount = articles.length - keptArticles.length;
    articles.length = 0;
    articles.push(...keptArticles);
    console.log(`[daily] classify: keyword=${chinaUrls.size} kept=${keptArticles.length} dropped=${droppedCount}`);
  }

// ══ 原有调用原样保留，一行不动 ══
  await enrichFinanceNews(articles);
  await enrichFinanceInvestment(articles);
  await enrichFinanceChinaSyria(articles);
  await enrichPolitics(articles);
  await enrichXViral(articles);

 
  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles);
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, sources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with all fetched articles + LLM-attached summary, so
  // scripts/render.ts can rebuild HTML/MD for UI iteration without
  // re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
