/**
 * Bot registry (WDN-03, WebDecoy registry port) - a 235-entry User-Agent
 * table with categories and respectsRobots flags, matched first-match
 * wins over the ordered table.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn03.cjs, table embedded
 * byte-for-byte from the source registry): 235 entries with per-category
 * counts training 32, ai_search 22, ai_agent 10, search 21, seo 24,
 * security 17, generic_scraper 22, headless 8, archiver 5, fetcher 24,
 * monitoring 13, feed_reader 10, commercial 13, ai_assistant 14;
 * respectsRobots !== true for 73 entries. Known bots classify 6/6 exact
 * (GPTBot, PerplexityBot, AhrefsBot, Shodan, facebookexternalhit,
 * FeedlyBot); real browser UAs classify 0/3 on the frozen set - a THIN
 * corpus, so no field false-positive rate is claimed. Table order is
 * causal: a dual GPTBot+Googlebot UA resolves to gptbot (table index 1
 * beats googlebot at index 65), and swapping the two entries flips the
 * same UA to googlebot.
 *
 * REFRESH POLICY (binding): this table is a SNAPSHOT. Its source of
 * truth lives outside this package; the table does not learn, fetch or
 * widen itself at runtime. Refreshing it is a reviewed change: replace
 * the entries wholesale from the upstream registry, keep the order,
 * and re-run the frozen classification fixtures (known 6/6, browser
 * 0/3, first-match and respectsRobots counts) before shipping.
 *
 * Advisory only: a registry label is investigation telemetry
 * (enforcement: "none"). UA strings are self-declared, so a label never
 * proves the caller is that bot, never a sole blocking key and never
 * an exemption. This registry is a separate, richer table beside
 * ua-classifier.ts (the restricted UAS-02 catalogue); the two do not
 * share entries or verdict shapes.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

export type BotRegistryCategory =
  | "training_crawler"
  | "ai_search_crawler"
  | "ai_agent"
  | "ai_assistant"
  | "search_crawler"
  | "seo_crawler"
  | "security_scanner"
  | "generic_scraper"
  | "archiver"
  | "fetcher"
  | "monitoring"
  | "headless_browser"
  | "feed_reader"
  | "commercial_scraper"
  | "none";

export interface BotRegistryEntry {
  id: string;
  name: string;
  category: Exclude<BotRegistryCategory, "none">;
  organization: string;
  baseScore: number;
  respectsRobots: boolean;
  uaPatterns: readonly string[];
}

/** All categories in the registry vocabulary, including the "none" verdict category (15 total). */
export const BOT_REGISTRY_CATEGORIES: readonly BotRegistryCategory[] = Object.freeze([
  "training_crawler", "ai_search_crawler", "ai_agent", "ai_assistant",
  "search_crawler", "seo_crawler", "security_scanner", "generic_scraper",
  "archiver", "fetcher", "monitoring", "headless_browser", "feed_reader",
  "commercial_scraper", "none",
]);

/** Categories that count as AI agents for the isAI verdict flag. */
export const BOT_REGISTRY_AI_CATEGORIES: ReadonlySet<BotRegistryCategory> = new Set([
  "training_crawler", "ai_search_crawler", "ai_agent", "ai_assistant",
]);

type RawEntry = [string, string, BotRegistryEntry["category"], string, number, 0 | 1, string[]];

