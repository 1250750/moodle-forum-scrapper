(() => {
  const LOG_PREFIX = "[moodle-scrape]";
  const POST_HINTS = ["id", "subject", "message", "author", "authorfullname", "timecreated", "parentid"];
  const DISCUSSION_PAGE_LIMIT = 200;
  const DISCUSSION_CONCURRENCY = 3;
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

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function textOf(node) {
    return normalizeWhitespace(node ? node.textContent : "");
  }

  function innerTextOf(node) {
    return normalizeWhitespace(node ? node.innerText || node.textContent : "");
  }

  function htmlOf(node) {
    return node ? String(node.innerHTML || "").trim() : "";
  }

  function unique(items) {
    return [...new Set(items.filter(Boolean))];
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
    const url = getUrl(urlLike);
    return parseNumericId(url.searchParams.get("d"));
  }

  function getForumPageCmId(urlLike = location.href) {
    const url = getUrl(urlLike);
    return parseNumericId(url.searchParams.get("id"));
  }

  function getSesskey(doc = document) {
    return (
      globalThis.M?.cfg?.sesskey ||
      doc.querySelector('input[name="sesskey"]')?.value ||
      doc.body?.dataset?.sesskey ||
      null
    );
  }

  function getWwwRoot() {
    return globalThis.M?.cfg?.wwwroot || location.origin;
  }

  function getPageTitle(doc = document) {
    return (
      textOf(doc.querySelector("h1")) ||
      textOf(doc.querySelector(".discussionname")) ||
      textOf(doc.querySelector("title"))
    );
  }

  function getPageType(urlLike = location.href) {
    const url = getUrl(urlLike);
    if (/\/mod\/forum\/view\.php$/i.test(url.pathname)) {
      return "forum-view";
    }
    if (/\/mod\/forum\/discuss\.php$/i.test(url.pathname)) {
      return "forum-discussion";
    }
    return "unknown";
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

  function collectNetworkEvidence() {
    const entries = performance.getEntriesByType("resource");
    return entries
      .filter((entry) => {
        const name = entry.name || "";
        const initiator = entry.initiatorType || "";
        return (
          /(forum|discussion|post|service\.php|ajax)/i.test(name) ||
          /fetch|xmlhttprequest/i.test(initiator)
        );
      })
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType || null,
        transferSize: entry.transferSize || null,
        durationMs: Number.isFinite(entry.duration) ? Number(entry.duration.toFixed(2)) : null,
      }));
  }

  function collectScriptEvidence(doc = document, baseUrl = location.href) {
    const snippets = [];
    const html = doc.documentElement?.outerHTML || "";
    const patterns = [
      /service\.php[^\s"'<>]*/gi,
      /mod_forum_[a-z0-9_]+/gi,
      /core\/ajax/gi,
      /forum\/discuss\.php[^\s"'<>]*/gi,
    ];

    for (const pattern of patterns) {
      const matches = html.match(pattern) || [];
      for (const match of matches) {
        snippets.push(match);
      }
    }

    for (const script of Array.from(doc.scripts || [])) {
      if (script.src && /(forum|ajax|service\.php)/i.test(script.src)) {
        snippets.push(toAbsoluteUrl(script.src, baseUrl));
      }
    }

    return unique(snippets).slice(0, 100);
  }

  async function expandVisibleThread(doc = document) {
    if (doc !== document) {
      return [];
    }

    const labels = /show more|load more|display replies|view more|expand|see more|mostrar mais|carregar mais|ver mais|expandir/i;
    const clicked = [];

    for (let pass = 0; pass < 3; pass += 1) {
      const controls = Array.from(
        doc.querySelectorAll('button, [role="button"], a, summary, [aria-expanded="false"]')
      ).filter((node) => {
        const label =
          textOf(node) ||
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          "";
        return labels.test(label);
      });

      let passClicks = 0;
      for (const control of controls) {
        const key =
          control.id ||
          control.getAttribute("aria-controls") ||
          control.getAttribute("href") ||
          textOf(control);
        if (!key || clicked.includes(key)) {
          continue;
        }
        clicked.push(key);
        control.click();
        passClicks += 1;
      }

      if (!passClicks) {
        break;
      }

      await sleep(600);
    }

    return clicked;
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
    const best = variants.find((variant) => variant.nodes.length > 0);
    if (!best) {
      return { selector: null, nodes: [] };
    }

    const deduped = [];
    const seen = new Set();
    for (const node of best.nodes) {
      if (!seen.has(node)) {
        seen.add(node);
        deduped.push(node);
      }
    }

    return { selector: best.selector, nodes: deduped };
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

  function scrapeDomPosts(doc = document, baseUrl = location.href) {
    const { selector, nodes } = findBestPostNodes(doc);
    const posts = nodes.map((node, index) => {
      const subjectNode =
        node.querySelector(".subject, [data-region='subject'], h2, h3, h4, header h3") || null;
      const authorNode =
        node.querySelector(".author a, .author, [data-region='author-name'], .fullname a, .fullname") ||
        null;
      const timeNode =
        node.querySelector("time, .author .date, .date, [data-region='timecreated']") || null;
      const contentNode =
        node.querySelector(
          ".content, .posting, .post-content, .text_to_html, .no-overflow, [data-region='post-content']"
        ) || node;
      const permalinkNode =
        node.querySelector('a[href*="/mod/forum/discuss.php?d="][href*="#p"]') ||
        node.querySelector('a[href*="#p"]') ||
        null;
      const attachmentNodes = Array.from(
        node.querySelectorAll('a[href*="/pluginfile.php"], a[href*="/draftfile.php"], .attachments a')
      );

      return {
        id: guessPostId(node, index),
        parentId: guessParentId(node),
        depth: guessDepth(node),
        subject: textOf(subjectNode),
        author: textOf(authorNode),
        timeText: textOf(timeNode),
        timeIso: timeNode?.getAttribute("datetime") || null,
        contentText: innerTextOf(contentNode),
        contentHtml: htmlOf(contentNode),
        permalink: permalinkNode ? toAbsoluteUrl(permalinkNode.getAttribute("href"), baseUrl) : null,
        attachments: attachmentNodes.map((attachment) => ({
          name: textOf(attachment),
          url: toAbsoluteUrl(attachment.getAttribute("href"), baseUrl),
        })),
      };
    });

    return { selectorUsed: selector, posts };
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
    if (!value || typeof value !== "object") {
      return results;
    }

    if (seen.has(value)) {
      return results;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const score = scorePostArray(value);
      if (score > 0) {
        results.push({ path, items: value, score });
      }
      value.forEach((item, index) => {
        collectPostArrays(item, `${path}[${index}]`, seen, results);
      });
      return results;
    }

    for (const [key, child] of Object.entries(value)) {
      collectPostArrays(child, `${path}.${key}`, seen, results);
    }
    return results;
  }

  function normalizeAjaxPost(raw, index, baseUrl) {
    const author =
      raw.authorfullname ||
      raw.authorname ||
      raw.author?.fullname ||
      raw.author?.name ||
      raw.userfullname ||
      raw.user?.fullname ||
      "";

    const contentHtml =
      raw.messageinline ||
      raw.messagehtml ||
      raw.message ||
      raw.content ||
      raw.postcontent ||
      raw.text ||
      "";

    const contentText = normalizeWhitespace(
      typeof contentHtml === "string"
        ? contentHtml.replace(/<[^>]+>/g, " ")
        : JSON.stringify(contentHtml)
    );

    return {
      id: parseNumericId(raw.id) || index + 1,
      parentId: parseNumericId(raw.parentid || raw.parent || raw.replyto),
      depth: Number.isFinite(raw.depth) ? raw.depth : null,
      subject: normalizeWhitespace(raw.subject || raw.name || raw.title || ""),
      author: normalizeWhitespace(author),
      timeText: normalizeWhitespace(raw.timecreatedformatted || raw.timemodifiedformatted || ""),
      timeIso: raw.timecreated || raw.modified || raw.timemodified || null,
      contentText,
      contentHtml: typeof contentHtml === "string" ? contentHtml : JSON.stringify(contentHtml),
      permalink: toAbsoluteUrl(raw.permalink || raw.url || raw.link || "", baseUrl),
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments.map((attachment) => ({
            name: normalizeWhitespace(attachment.filename || attachment.name || ""),
            url: toAbsoluteUrl(attachment.fileurl || attachment.url || "", baseUrl),
          }))
        : [],
      raw,
    };
  }

  async function postJson(url, payload) {
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
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      text,
      json,
    };
  }

  async function probeAjaxPosts({ wwwroot, sesskey, discussionId, baseUrl }) {
    const result = {
      foundJsonEndpoint: false,
      endpoint: null,
      method: null,
      args: null,
      path: null,
      attempts: [],
      posts: [],
    };

    if (!sesskey || !discussionId) {
      result.attempts.push({ skipped: true, reason: "Missing sesskey or discussionId" });
      return result;
    }

    for (const candidate of JSON_METHOD_CANDIDATES) {
      const args = candidate.buildArgs({ discussionId });
      const url =
        `${wwwroot.replace(/\/$/, "")}/lib/ajax/service.php` +
        `?sesskey=${encodeURIComponent(sesskey)}` +
        `&info=${encodeURIComponent(candidate.method)}`;
      const payload = [{ index: 0, methodname: candidate.method, args }];

      try {
        const response = await postJson(url, payload);
        const attempt = {
          method: candidate.method,
          args,
          url,
          ok: response.ok,
          status: response.status,
          contentType: response.contentType,
          isJson: Boolean(response.json),
        };

        if (!response.json) {
          attempt.preview = normalizeWhitespace(response.text).slice(0, 250);
          result.attempts.push(attempt);
          continue;
        }

        const envelope = Array.isArray(response.json) ? response.json[0] : response.json;
        const data = envelope?.data ?? envelope;
        const collections = collectPostArrays(data).sort((a, b) => b.score - a.score);
        const best = collections[0] || null;

        attempt.envelopeKeys = envelope && typeof envelope === "object" ? Object.keys(envelope) : [];
        attempt.dataKeys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
        attempt.bestPath = best?.path || null;
        attempt.bestScore = best?.score || 0;
        result.attempts.push(attempt);

        if (!best) {
          continue;
        }

        result.foundJsonEndpoint = true;
        result.endpoint = url;
        result.method = candidate.method;
        result.args = args;
        result.path = best.path;
        result.posts = best.items.map((item, index) => normalizeAjaxPost(item, index, baseUrl));
        return result;
      } catch (error) {
        result.attempts.push({
          method: candidate.method,
          args,
          url,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  function buildQuestionAndAnswers(posts) {
    const ordered = posts.filter((post) => post && (post.contentText || post.subject || post.author));
    if (!ordered.length) {
      return { question: null, answers: [] };
    }

    const root =
      ordered.find((post) => post.parentId == null || post.parentId === 0 || post.depth === 0) || ordered[0];
    const questionId = root.id;
    const answers = ordered.filter((post) => post.id !== questionId);
    return { question: root, answers };
  }

  function isDateLikeTitle(value) {
    const text = normalizeWhitespace(value);
    if (!text) {
      return false;
    }
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
    if (/^(re:|reply|discussion)$/i.test(text)) {
      score -= 500;
    }
    return score;
  }

  function pickBestDiscussionTitle(candidates) {
    const cleaned = unique((candidates || []).map((value) => normalizeWhitespace(value))).filter(Boolean);
    cleaned.sort((a, b) => scoreDiscussionTitle(b) - scoreDiscussionTitle(a));
    return cleaned[0] || "";
  }

  function simplifyPost(post) {
    if (!post) {
      return null;
    }

    const author = normalizeWhitespace(post.author || "");
    const text = normalizeWhitespace(post.contentText || post.subject || "");
    if (!author && !text) {
      return null;
    }

    return {
      author,
      text,
    };
  }

  function makeExcerpt(value, maxLength = 120) {
    const text = normalizeWhitespace(value);
    if (!text) {
      return "";
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }

  function simplifyDiscussion(discussion) {
    const question = simplifyPost(discussion.question);
    const answers = (discussion.answers || []).map((answer) => simplifyPost(answer)).filter(Boolean);
    if (!question) {
      return null;
    }

    const rawTitle = normalizeWhitespace(discussion.title || "");
    const title =
      !rawTitle || isDateLikeTitle(rawTitle) ? makeExcerpt(question.text || rawTitle) : rawTitle;

    return {
      title,
      question,
      answers,
    };
  }

  function buildSimpleForumResult({ title, discussions }) {
    return {
      forum: normalizeWhitespace(title || ""),
      discussions: (discussions || []).map((discussion) => simplifyDiscussion(discussion)).filter(Boolean),
    };
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 1000);
  }

  async function fetchHtmlDocument(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { url, html, doc };
  }

  function collectDiscussionLinks(doc = document, baseUrl = location.href) {
    const links = Array.from(doc.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]'));
    const byUrl = new Map();

    for (const link of links) {
      const href = link.getAttribute("href");
      const absoluteUrl = toAbsoluteUrl(href, baseUrl);
      const discussionId = getDiscussionId(absoluteUrl || "");
      if (!absoluteUrl || !discussionId) {
        continue;
      }

      const canonicalUrl = (() => {
        const u = new URL(absoluteUrl);
        u.hash = "";
        return u.toString();
      })();

      if (!byUrl.has(canonicalUrl)) {
        const row =
          link.closest("tr, li, article, .discussion, [data-region='discussion']") || link.parentElement;
        byUrl.set(canonicalUrl, {
          discussionId,
          url: canonicalUrl,
          titleCandidates: [],
          listContext: row ? innerTextOf(row).slice(0, 500) : "",
        });
      }

      byUrl.get(canonicalUrl).titleCandidates.push(textOf(link));
    }

    return Array.from(byUrl.values()).map((entry) => ({
      discussionId: entry.discussionId,
      url: entry.url,
      title: pickBestDiscussionTitle(entry.titleCandidates),
      listContext: entry.listContext,
    }));
  }

  function collectForumPaginationLinks(doc = document, baseUrl = location.href) {
    const current = getUrl(baseUrl);
    const links = Array.from(doc.querySelectorAll('a[href*="/mod/forum/view.php"]'));
    const pages = new Map();

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

      const canonicalUrl = canonicalizeForumViewUrl(url.toString());
      const key = canonicalUrl;
      if (!pages.has(key)) {
        pages.set(key, canonicalUrl);
      }
    }

    return Array.from(pages.values());
  }

  async function collectAllForumViewPages(startUrl) {
    const queue = [canonicalizeForumViewUrl(startUrl)];
    const visited = new Set();
    const pages = [];

    while (queue.length && pages.length < DISCUSSION_PAGE_LIMIT) {
      const url = queue.shift();
      if (!url || visited.has(url)) {
        continue;
      }

      visited.add(url);
      log(`Fetching forum page ${pages.length + 1}: ${url}`);

      const page = await fetchHtmlDocument(url);
      pages.push(page);

      const nextLinks = collectForumPaginationLinks(page.doc, page.url);
      for (const nextUrl of nextLinks) {
        if (!visited.has(nextUrl) && !queue.includes(nextUrl)) {
          queue.push(nextUrl);
        }
      }
    }

    return pages;
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
          listContext: entry.listContext || "",
        });
      }

      const current = byDiscussionId.get(key);
      if (entry.title) {
        current.titleCandidates.push(entry.title);
      }
      if (!current.listContext && entry.listContext) {
        current.listContext = entry.listContext;
      }
    }

    return Array.from(byDiscussionId.values()).map((entry) => ({
      discussionId: entry.discussionId,
      url: entry.url,
      title: pickBestDiscussionTitle(entry.titleCandidates),
      listContext: entry.listContext,
    }));
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

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () =>
      consume()
    );
    await Promise.all(workers);
    return results;
  }

  async function scrapeDiscussionPage({ entry, sesskey, wwwroot }) {
    try {
      const page = await fetchHtmlDocument(entry.url);
      const clickedControls = await expandVisibleThread(page.doc);
      const discussionId = entry.discussionId || getDiscussionId(page.url);
      const ajax = await probeAjaxPosts({
        wwwroot,
        sesskey,
        discussionId,
        baseUrl: page.url,
      });
      const dom = scrapeDomPosts(page.doc, page.url);
      const source = ajax.foundJsonEndpoint && ajax.posts.length ? "ajax-json" : "dom";
      const posts = source === "ajax-json" ? ajax.posts : dom.posts;
      const { question, answers } = buildQuestionAndAnswers(posts);

      return {
        discussionId,
        url: page.url,
        title: entry.title || getPageTitle(page.doc),
        source,
        question,
        answers,
        posts,
        counts: {
          posts: posts.length,
          answers: answers.length,
        },
        evidence: {
          clickedControls,
          domSelectorUsed: dom.selectorUsed,
          ajaxEndpoint: ajax.foundJsonEndpoint
            ? {
                endpoint: ajax.endpoint,
                method: ajax.method,
                args: ajax.args,
                responsePath: ajax.path,
              }
            : null,
          ajaxAttempts: ajax.attempts,
          scriptCandidates: collectScriptEvidence(page.doc, page.url),
        },
      };
    } catch (error) {
      return {
        discussionId: entry.discussionId || null,
        url: entry.url,
        title: entry.title || "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function buildFilename(title, forumCmId) {
    const safeTitle = normalizeWhitespace(title || `forum-${forumCmId || "export"}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "moodle-forum";
    return `${safeTitle}-${forumCmId || "export"}.json`;
  }

  async function scrapeForumViewPage() {
    const forumUrl = location.href;
    const forumCmId = getForumPageCmId(forumUrl);
    const sesskey = getSesskey(document);
    const wwwroot = getWwwRoot();

    const forumPages = await collectAllForumViewPages(forumUrl);
    const discussionEntries = mergeDiscussionEntries(
      forumPages.flatMap((page) => collectDiscussionLinks(page.doc, page.url))
    );

    log(`Discovered ${discussionEntries.length} discussions across ${forumPages.length} forum page(s)`);

    const discussions = await runPool(
      discussionEntries,
      async (entry, index) => {
        log(`Scraping discussion ${index + 1}/${discussionEntries.length}: ${entry.url}`);
        return scrapeDiscussionPage({ entry, sesskey, wwwroot });
      },
      DISCUSSION_CONCURRENCY
    );

    const successful = discussions.filter((item) => !item.error);
    const failed = discussions.filter((item) => item.error);
    const totalPosts = successful.reduce((sum, item) => sum + (item.counts?.posts || 0), 0);
    const result = buildSimpleForumResult({
      title: getPageTitle(document),
      discussions: successful,
    });

    window.__MOODLE_FORUM_SCRAPE__ = result;
    const filename = buildFilename(result.forum, forumCmId);
    downloadJson(result, filename);

    log(`Done. discussions=${result.discussions.length}/${discussionEntries.length}, posts=${totalPosts}, download=${filename}`);
    if (failed.length) {
      warn(`Some discussions failed: ${failed.length}`);
    }

    console.log(result);
    return result;
  }

  async function scrapeSingleDiscussionFallback() {
    const clickedControls = await expandVisibleThread(document);
    const discussionId = getDiscussionId(location.href);
    const sesskey = getSesskey(document);
    const wwwroot = getWwwRoot();
    const ajax = await probeAjaxPosts({
      wwwroot,
      sesskey,
      discussionId,
      baseUrl: location.href,
    });
    const dom = scrapeDomPosts(document, location.href);
    const source = ajax.foundJsonEndpoint && ajax.posts.length ? "ajax-json" : "dom";
    const posts = source === "ajax-json" ? ajax.posts : dom.posts;
    const { question, answers } = buildQuestionAndAnswers(posts);

    const result = buildSimpleForumResult({
      title: getPageTitle(document),
      discussions: [
        {
          discussionId,
          url: location.href,
          title: getPageTitle(document),
          question,
          answers,
          posts,
          source,
          evidence: {
            clickedControls,
            networkCandidates: collectNetworkEvidence(),
            scriptCandidates: collectScriptEvidence(document, location.href),
            ajaxAttempts: ajax.attempts,
            domSelectorUsed: dom.selectorUsed,
          },
        },
      ],
    });

    window.__MOODLE_FORUM_SCRAPE__ = result;
    const filename = buildFilename(result.forum, discussionId);
    downloadJson(result, filename);
    log(`Done. single discussion, posts=${posts.length}, download=${filename}`);
    console.log(result);
    return result;
  }

  async function main() {
    log("Starting scrape", location.href);
    const pageType = getPageType(location.href);

    if (pageType === "forum-view") {
      return scrapeForumViewPage();
    }

    warn("Current page is not forum view; running single discussion fallback.");
    return scrapeSingleDiscussionFallback();
  }

  main().catch((error) => {
    console.error(LOG_PREFIX, error);
    throw error;
  });
})();
