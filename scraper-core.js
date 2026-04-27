(function () {
  "use strict";

  const SETTINGS = {
    defaultConcurrency: 3,
    maxForumPages: 200,
    retryCount: 2,
    requestDelayMs: 180,
  };

  const JSON_METHOD_CANDIDATES = [
    {
      method: "mod_forum_get_forum_discussion_posts",
      buildArgs: ({ discussionId }) => ({ discussionid: discussionId }),
    },
    {
      method: "mod_forum_get_forum_discussion_posts",
      buildArgs: ({ discussionId }) => ({ discussionid: discussionId, sortdirection: "ASC" }),
    },
    {
      method: "mod_forum_get_forum_discussion_posts",
      buildArgs: ({ discussionId }) => ({ discussionid: discussionId, page: 0, perpage: 1000 }),
    },
    {
      method: "mod_forum_get_discussion_posts",
      buildArgs: ({ discussionId }) => ({ discussionid: discussionId }),
    },
    {
      method: "mod_forum_get_discussion_posts",
      buildArgs: ({ discussionId }) => ({ discussionid: discussionId, page: 0, perpage: 1000 }),
    },
  ];

  const POST_HINTS = ["id", "subject", "message", "author", "authorfullname", "parentid"];

  let lastRequestAt = 0;
  let requestQueue = Promise.resolve();

  function noop() {}

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function textOf(node) {
    return normalizeWhitespace(node ? node.textContent : "");
  }

  function innerTextOf(node) {
    return normalizeWhitespace(node ? node.innerText || node.textContent : "");
  }

  function stripHtmlToText(value) {
    const html = String(value || "");
    if (!html) {
      return "";
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    return normalizeWhitespace(doc.body ? doc.body.textContent : html.replace(/<[^>]+>/g, " "));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toAbsoluteUrl(value, baseUrl = location.href) {
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  }

  function parseNumericId(value) {
    if (value == null) {
      return null;
    }

    const match = String(value).match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function getUrl(urlLike = location.href) {
    return new URL(urlLike, location.href);
  }

  function getDiscussionId(urlLike = location.href) {
    return parseNumericId(getUrl(urlLike).searchParams.get("d"));
  }

  function getPageType(urlLike = location.href) {
    const url = getUrl(urlLike);
    if (/\/mod\/forum\/view\.php$/i.test(url.pathname)) {
      return "forum";
    }
    if (/\/mod\/forum\/discuss\.php$/i.test(url.pathname)) {
      return "discussion";
    }
    return "unknown";
  }

  function getSesskey(doc = document) {
    const fromMoodleConfig = window.M?.cfg?.sesskey;
    const fromInput = doc.querySelector('input[name="sesskey"]')?.value;
    const fromBody = doc.body?.dataset?.sesskey;
    const fromHtml = (doc.documentElement?.innerHTML || "").match(/"sesskey"\s*:\s*"([^"]+)"/)?.[1];
    return fromMoodleConfig || fromInput || fromBody || fromHtml || null;
  }

  function getWwwRoot() {
    return window.M?.cfg?.wwwroot || location.origin;
  }

  function getForumTitle(doc = document) {
    return (
      textOf(doc.querySelector("h1")) ||
      textOf(doc.querySelector(".page-header-headings h1")) ||
      textOf(doc.querySelector("title")).replace(/\s*:\s*.+$/, "") ||
      "Moodle forum"
    );
  }

  function getDiscussionTitle(doc = document, fallback = "") {
    return (
      normalizeWhitespace(fallback) ||
      textOf(doc.querySelector(".discussionname")) ||
      textOf(doc.querySelector('[data-region="discussion-title"]')) ||
      textOf(doc.querySelector(".forumpost .subject")) ||
      textOf(doc.querySelector("h2")) ||
      textOf(doc.querySelector("h1")) ||
      "Discussao"
    );
  }

  function canonicalizeForumViewUrl(urlLike) {
    const url = getUrl(urlLike);
    const canonical = new URL(url.origin + url.pathname);
    if (url.searchParams.get("id")) {
      canonical.searchParams.set("id", url.searchParams.get("id"));
    }
    if (url.searchParams.get("o")) {
      canonical.searchParams.set("o", url.searchParams.get("o"));
    }
    return canonical.toString();
  }

  async function waitForRequestSlot() {
    const previous = requestQueue;
    let release = null;
    requestQueue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    const elapsed = Date.now() - lastRequestAt;
    const waitMs = Math.max(0, SETTINGS.requestDelayMs - elapsed);
    if (waitMs) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
    release();
  }

  async function withRetry(label, operation) {
    let lastError = null;
    for (let attempt = 0; attempt <= SETTINGS.retryCount; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < SETTINGS.retryCount) {
          await sleep(350 * (attempt + 1));
        }
      }
    }

    throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  async function fetchHtmlDocument(url) {
    return withRetry("Falha ao carregar pagina", async () => {
      await waitForRequestSlot();
      const response = await fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        throw new Error(`GET ${response.status}`);
      }

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return { url, doc };
    });
  }

  async function postJson(url, payload) {
    return withRetry("Falha no AJAX JSON", async () => {
      await waitForRequestSlot();
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`POST ${response.status}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Resposta AJAX nao e JSON");
      }
    });
  }

  async function expandVisibleThread(doc = document) {
    if (doc !== document) {
      return 0;
    }

    const labels = /show more|load more|display replies|view more|expand|see more|mostrar mais|carregar mais|ver mais|expandir/i;
    const clicked = new Set();
    let totalClicks = 0;

    for (let pass = 0; pass < 3; pass += 1) {
      const controls = Array.from(
        doc.querySelectorAll('button, [role="button"], a, summary, [aria-expanded="false"]')
      ).filter((node) => {
        const label = textOf(node) || node.getAttribute("aria-label") || node.getAttribute("title") || "";
        return labels.test(label);
      });

      let passClicks = 0;
      for (const control of controls) {
        const key =
          control.id ||
          control.getAttribute("aria-controls") ||
          control.getAttribute("href") ||
          textOf(control);
        if (!key || clicked.has(key)) {
          continue;
        }

        clicked.add(key);
        control.click();
        passClicks += 1;
        totalClicks += 1;
      }

      if (!passClicks) {
        break;
      }
      await sleep(600);
    }

    return totalClicks;
  }

  function findBestPostNodes(doc = document) {
    const selectors = [
      ".forumpost",
      '[data-region="post"]',
      'article[data-region="post"]',
      '[id^="p"][class*="post"]',
      ".discussion-post",
      ".forum-post-container",
    ];

    const variants = selectors.map((selector) => ({
      selector,
      nodes: Array.from(doc.querySelectorAll(selector)),
    }));
    variants.sort((a, b) => b.nodes.length - a.nodes.length);
    return variants.find((variant) => variant.nodes.length > 0) || { selector: null, nodes: [] };
  }

  function guessPostId(node, index) {
    return (
      parseNumericId(node.dataset?.postid) ||
      parseNumericId(node.getAttribute("data-post-id")) ||
      parseNumericId(node.id) ||
      index + 1
    );
  }

  function guessParentId(node) {
    return (
      parseNumericId(node.dataset?.parentid) ||
      parseNumericId(node.getAttribute("data-parent-id")) ||
      parseNumericId(node.getAttribute("data-replyto")) ||
      parseNumericId(node.querySelector('a[href*="reply="]')?.getAttribute("href")) ||
      null
    );
  }

  function guessDepth(node) {
    let depth = 0;
    let current = node.parentElement;
    while (current) {
      const className = String(current.className || "");
      if (
        /\bindent\b/i.test(className) ||
        /\breplies\b/i.test(className) ||
        current.getAttribute("data-region") === "replies"
      ) {
        depth += 1;
      }
      current = current.parentElement;
    }
    return depth;
  }

  function scrapeDomPosts(doc = document) {
    const { nodes } = findBestPostNodes(doc);
    return nodes.map((node, index) => {
      const subjectNode =
        node.querySelector(".subject, [data-region='subject'], h2, h3, h4, header h3") || null;
      const authorNode =
        node.querySelector(".author a, .author, [data-region='author-name'], .fullname a, .fullname") ||
        null;
      const contentNode =
        node.querySelector(
          ".content, .posting, .post-content, .text_to_html, .no-overflow, [data-region='post-content']"
        ) || node;

      return {
        id: guessPostId(node, index),
        parentId: guessParentId(node),
        depth: guessDepth(node),
        subject: textOf(subjectNode),
        author: textOf(authorNode),
        text: innerTextOf(contentNode),
      };
    });
  }

  function looksLikePostObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const keys = Object.keys(value).map((key) => key.toLowerCase());
    return POST_HINTS.some((hint) => keys.includes(hint));
  }

  function scorePostArray(items) {
    if (!Array.isArray(items) || !items.length) {
      return 0;
    }

    return items.reduce((score, item) => {
      if (!looksLikePostObject(item)) {
        return score;
      }
      const keys = Object.keys(item).map((key) => key.toLowerCase());
      return score + POST_HINTS.filter((hint) => keys.includes(hint)).length;
    }, 0);
  }

  function collectPostArrays(value, path = "$", seen = new WeakSet(), results = []) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return results;
    }

    seen.add(value);
    if (Array.isArray(value)) {
      const score = scorePostArray(value);
      if (score > 0) {
        results.push({ path, items: value, score });
      }
      value.forEach((item, index) => collectPostArrays(item, `${path}[${index}]`, seen, results));
      return results;
    }

    Object.entries(value).forEach(([key, child]) => collectPostArrays(child, `${path}.${key}`, seen, results));
    return results;
  }

  function normalizeAjaxPost(raw, index) {
    const author =
      raw.authorfullname ||
      raw.authorname ||
      raw.author?.fullname ||
      raw.author?.name ||
      raw.userfullname ||
      raw.user?.fullname ||
      "";

    const content =
      raw.messageinline ||
      raw.messagehtml ||
      raw.message ||
      raw.content ||
      raw.postcontent ||
      raw.text ||
      "";

    return {
      id: parseNumericId(raw.id) || index + 1,
      parentId: parseNumericId(raw.parentid || raw.parent || raw.replyto),
      depth: Number.isFinite(raw.depth) ? raw.depth : null,
      subject: normalizeWhitespace(raw.subject || raw.name || raw.title || ""),
      author: normalizeWhitespace(author),
      text: typeof content === "string" ? stripHtmlToText(content) : normalizeWhitespace(JSON.stringify(content)),
    };
  }

  async function probeAjaxPosts({ wwwroot, sesskey, discussionId }) {
    if (!sesskey || !discussionId) {
      return [];
    }

    for (const candidate of JSON_METHOD_CANDIDATES) {
      const args = candidate.buildArgs({ discussionId });
      const url =
        `${wwwroot.replace(/\/$/, "")}/lib/ajax/service.php` +
        `?sesskey=${encodeURIComponent(sesskey)}` +
        `&info=${encodeURIComponent(candidate.method)}`;
      const payload = [{ index: 0, methodname: candidate.method, args }];

      try {
        const json = await postJson(url, payload);
        const envelope = Array.isArray(json) ? json[0] : json;
        const data = envelope?.data ?? envelope;
        const best = collectPostArrays(data).sort((a, b) => b.score - a.score)[0];
        if (best?.items?.length) {
          return best.items.map((item, index) => normalizeAjaxPost(item, index));
        }
      } catch {
        // Se um metodo AJAX falhar, tentamos o proximo e depois o DOM.
      }
    }

    return [];
  }

  function buildQuestionAndAnswers(posts) {
    const ordered = posts.filter((post) => post && (post.text || post.subject || post.author));
    if (!ordered.length) {
      return { question: null, answers: [] };
    }

    const root =
      ordered.find((post) => post.parentId == null || post.parentId === 0 || post.depth === 0) || ordered[0];
    return {
      question: root,
      answers: ordered.filter((post) => post.id !== root.id),
    };
  }

  function isDateLikeTitle(value) {
    const text = normalizeWhitespace(value);
    return (
      /^\d{1,2}\s+\w+\s+\d{4}$/i.test(text) ||
      /^\d{1,2}\s+de\s+.+\s+de\s+\d{4}$/i.test(text) ||
      /^\w+\s+\d{1,2},?\s+\d{4}$/i.test(text) ||
      /^\d{4}-\d{2}-\d{2}$/i.test(text)
    );
  }

  function scoreDiscussionTitle(value) {
    const text = normalizeWhitespace(value);
    if (!text) {
      return -1000;
    }

    let score = text.length;
    if (isDateLikeTitle(text)) {
      score -= 1000;
    }
    if (/^(re:|reply|discussion|discussao)$/i.test(text)) {
      score -= 500;
    }
    return score;
  }

  function pickBestDiscussionTitle(candidates) {
    const unique = Array.from(new Set((candidates || []).map(normalizeWhitespace).filter(Boolean)));
    unique.sort((a, b) => scoreDiscussionTitle(b) - scoreDiscussionTitle(a));
    return unique[0] || "";
  }

  function makeExcerpt(value, maxLength = 120) {
    const text = normalizeWhitespace(value);
    if (!text) {
      return "";
    }
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
  }

  function simplifyPost(post) {
    if (!post) {
      return null;
    }

    const author = normalizeWhitespace(post.author);
    const text = normalizeWhitespace(post.text || post.subject);
    if (!author && !text) {
      return null;
    }

    return { author, text };
  }

  function simplifyDiscussion(discussion) {
    const question = simplifyPost(discussion.question);
    if (!question) {
      return null;
    }

    const rawTitle = normalizeWhitespace(discussion.title);
    const title = !rawTitle || isDateLikeTitle(rawTitle) ? makeExcerpt(question.text || rawTitle) : rawTitle;
    return {
      title,
      question,
      answers: (discussion.answers || []).map(simplifyPost).filter(Boolean),
    };
  }

  function buildSimpleForumResult(forumTitle, discussions) {
    return {
      forum: normalizeWhitespace(forumTitle || "Moodle forum"),
      discussions: discussions.map(simplifyDiscussion).filter(Boolean),
    };
  }

  function collectDiscussionLinks(doc = document, baseUrl = location.href) {
    const links = Array.from(doc.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]'));
    const byUrl = new Map();

    for (const link of links) {
      const absoluteUrl = toAbsoluteUrl(link.getAttribute("href"), baseUrl);
      const discussionId = absoluteUrl ? getDiscussionId(absoluteUrl) : null;
      if (!absoluteUrl || !discussionId) {
        continue;
      }

      const canonical = new URL(absoluteUrl);
      canonical.hash = "";
      const key = canonical.toString();
      if (!byUrl.has(key)) {
        byUrl.set(key, {
          discussionId,
          url: key,
          titleCandidates: [],
        });
      }
      byUrl.get(key).titleCandidates.push(textOf(link));
    }

    return Array.from(byUrl.values()).map((entry) => ({
      discussionId: entry.discussionId,
      url: entry.url,
      title: pickBestDiscussionTitle(entry.titleCandidates),
    }));
  }

  function collectForumPaginationLinks(doc = document, baseUrl = location.href) {
    const current = getUrl(baseUrl);
    const links = Array.from(doc.querySelectorAll('a[href*="/mod/forum/view.php"]'));
    const pages = new Set();

    for (const link of links) {
      const absoluteUrl = toAbsoluteUrl(link.getAttribute("href"), baseUrl);
      if (!absoluteUrl) {
        continue;
      }

      const url = new URL(absoluteUrl);
      if (!/\/mod\/forum\/view\.php$/i.test(url.pathname)) {
        continue;
      }
      if (url.searchParams.get("id") !== current.searchParams.get("id")) {
        continue;
      }
      pages.add(canonicalizeForumViewUrl(url.toString()));
    }

    return Array.from(pages);
  }

  function mergeDiscussionEntries(entries) {
    const byDiscussionId = new Map();
    for (const entry of entries) {
      const key = entry.discussionId || entry.url;
      if (!byDiscussionId.has(key)) {
        byDiscussionId.set(key, {
          discussionId: entry.discussionId,
          url: entry.url,
          titleCandidates: [],
        });
      }

      if (entry.title) {
        byDiscussionId.get(key).titleCandidates.push(entry.title);
      }
    }

    return Array.from(byDiscussionId.values()).map((entry) => ({
      discussionId: entry.discussionId,
      url: entry.url,
      title: pickBestDiscussionTitle(entry.titleCandidates),
    }));
  }

  async function collectAllForumViewPages(startUrl, callbacks) {
    const onProgress = callbacks?.onProgress || noop;
    const queue = [canonicalizeForumViewUrl(startUrl)];
    const visited = new Set();
    const pages = [];

    while (queue.length && pages.length < SETTINGS.maxForumPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) {
        continue;
      }

      visited.add(url);
      onProgress({ status: `A carregar pagina do forum ${pages.length + 1}` });
      const currentCanonical = canonicalizeForumViewUrl(location.href);
      const page = url === currentCanonical ? { url: location.href, doc: document } : await fetchHtmlDocument(url);
      pages.push(page);

      for (const nextUrl of collectForumPaginationLinks(page.doc, page.url)) {
        if (!visited.has(nextUrl) && !queue.includes(nextUrl)) {
          queue.push(nextUrl);
        }
      }
    }

    return pages;
  }

  async function runPool(items, worker, concurrency) {
    const results = new Array(items.length);
    let index = 0;

    async function consume() {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: workerCount }, consume));
    return results;
  }

  async function scrapeDiscussion(options) {
    const entry = options.entry;
    const doc = options.doc || null;
    const forumTitle = options.forumTitle || "";
    const expandVisible = Boolean(options.expandVisible);
    const onLog = options.onLog || noop;

    try {
      const page = doc ? { url: location.href, doc } : await fetchHtmlDocument(entry.url);
      if (expandVisible) {
        const clicks = await expandVisibleThread(page.doc);
        if (clicks) {
          onLog(`Respostas expandidas: ${clicks}`);
        }
      }

      const discussionId = entry.discussionId || getDiscussionId(page.url);
      const ajaxPosts = await probeAjaxPosts({
        wwwroot: getWwwRoot(),
        sesskey: getSesskey(document),
        discussionId,
      });
      const posts = ajaxPosts.length ? ajaxPosts : scrapeDomPosts(page.doc);
      const { question, answers } = buildQuestionAndAnswers(posts);

      return {
        ok: true,
        forumTitle: forumTitle || getForumTitle(page.doc),
        title: getDiscussionTitle(page.doc, entry.title),
        question,
        answers,
        postCount: posts.length,
      };
    } catch (error) {
      return {
        ok: false,
        title: entry.title || entry.url || "Discussao",
        error: error instanceof Error ? error.message : String(error),
        postCount: 0,
      };
    }
  }

  async function scrapeForum(options = {}) {
    const onProgress = options.onProgress || noop;
    const onLog = options.onLog || noop;
    const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || SETTINGS.defaultConcurrency)));

    if (getPageType() !== "forum") {
      throw new Error("Esta pagina nao e uma lista de forum.");
    }

    const forumTitle = getForumTitle(document);
    const pages = await collectAllForumViewPages(location.href, { onProgress });
    const entries = mergeDiscussionEntries(pages.flatMap((page) => collectDiscussionLinks(page.doc, page.url)));
    onProgress({ foundDiscussions: entries.length, status: "Discussoes encontradas" });
    onLog(`Discussoes encontradas: ${entries.length}`);

    const discussions = await runPool(
      entries,
      async (entry, index) => {
        onProgress({
          currentDiscussion: `${index + 1}/${entries.length}: ${entry.title || entry.discussionId}`,
          status: "A extrair discussoes",
        });

        const scraped = await scrapeDiscussion({ entry, forumTitle, onLog });
        if (!scraped.ok) {
          onProgress({ incrementErrors: 1 });
          onLog(`Erro: ${scraped.title}`);
        } else {
          onProgress({ incrementPosts: scraped.postCount });
        }
        return scraped;
      },
      concurrency
    );

    const result = buildSimpleForumResult(
      forumTitle,
      discussions.filter((discussion) => discussion.ok)
    );
    onProgress({
      status: `Concluido: ${result.discussions.length}/${entries.length} discussoes`,
      result,
    });
    return result;
  }

  async function scrapeCurrentDiscussion(options = {}) {
    const onProgress = options.onProgress || noop;
    const onLog = options.onLog || noop;

    if (getPageType() !== "discussion") {
      throw new Error("Esta pagina nao e uma discussao Moodle.");
    }

    const title = getDiscussionTitle(document);
    onProgress({ foundDiscussions: 1, currentDiscussion: title, status: "A extrair discussao" });

    const scraped = await scrapeDiscussion({
      entry: {
        discussionId: getDiscussionId(location.href),
        url: location.href,
        title,
      },
      doc: document,
      forumTitle: getForumTitle(document),
      expandVisible: true,
      onLog,
    });

    if (!scraped.ok) {
      onProgress({ incrementErrors: 1, status: "Erro ao extrair discussao" });
      throw new Error(scraped.error);
    }

    onProgress({ incrementPosts: scraped.postCount, status: "Discussao concluida" });
    return buildSimpleForumResult(scraped.forumTitle, [scraped]);
  }

  function toMarkdown(data) {
    const lines = [`# ${data.forum}`, ""];
    for (const discussion of data.discussions || []) {
      lines.push(`## ${discussion.title}`, "");
      lines.push(`**Pergunta - ${discussion.question.author || "Autor desconhecido"}**`);
      lines.push(discussion.question.text || "", "");
      for (const answer of discussion.answers || []) {
        lines.push(`**Resposta - ${answer.author || "Autor desconhecido"}**`);
        lines.push(answer.text || "", "");
      }
    }
    return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
  }

  function safeBaseName(value) {
    const name = normalizeWhitespace(value || "moodle-forum")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70);
    return name || "moodle-forum";
  }

  window.MoodleForumScraperCore = {
    SETTINGS,
    getPageType,
    scrapeForum,
    scrapeCurrentDiscussion,
    toMarkdown,
    safeBaseName,
    normalizeWhitespace,
  };
})();