// Frozen snapshot: [id, name, category, organization, baseScore,
// respectsRobots (1/0), uaPatterns] in table order. ORDER IS
// SIGNIFICANT: matching is first-match wins.
const REGISTRY_RAW: readonly RawEntry[] = [
["reflectionbot","Reflectionbot","training_crawler","Reflection AI",70,1,["reflectionbot"]],
["gptbot","GPTBot","training_crawler","OpenAI",85,1,["gptbot"]],
["claudebot","ClaudeBot","training_crawler","Anthropic",85,1,["claudebot"]],
["anthropic","Anthropic","training_crawler","Anthropic",85,1,["anthropic-ai"]],
["claude-web","Claude-Web","training_crawler","Anthropic",85,1,["claude-web"]],
["ccbot","CCBot","training_crawler","Common Crawl",80,1,["ccbot"]],
["google-extended","Google-Extended","training_crawler","Google",80,1,["google-extended"]],
["bytespider","ByteSpider","training_crawler","ByteDance",75,0,["bytespider"]],
["amazonbot","Amazonbot","training_crawler","Amazon",70,1,["amazonbot"]],
["facebookbot","FacebookBot","training_crawler","Meta",70,1,["facebookbot"]],
["meta-externalagent","Meta-ExternalAgent","training_crawler","Meta",75,1,["meta-externalagent"]],
["cohere-ai","Cohere","training_crawler","Cohere",80,1,["cohere-ai","cohere"]],
["applebot-extended","Applebot-Extended","training_crawler","Apple",75,1,["applebot-extended"]],
["youbot","YouBot","training_crawler","You.com",75,1,["youbot"]],
["mistral","MistralBot","training_crawler","Mistral AI",80,1,["mistralbot"]],
["gemini","Gemini","training_crawler","Google",80,1,["gemini"]],
["ai2bot","AI2Bot","training_crawler","Allen Institute for AI",75,1,["ai2bot"]],
["deepseek","DeepSeek","training_crawler","DeepSeek",80,1,["deepseek"]],
["qwen","Qwen","training_crawler","Alibaba",75,1,["qwen"]],
["webzio","Webz.io","training_crawler","Webz.io",70,0,["webzio"]],
["sentibot","Sentibot","training_crawler","Sentibot",70,0,["sentibot"]],
["omgili","Omgili","training_crawler","Webz.io",70,0,["omgili"]],
["img2dataset","img2dataset","training_crawler","LAION",75,0,["img2dataset"]],
["timpibot","Timpibot","training_crawler","Timpi",70,1,["timpibot"]],
["velenpublicwebcrawler","VelenPublicWebCrawler","training_crawler","Velen",70,0,["velenpublicwebcrawler"]],
["isscyberriskcrawler","ISSCyberRiskCrawler","training_crawler","ISS",65,0,["isscyberriskcrawler"]],
["friendlycrawler","FriendlyCrawler","training_crawler","Unknown",65,1,["friendlycrawler"]],
["elevenlabscrawler","ElevenlabsCrawler","training_crawler","ElevenLabs",80,1,["elevenlabscrawler"]],
["riverbot","RiverBot","training_crawler","River",80,1,["riverbot"]],
["kimibot","KimiBot","training_crawler","Moonshot AI",80,1,["kimibot"]],
["moonshotbot","MoonshotBot","training_crawler","Moonshot AI",80,0,["moonshotbot"]],
["chatglm-spider","ChatGLM-Spider","training_crawler","Zhipu AI",80,0,["chatglm-spider"]],
["duckassistbot","DuckAssistBot","ai_search_crawler","DuckDuckGo",65,1,["duckassistbot"]],
["sofyabot","SofyaBot","ai_search_crawler","Sofya",65,1,["sofyabot"]],
["xai-searchbot","xAI-SearchBot","ai_search_crawler","xAI",70,1,["xai-searchbot"]],
["linkupbot","LinkupBot","ai_search_crawler","Linkup",65,1,["linkupbot"]],
["perplexitybot","PerplexityBot","ai_search_crawler","Perplexity AI",80,1,["perplexitybot"]],
["claude-searchbot","Claude-SearchBot","ai_search_crawler","Anthropic",75,1,["claude-searchbot"]],
["oai-searchbot","OAI-SearchBot","ai_search_crawler","OpenAI",80,1,["oai-searchbot"]],
["searchgpt","SearchGPT","ai_search_crawler","OpenAI",75,1,["searchgpt"]],
["phind","Phind","ai_search_crawler","Phind",70,1,["phind"]],
["kagi","Kagi","ai_search_crawler","Kagi",65,1,["kagi"]],
["exa","Exa","ai_search_crawler","Exa AI",70,1,["exasearchbot","exabot"]],
["shapbot","ShapBot","ai_search_crawler","Parallel Web Systems",65,1,["shapbot"]],
["meta-webindexer","Meta-WebIndexer","ai_search_crawler","Meta",70,1,["meta-webindexer"]],
["metaphor","Metaphor","ai_search_crawler","Metaphor",70,1,["metaphor"]],
["tavily","Tavily","ai_search_crawler","Tavily",70,1,["tavily"]],
["brave-search","BraveSearch","ai_search_crawler","Brave",65,1,["bravesearch"]],
["neeva","NeevaBot","ai_search_crawler","Neeva",65,1,["neevabot"]],
["kimi-searchbot","Kimi-SearchBot","ai_search_crawler","Moonshot AI",65,1,["kimi-searchbot"]],
["isonsearchbot","IsonSearchBot","ai_search_crawler","Ison Search",65,1,["isonsearchbot"]],
["keenablebot","KeenableBot","ai_search_crawler","Keenable",65,1,["keenablebot"]],
["azureai-searchbot","AzureAI-SearchBot","ai_search_crawler","Microsoft",65,0,["azureai-searchbot"]],
["grokbot","GrokBot","ai_search_crawler","xAI",70,0,["grokbot"]],
["operator","Operator","ai_agent","OpenAI",75,1,["operator"]],
["claude-user","Claude-User","ai_agent","Anthropic",75,1,["claude-user"]],
["gemini-user","Gemini-User","ai_agent","Google",75,1,["gemini-user"]],
["googleagent-mariner","GoogleAgent-Mariner","ai_agent","Google",75,1,["googleagent-mariner","mariner"]],
["amazon-buyforme","AmazonBuyForMe","ai_agent","Amazon",70,1,["amazonbuyforme","buyforme"]],
["browser-use","Browser-Use","ai_agent","Open Source",70,0,["browser-use"]],
["stagehand","Stagehand","ai_agent","Browserbase",70,0,["stagehand"]],
["manus-user","Manus-User","ai_agent","Manus",70,0,["manus-user"]],
["multion","MultiOn","ai_agent","MultiOn",70,0,["multion"]],
["opencode-user","OpenCode-User","ai_agent","OpenCode",75,0,["opencode-user"]],
["iboubot","IbouBot","search_crawler","Ibou",30,1,["iboubot","ibou-search"]],
["googlebot","Googlebot","search_crawler","Google",30,1,["googlebot"]],
["google-inspectiontool","Google-InspectionTool","search_crawler","Google",30,1,["google-inspectiontool"]],
["bingbot","Bingbot","search_crawler","Microsoft",30,1,["bingbot"]],
["msnbot","MSNBot","search_crawler","Microsoft",30,1,["msnbot"]],
["yandexbot","YandexBot","search_crawler","Yandex",35,1,["yandexbot"]],
["baiduspider","Baiduspider","search_crawler","Baidu",40,1,["baiduspider"]],
["petalbot","PetalBot","search_crawler","Huawei",40,1,["petalbot"]],
["duckduckbot","DuckDuckBot","search_crawler","DuckDuckGo",30,1,["duckduckbot"]],
["applebot","Applebot","search_crawler","Apple",30,1,["applebot"]],
["sogou","Sogou Spider","search_crawler","Sogou",40,1,["sogou"]],
["qwantify","Qwantify","search_crawler","Qwant",35,1,["qwantify","qwantbot"]],
["naver","Naver","search_crawler","Naver",35,1,["naver","yeti"]],
["seznam","SeznamBot","search_crawler","Seznam",35,1,["seznambot"]],
["ecosia","Ecosia","search_crawler","Ecosia",30,1,["ecosia"]],
["mojeek","MojeekBot","search_crawler","Mojeek",35,1,["mojeekbot"]],
["yahoo-slurp","Yahoo! Slurp","search_crawler","Yahoo",30,1,["slurp"]],
["bravebot","Bravebot","search_crawler","Brave",30,1,["bravebot"]],
["coccocbot","Coc Coc","search_crawler","Coc Coc",35,1,["coccocbot"]],
["yisouspider","YisouSpider","search_crawler","Alibaba",40,1,["yisouspider"]],
["yepbot","YepBot","search_crawler","Ahrefs",30,1,["yepbot"]],
["ahrefsbot","AhrefsBot","seo_crawler","Ahrefs",50,1,["ahrefsbot","ahrefs"]],
["semrushbot","SemrushBot","seo_crawler","Semrush",50,1,["semrushbot","semrush"]],
["mj12bot","MJ12bot","seo_crawler","Majestic",50,1,["mj12bot"]],
["dotbot","DotBot","seo_crawler","Moz",50,1,["dotbot"]],
["rogerbot","Rogerbot","seo_crawler","Moz",50,1,["rogerbot"]],
["screaming-frog","Screaming Frog","seo_crawler","Screaming Frog",55,1,["screaming frog"]],
["sitebulb","Sitebulb","seo_crawler","Sitebulb",55,1,["sitebulb"]],
["deepcrawl","DeepCrawl","seo_crawler","Lumar",50,1,["deepcrawl"]],
["oncrawl","OnCrawl","seo_crawler","OnCrawl",50,1,["oncrawl"]],
["botify","Botify","seo_crawler","Botify",50,1,["botify"]],
["contentking","ContentKing","seo_crawler","ContentKing",50,1,["contentking"]],
["sistrix","SISTRIX","seo_crawler","SISTRIX",50,1,["sistrix"]],
["serpstat","Serpstat","seo_crawler","Serpstat",50,1,["serpstat"]],
["spyfu","SpyFu","seo_crawler","SpyFu",50,1,["spyfu"]],
["meta-externalads","meta-externalads","seo_crawler","Meta",40,1,["meta-externalads"]],
["dataforseobot","DataForSeoBot","seo_crawler","DataForSEO",50,1,["dataforseobot"]],
["barkrowler","Barkrowler","seo_crawler","Babbar",50,1,["barkrowler"]],
["scrunchbot","Scrunchbot","seo_crawler","Scrunch",50,1,["scrunchbot"]],
["webxtrendbot","webXtrendBot","seo_crawler","webXtrend",50,1,["webxtrendbot"]],
["serankingbacklinksbot","SERankingBacklinksBot","seo_crawler","SE Ranking",50,1,["serankingbacklinksbot"]],
["awariobot","AwarioBot","seo_crawler","Awario",50,1,["awariobot","awariosmartbot"]],
["seojuice-searchbot","SEOJuice-SearchBot","seo_crawler","SEOJuice",50,1,["seojuice-searchbot"]],
["trendictionbot","trendictionbot","seo_crawler","Talkwalker",50,1,["trendictionbot"]],
["hubspot-crawler","HubSpot Crawler","seo_crawler","HubSpot",45,1,["hubspot crawler"]],
["nessus","Nessus","security_scanner","Tenable",70,0,["nessus"]],
["qualys","Qualys","security_scanner","Qualys",70,0,["qualys"]],
["shodan","Shodan","security_scanner","Shodan",75,0,["shodan"]],
["censys","Censys","security_scanner","Censys",75,0,["censys"]],
["nmap","Nmap","security_scanner","Open Source",70,0,["nmap"]],
["zap","OWASP ZAP","security_scanner","OWASP",70,0,["zap/"]],
["burp","Burp Suite","security_scanner","PortSwigger",70,0,["burp"]],
["nikto","Nikto","security_scanner","Open Source",70,0,["nikto"]],
["nuclei","Nuclei","security_scanner","ProjectDiscovery",70,0,["nuclei"]],
["acunetix","Acunetix","security_scanner","Invicti",70,0,["acunetix"]],
["netsparker","Netsparker","security_scanner","Invicti",70,0,["netsparker"]],
["detectify","Detectify","security_scanner","Detectify",65,0,["detectify"]],
["paloalto-xpanse","Palo Alto Networks Cortex Xpanse","security_scanner","Palo Alto Networks",65,0,["palo alto networks"]],
["recordedfuture","Recorded Future Crawler","security_scanner","Recorded Future",65,0,["recordedfuture"]],
["cloudflare-security-center","Cloudflare Security Center","security_scanner","Cloudflare",40,0,["developers.cloudflare.com/security-center"]],
["virustotal-cloud","VirusTotal","security_scanner","Google",40,0,["virustotalcloud"]],
["intruder","Intruder","security_scanner","Intruder",65,0,["intruder"]],
["python-requests","Python-Requests","generic_scraper","Open Source",55,0,["python-requests"]],
["python-urllib","Python-urllib","generic_scraper","Python",55,0,["python-urllib"]],
["python","Python","generic_scraper","Python",50,0,["python/"]],
["scrapy","Scrapy","generic_scraper","Scrapy",65,1,["scrapy"]],
["httpx","HTTPX","generic_scraper","Open Source",55,0,["httpx"]],
["aiohttp","aiohttp","generic_scraper","Open Source",55,0,["aiohttp"]],
["beautifulsoup","BeautifulSoup","generic_scraper","Open Source",60,0,["beautifulsoup"]],
["node-fetch","node-fetch","generic_scraper","Open Source",55,0,["node-fetch"]],
["axios","Axios","generic_scraper","Open Source",55,0,["axios/"]],
["got","Got","generic_scraper","Open Source",55,0,["got/"]],
["undici","Undici","generic_scraper","Node.js",55,0,["undici"]],
["go-http-client","Go-HTTP-Client","generic_scraper","Go",55,0,["go-http-client"]],
["colly","Colly","generic_scraper","Open Source",65,1,["colly"]],
["java","Java","generic_scraper","Oracle",50,0,["java/"]],
["okhttp","OkHttp","generic_scraper","Square",55,0,["okhttp"]],
["apache-httpclient","Apache-HttpClient","generic_scraper","Apache",55,0,["apache-httpclient"]],
["jsoup","Jsoup","generic_scraper","Open Source",60,0,["jsoup"]],
["guzzlehttp","GuzzleHttp","generic_scraper","Open Source",55,0,["guzzlehttp"]],
["php","PHP","generic_scraper","PHP",50,0,["php/"]],
["ruby","Ruby","generic_scraper","Ruby",50,0,["ruby"]],
["faraday","Faraday","generic_scraper","Open Source",55,0,["faraday"]],
["mechanize","Mechanize","generic_scraper","Open Source",60,0,["mechanize"]],
["headlesschrome","HeadlessChrome","headless_browser","Google",70,0,["headlesschrome"]],
["puppeteer","Puppeteer","headless_browser","Google",70,0,["puppeteer"]],
["playwright","Playwright","headless_browser","Microsoft",70,0,["playwright"]],
["selenium","Selenium","headless_browser","Open Source",70,0,["selenium"]],
["phantomjs","PhantomJS","headless_browser","Open Source",75,0,["phantomjs"]],
["splash","Splash","headless_browser","Scrapinghub",70,0,["splash"]],
["browserless","Browserless","headless_browser","Browserless",65,0,["browserless"]],
["browserbase","Browserbase","headless_browser","Browserbase",65,0,["browserbase"]],
["ia-archiver","Internet Archive","archiver","Internet Archive",25,1,["ia_archiver"]],
["archive-org-bot","Archive.org","archiver","Internet Archive",25,1,["archive.org_bot"]],
["wayback","Wayback Machine","archiver","Internet Archive",25,1,["wayback"]],
["heritrix","Heritrix","archiver","Internet Archive",30,1,["heritrix"]],
["brozzler","Brozzler","archiver","Internet Archive",30,1,["brozzler"]],
["facebookexternalhit","Facebook","fetcher","Meta",25,1,["facebookexternalhit"]],
["facebot","Facebot","fetcher","Meta",25,1,["facebot"]],
["twitterbot","Twitterbot","fetcher","X Corp",25,1,["twitterbot"]],
["linkedinbot","LinkedInBot","fetcher","LinkedIn",25,1,["linkedinbot"]],
["slackbot","Slackbot","fetcher","Slack",25,1,["slackbot"]],
["telegrambot","TelegramBot","fetcher","Telegram",25,1,["telegrambot"]],
["whatsapp","WhatsApp","fetcher","Meta",25,1,["whatsapp"]],
["discordbot","Discordbot","fetcher","Discord",25,1,["discordbot"]],
["pinterestbot","Pinterest","fetcher","Pinterest",30,1,["pinterest"]],
["tumblr","Tumblr","fetcher","Automattic",30,1,["tumblr"]],
["reddit","Reddit","fetcher","Reddit",30,1,["reddit"]],
["embedly","Embedly","fetcher","Medium",30,1,["embedly"]],
["iframely","Iframely","fetcher","Iframely",30,1,["iframely"]],
["adsbot-google","AdsBot-Google","fetcher","Google",25,1,["adsbot-google"]],
["stripebot","Stripebot","fetcher","Stripe",25,1,["stripebot"]],
["google-read-aloud","Google-Read-Aloud","fetcher","Google",25,0,["google-read-aloud"]],
["google-safety","Google-Safety","fetcher","Google",25,0,["google-safety"]],
["oai-adsbot","OAI-AdsBot","fetcher","OpenAI",30,1,["oai-adsbot"]],
["kakaobot","KakaoBot","fetcher","Kakao",25,1,["kakaobot"]],
["curl","cURL","fetcher","Open Source",45,0,["curl/"]],
["wget","Wget","fetcher","GNU",45,0,["wget/"]],
["libwww-perl","libwww-perl","fetcher","Perl",50,0,["libwww-perl"]],
["lwp","LWP","fetcher","Perl",50,0,["lwp-"]],
["httrack","HTTrack","fetcher","Open Source",60,1,["httrack"]],
["webdecoybot","WebDecoyBot","monitoring","WebDecoy",5,1,["webdecoybot"]],
["uptimerobot","UptimeRobot","monitoring","UptimeRobot",20,1,["uptimerobot"]],
["pingdom","Pingdom","monitoring","SolarWinds",20,1,["pingdom"]],
["statuscake","StatusCake","monitoring","StatusCake",20,1,["statuscake"]],
["better-uptime","Better Uptime","monitoring","Better Stack",20,1,["betteruptime"]],
["datadog-synthetics","Datadog Synthetics","monitoring","Datadog",25,1,["datadog"]],
["newrelic","New Relic","monitoring","New Relic",25,1,["newrelic"]],
["site24x7","Site24x7","monitoring","Zoho",20,1,["site24x7"]],
["freshping","Freshping","monitoring","Freshworks",20,1,["freshping"]],
["hetrixtools","HetrixTools","monitoring","HetrixTools",20,1,["hetrixtools"]],
["nodeping","NodePing","monitoring","NodePing",20,1,["nodeping"]],
["gtmetrix","GTmetrix","monitoring","GTmetrix",20,1,["gtmetrix"]],
["chrome-lighthouse","Lighthouse","monitoring","Google",20,1,["chrome-lighthouse","google page speed"]],
["feedly","Feedly","feed_reader","Feedly",25,1,["feedly"]],
["livelapbot","LivelapBot","feed_reader","Livelap",30,1,["livelapbot"]],
["feedfetcher-google","Feedfetcher-Google","feed_reader","Google",25,1,["feedfetcher"]],
["newsblur","NewsBlur","feed_reader","NewsBlur",25,1,["newsblur"]],
["inoreader","Inoreader","feed_reader","Inoreader",25,1,["inoreader"]],
["theoldreader","The Old Reader","feed_reader","The Old Reader",25,1,["theoldreader"]],
["feedbin","Feedbin","feed_reader","Feedbin",25,1,["feedbin"]],
["miniflux","Miniflux","feed_reader","Open Source",25,1,["miniflux"]],
["freshrss","FreshRSS","feed_reader","Open Source",25,1,["freshrss"]],
["commafeed","CommaFeed","feed_reader","Open Source",25,1,["commafeed"]],
["diffbot","Diffbot","commercial_scraper","Diffbot",70,1,["diffbot"]],
["import-io","Import.io","commercial_scraper","Import.io",65,1,["import.io"]],
["bright-data","Bright Data","commercial_scraper","Bright Data",70,0,["brightdata","luminati"]],
["brightbot","Brightbot","commercial_scraper","Bright Data",60,1,["brightbot"]],
["cloudflare-crawl","Cloudflare Browser Rendering Crawler","commercial_scraper","Cloudflare",55,1,["cloudflarebrowserrenderingcrawler"]],
["ev-crawler","ev-crawler","commercial_scraper","Headline",55,1,["ev-crawler"]],
["oxylabs","Oxylabs","commercial_scraper","Oxylabs",70,0,["oxylabs"]],
["scrapingbee","ScrapingBee","commercial_scraper","ScrapingBee",65,1,["scrapingbee"]],
["scrapingant","ScrapingAnt","commercial_scraper","ScrapingAnt",65,1,["scrapingant"]],
["zyte","Zyte","commercial_scraper","Zyte",65,1,["zyte","scrapinghub"]],
["apify","Apify","commercial_scraper","Apify",65,1,["apify"]],
["crawlbase","Crawlbase","commercial_scraper","Crawlbase",65,1,["crawlbase"]],
["webscrapingapi","WebScrapingAPI","commercial_scraper","WebScrapingAPI",65,1,["webscrapingapi"]],
["chatgpt-user","ChatGPT-User","ai_assistant","OpenAI",85,1,["chatgpt-user"]],
["perplexity-user","Perplexity-User","ai_assistant","Perplexity AI",75,0,["perplexity-user"]],
["mistralai-user","MistralAI-User","ai_assistant","Mistral AI",75,1,["mistralai-user"]],
["exauser","ExaUser","ai_assistant","Exa AI",70,0,["exauser"]],
["shap-user","Shap-User","ai_assistant","Parallel Web Systems",65,0,["shap-user"]],
["meta-externalfetcher","Meta-ExternalFetcher","ai_assistant","Meta",70,0,["meta-externalfetcher"]],
["gemini-deep-research","Gemini-Deep-Research","ai_assistant","Google",65,1,["gemini-deep-research"]],
["copilot","Microsoft Copilot","ai_assistant","Microsoft",65,1,["copilot"]],
["cortana","Cortana","ai_assistant","Microsoft",60,1,["cortana"]],
["siri","Siri","ai_assistant","Apple",60,1,["siri"]],
["kimi-user","Kimi-User","ai_assistant","Moonshot AI",70,1,["kimi-user"]],
["keenable-user","Keenable-User","ai_assistant","Keenable",70,1,["keenable-user"]],
["elevenlabsbot","ElevenlabsBot","ai_assistant","ElevenLabs",70,1,["elevenlabsbot"]],
["klaviyoaibot","KlaviyoAIBot","ai_assistant","Klaviyo",60,1,["klaviyoaibot"]]
];

