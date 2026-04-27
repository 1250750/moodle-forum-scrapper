// ==UserScript==
// @name         Moodle Forum Q&A Scraper
// @match        *://*/mod/forum/view.php*
// @match        *://*/mod/forum/discuss.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
Instalação:
1. Instale a extensão Tampermonkey no Brave/Chrome.
2. Crie um novo script no Tampermonkey.
3. Cole este ficheiro completo, guarde e abra um fórum Moodle já autenticado.

Segurança:
- Não pede nem guarda username/password.
- Usa apenas a sessão autenticada do browser.
- Não envia dados para servidores externos.
- Os dados ficam locais no browser até copiar ou descarregar.
*/

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
  let lastResult = null;
  let isRunning = false;

  const state = {
    foundDiscussions: 0,
    currentDiscussion: "",
    extractedPosts: 0,
    errors: 0,
    status: "Pronto",
    logs: [],
  };

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

  function getForumPageCmId(urlLike = location.href) {
    return parseNumericId(getUrl(urlLike).searchParams.get("id"));
  }

  function getSesskey(doc = document) {
    return (
      window.M?.cfg?.sesskey ||
      doc.querySelector('input[name="sesskey"]')?.value ||
      doc.body?.dataset?.sesskey ||
      null
    );
  }

  function getWwwRoot() {
    return window.M?.cfg?.wwwroot || location.origin;
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
    return withRetry(`Falha ao carregar pagina`, async () => {
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
    return withRetry(`Falha no AJAX JSON`, async () => {
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

    const best = variants.find((variant) => variant.nodes.length > 0);
    return best || { selector: null, nodes: [] };
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
    const questionId = root.id;
    return {
      question: root,
      answers: ordered.filter((post) => post.id !== questionId),
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

  async function collectAllForumViewPages(startUrl) {
    const queue = [canonicalizeForumViewUrl(startUrl)];
    const visited = new Set();
    const pages = [];

    while (queue.length && pages.length < SETTINGS.maxForumPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) {
        continue;
      }

      visited.add(url);
      setStatus(`A carregar pagina do forum ${pages.length + 1}`);
      const page = url === canonicalizeForumViewUrl(location.href) ? { url: location.href, doc: document } : await fetchHtmlDocument(url);
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

  async function scrapeDiscussion({ entry, doc = null, forumTitle = "", expandVisible = false }) {
    try {
      const page = doc ? { url: location.href, doc } : await fetchHtmlDocument(entry.url);
      if (expandVisible) {
        const clicks = await expandVisibleThread(page.doc);
        if (clicks) {
          addLog(`Respostas expandidas: ${clicks}`);
        }
      }

      const discussionId = entry.discussionId || getDiscussionId(page.url);
      const ajaxPosts = await probeAjaxPosts({
        wwwroot: getWwwRoot(),
        sesskey: getSesskey(document),
        discussionId,
      });
      const domPosts = ajaxPosts.length ? [] : scrapeDomPosts(page.doc);
      const posts = ajaxPosts.length ? ajaxPosts : domPosts;
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

  async function scrapeForum() {
    if (getPageType() !== "forum") {
      addLog("Esta pagina nao e uma lista de forum. Use Scrape current discussion.");
      setStatus("Pagina invalida para forum");
      return null;
    }

    resetStats("A iniciar scraping do forum");
    const forumTitle = getForumTitle(document);
    const pages = await collectAllForumViewPages(location.href);
    const entries = mergeDiscussionEntries(pages.flatMap((page) => collectDiscussionLinks(page.doc, page.url)));
    state.foundDiscussions = entries.length;
    renderProgress();
    addLog(`Discussoes encontradas: ${entries.length}`);

    const concurrency = getConfiguredConcurrency();
    const discussions = await runPool(
      entries,
      async (entry, index) => {
        state.currentDiscussion = `${index + 1}/${entries.length}: ${entry.title || entry.discussionId}`;
        setStatus("A extrair discussoes");
        const scraped = await scrapeDiscussion({ entry, forumTitle });
        if (scraped.ok) {
          state.extractedPosts += scraped.postCount;
        } else {
          state.errors += 1;
          addLog(`Erro: ${scraped.title}`);
        }
        renderProgress();
        return scraped;
      },
      concurrency
    );

    lastResult = buildSimpleForumResult(
      forumTitle,
      discussions.filter((discussion) => discussion.ok)
    );
    window.__MOODLE_FORUM_QA_SCRAPER__ = lastResult;
    setStatus(`Concluido: ${lastResult.discussions.length}/${entries.length} discussoes`);
    addLog("Scraping concluido");
    return lastResult;
  }

  async function scrapeCurrentDiscussion() {
    if (getPageType() !== "discussion") {
      addLog("Esta pagina nao e uma discussao Moodle.");
      setStatus("Pagina invalida para discussao");
      return null;
    }

    resetStats("A iniciar scraping da discussao");
    state.foundDiscussions = 1;
    state.currentDiscussion = getDiscussionTitle(document);
    renderProgress();

    const scraped = await scrapeDiscussion({
      entry: {
        discussionId: getDiscussionId(location.href),
        url: location.href,
        title: getDiscussionTitle(document),
      },
      doc: document,
      forumTitle: getForumTitle(document),
      expandVisible: true,
    });

    if (scraped.ok) {
      state.extractedPosts = scraped.postCount;
      lastResult = buildSimpleForumResult(scraped.forumTitle, [scraped]);
      window.__MOODLE_FORUM_QA_SCRAPER__ = lastResult;
      setStatus("Discussao concluida");
      addLog("Scraping concluido");
    } else {
      state.errors = 1;
      setStatus("Erro ao extrair discussao");
      addLog(scraped.error);
    }

    renderProgress();
    return lastResult;
  }

  function toMarkdown(data) {
    const lines = [`# ${data.forum}`, ""];
    for (const discussion of data.discussions || []) {
      lines.push(`## ${discussion.title}`, "");
      lines.push(`**Pergunta — ${discussion.question.author || "Autor desconhecido"}**`);
      lines.push(discussion.question.text || "", "");
      for (const answer of discussion.answers || []) {
        lines.push(`**Resposta — ${answer.author || "Autor desconhecido"}**`);
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

  function downloadText(content, filename, type) {
    const blob = new Blob([content], { type });
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

  function downloadJson() {
    if (!lastResult) {
      addLog("Sem dados para descarregar.");
      return;
    }
    downloadText(
      JSON.stringify(lastResult, null, 2),
      `${safeBaseName(lastResult.forum)}.json`,
      "application/json;charset=utf-8"
    );
    addLog("JSON descarregado");
  }

  function downloadMarkdown() {
    if (!lastResult) {
      addLog("Sem dados para descarregar.");
      return;
    }
    downloadText(toMarkdown(lastResult), `${safeBaseName(lastResult.forum)}.md`, "text/markdown;charset=utf-8");
    addLog("Markdown descarregado");
  }

  async function copyJson() {
    if (!lastResult) {
      addLog("Sem dados para copiar.");
      return;
    }

    const text = JSON.stringify(lastResult, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      addLog("JSON copiado para clipboard");
    } catch (error) {
      addLog(`Erro ao copiar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runExclusive(task) {
    if (isRunning) {
      addLog("Ja existe um scraping em curso.");
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    try {
      await task();
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
    }
  }

  function resetStats(status) {
    state.foundDiscussions = 0;
    state.currentDiscussion = "";
    state.extractedPosts = 0;
    state.errors = 0;
    state.status = status;
    state.logs = [];
    renderProgress();
    addLog(status);
  }

  function setStatus(status) {
    state.status = status;
    renderProgress();
  }

  function addLog(message) {
    state.logs.unshift(`${new Date().toLocaleTimeString()} - ${normalizeWhitespace(message)}`);
    state.logs = state.logs.slice(0, 6);
    renderLogs();
  }

  function getConfiguredConcurrency() {
    const input = document.querySelector("#mfsConcurrency");
    const value = Number(input?.value || SETTINGS.defaultConcurrency);
    return Math.max(1, Math.min(8, Number.isFinite(value) ? Math.round(value) : SETTINGS.defaultConcurrency));
  }

  function createButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mfs-button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function createUi() {
    if (document.querySelector("#moodleForumScraper")) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = `
      #moodleForumScraper {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 99999;
        width: 320px;
        max-width: calc(100vw - 36px);
        border: 1px solid rgba(26, 35, 51, 0.18);
        border-radius: 16px;
        background: linear-gradient(145deg, #f8fbff, #eef4f7);
        color: #172033;
        box-shadow: 0 18px 50px rgba(12, 20, 31, 0.22);
        font: 13px/1.35 "Segoe UI", Tahoma, sans-serif;
        overflow: hidden;
      }
      #moodleForumScraper.mfs-minimized .mfs-body {
        display: none;
      }
      #moodleForumScraper .mfs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: #172033;
        color: #fff;
      }
      #moodleForumScraper .mfs-title {
        font-weight: 700;
        letter-spacing: 0.01em;
      }
      #moodleForumScraper .mfs-minimize {
        border: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        cursor: pointer;
        width: 28px;
        height: 28px;
      }
      #moodleForumScraper .mfs-body {
        padding: 12px;
      }
      #moodleForumScraper .mfs-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #moodleForumScraper .mfs-button {
        border: 0;
        border-radius: 10px;
        background: #245b4f;
        color: #fff;
        cursor: pointer;
        padding: 9px 10px;
        font-weight: 650;
      }
      #moodleForumScraper .mfs-button:nth-child(3),
      #moodleForumScraper .mfs-button:nth-child(4),
      #moodleForumScraper .mfs-button:nth-child(5),
      #moodleForumScraper .mfs-button:nth-child(6) {
        background: #31475f;
      }
      #moodleForumScraper .mfs-button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      #moodleForumScraper .mfs-progress {
        margin-top: 10px;
        border-radius: 12px;
        background: rgba(23, 32, 51, 0.07);
        padding: 10px;
      }
      #moodleForumScraper .mfs-progress div {
        margin: 2px 0;
      }
      #moodleForumScraper .mfs-current {
        word-break: break-word;
      }
      #moodleForumScraper .mfs-options {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      #moodleForumScraper .mfs-options input {
        width: 54px;
        border: 1px solid rgba(23, 32, 51, 0.2);
        border-radius: 8px;
        padding: 5px 7px;
      }
      #moodleForumScraper .mfs-logs {
        margin-top: 10px;
        min-height: 72px;
        max-height: 96px;
        overflow: auto;
        border-radius: 10px;
        background: #101827;
        color: #d9e7e2;
        padding: 8px;
        font: 11px/1.35 Consolas, monospace;
        white-space: pre-wrap;
      }
      #mfsPreviewOverlay {
        position: fixed;
        inset: 0;
        z-index: 100000;
        background: rgba(5, 10, 18, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      #mfsPreviewModal {
        width: min(860px, 96vw);
        max-height: 88vh;
        overflow: auto;
        border-radius: 18px;
        background: #fbfaf6;
        color: #172033;
        box-shadow: 0 25px 80px rgba(0, 0, 0, 0.35);
      }
      #mfsPreviewModal .mfs-preview-header {
        position: sticky;
        top: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px 18px;
        background: #fbfaf6;
        border-bottom: 1px solid rgba(23, 32, 51, 0.12);
      }
      #mfsPreviewModal .mfs-preview-content {
        padding: 18px;
      }
      #mfsPreviewModal .mfs-preview-discussion {
        padding: 16px 0;
        border-bottom: 1px solid rgba(23, 32, 51, 0.12);
      }
      #mfsPreviewModal h2 {
        margin: 0 0 10px;
        font-size: 20px;
      }
      #mfsPreviewModal h3 {
        margin: 12px 0 6px;
        font-size: 14px;
        color: #245b4f;
      }
      #mfsPreviewModal p {
        margin: 0 0 10px;
        white-space: pre-wrap;
      }
      #mfsPreviewModal button {
        border: 0;
        border-radius: 10px;
        background: #172033;
        color: #fff;
        cursor: pointer;
        padding: 8px 12px;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement("section");
    panel.id = "moodleForumScraper";

    const header = document.createElement("div");
    header.className = "mfs-header";
    const title = document.createElement("div");
    title.className = "mfs-title";
    title.textContent = "Moodle Scraper";
    const minimize = document.createElement("button");
    minimize.type = "button";
    minimize.className = "mfs-minimize";
    minimize.textContent = "-";
    minimize.title = "Minimizar";
    minimize.addEventListener("click", () => {
      panel.classList.toggle("mfs-minimized");
      minimize.textContent = panel.classList.contains("mfs-minimized") ? "+" : "-";
    });
    header.append(title, minimize);

    const body = document.createElement("div");
    body.className = "mfs-body";

    const actions = document.createElement("div");
    actions.className = "mfs-actions";
    actions.append(
      createButton("Scrape forum", () => runExclusive(scrapeForum)),
      createButton("Scrape current discussion", () => runExclusive(scrapeCurrentDiscussion)),
      createButton("Preview", showPreview),
      createButton("Download JSON", downloadJson),
      createButton("Download Markdown", downloadMarkdown),
      createButton("Copy JSON", copyJson)
    );

    const options = document.createElement("label");
    options.className = "mfs-options";
    options.textContent = "Concorrencia";
    const concurrency = document.createElement("input");
    concurrency.id = "mfsConcurrency";
    concurrency.type = "number";
    concurrency.min = "1";
    concurrency.max = "8";
    concurrency.value = String(SETTINGS.defaultConcurrency);
    options.appendChild(concurrency);

    const progress = document.createElement("div");
    progress.className = "mfs-progress";
    progress.id = "mfsProgress";

    const logs = document.createElement("div");
    logs.className = "mfs-logs";
    logs.id = "mfsLogs";

    body.append(actions, options, progress, logs);
    panel.append(header, body);
    document.body.appendChild(panel);

    renderProgress();
    renderLogs();
  }

  function renderProgress() {
    const progress = document.querySelector("#mfsProgress");
    if (!progress) {
      return;
    }

    progress.innerHTML = "";
    const lines = [
      ["Estado", state.status],
      ["Discussoes encontradas", state.foundDiscussions],
      ["Discussao atual", state.currentDiscussion || "-"],
      ["Posts extraidos", state.extractedPosts],
      ["Erros", state.errors],
    ];

    for (const [label, value] of lines) {
      const line = document.createElement("div");
      if (label === "Discussao atual") {
        line.className = "mfs-current";
      }
      line.textContent = `${label}: ${value}`;
      progress.appendChild(line);
    }
  }

  function renderLogs() {
    const logs = document.querySelector("#mfsLogs");
    if (!logs) {
      return;
    }
    logs.textContent = state.logs.length ? state.logs.join("\n") : "Sem logs.";
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll("#moodleForumScraper .mfs-button").forEach((button) => {
      const label = button.textContent || "";
      button.disabled = disabled && /^Scrape /.test(label);
    });
  }

  function showPreview() {
    if (!lastResult) {
      addLog("Sem dados para preview.");
      return;
    }

    document.querySelector("#mfsPreviewOverlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "mfsPreviewOverlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    });

    const modal = document.createElement("div");
    modal.id = "mfsPreviewModal";

    const header = document.createElement("div");
    header.className = "mfs-preview-header";
    const heading = document.createElement("strong");
    heading.textContent = `Preview: ${lastResult.forum}`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Fechar";
    close.addEventListener("click", () => overlay.remove());
    header.append(heading, close);

    const content = document.createElement("div");
    content.className = "mfs-preview-content";

    for (const discussion of lastResult.discussions || []) {
      const block = document.createElement("article");
      block.className = "mfs-preview-discussion";

      const title = document.createElement("h2");
      title.textContent = discussion.title;
      block.appendChild(title);

      const questionTitle = document.createElement("h3");
      questionTitle.textContent = `Pergunta - ${discussion.question.author || "Autor desconhecido"}`;
      const question = document.createElement("p");
      question.textContent = discussion.question.text || "";
      block.append(questionTitle, question);

      for (const answer of discussion.answers || []) {
        const answerTitle = document.createElement("h3");
        answerTitle.textContent = `Resposta - ${answer.author || "Autor desconhecido"}`;
        const answerText = document.createElement("p");
        answerText.textContent = answer.text || "";
        block.append(answerTitle, answerText);
      }

      content.appendChild(block);
    }

    modal.append(header, content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  createUi();
})();