/** The frozen 235-entry bot registry, in matching order. */
export const BOT_REGISTRY: readonly BotRegistryEntry[] = Object.freeze(
  REGISTRY_RAW.map(([id, name, category, organization, baseScore, respects, uaPatterns]) =>
    Object.freeze({
      id,
      name,
      category,
      organization,
      baseScore,
      respectsRobots: respects === 1,
      uaPatterns: Object.freeze([...uaPatterns]),
    }),
  ),
);

/**
 * First-match substring classification over an ordered table: the UA is
 * lowercased once, then the first entry (in table order) with any
 * pattern appearing in it wins. Exported so hosts and tests can run the
 * same matcher over a reordered table (order is causal, see header).
 */
export function matchBotInTable(
  table: readonly BotRegistryEntry[],
  userAgent: string | null | undefined,
): BotRegistryEntry | undefined {
  if (!userAgent) return undefined;
  const ua = userAgent.toLowerCase();
  for (const agent of table) {
    for (const pattern of agent.uaPatterns) {
      if (ua.includes(pattern)) return agent;
    }
  }
  return undefined;
}

/** Match a User-Agent against the shipped registry (first-match wins). */
export function matchBotUserAgent(userAgent: string | null | undefined): BotRegistryEntry | undefined {
  return matchBotInTable(BOT_REGISTRY, userAgent);
}

export interface BotRegistryVerdict {
  kind: "bot_registry_verdict";
  known: boolean;
  id?: string;
  name?: string;
  category: BotRegistryCategory;
  organization?: string;
  score: number;
  respectsRobots?: boolean;
  isAI: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

/** Classify a User-Agent against the shipped registry. Unknown UAs get category "none", score 0. */
export function classifyBotUserAgent(userAgent: string | null | undefined): BotRegistryVerdict {
  const agent = matchBotUserAgent(userAgent);
  if (!agent) {
    return { kind: "bot_registry_verdict", known: false, category: "none", score: 0, isAI: false, enforcement: "none" };
  }
  return {
    kind: "bot_registry_verdict",
    known: true,
    id: agent.id,
    name: agent.name,
    category: agent.category,
    organization: agent.organization,
    score: agent.baseScore,
    respectsRobots: agent.respectsRobots,
    isAI: BOT_REGISTRY_AI_CATEGORIES.has(agent.category),
    enforcement: "none",
  };
}
