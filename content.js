(function () {
  "use strict";

  const core = window.MoodleForumScraperCore;
  if (!core || document.querySelector("#moodleForumScraper")) {
    return;
  }

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

  function updateState(update) {
    if (!update) {
      renderProgress();
      return;
    }

    if (typeof update.foundDiscussions === "number") {
      state.foundDiscussions = update.foundDiscussions;
    }
    if (typeof update.currentDiscussion === "string") {
      state.currentDiscussion = update.currentDiscussion;
    }
    if (typeof update.status === "string") {
      state.status = update.status;
    }
    if (typeof update.incrementPosts === "number") {
      state.extractedPosts += update.incrementPosts;
    }
    if (typeof update.incrementErrors === "number") {
      state.errors += update.incrementErrors;
    }
    if (update.result) {
      lastResult = update.result;
      window.__MOODLE_FORUM_QA_SCRAPER__ = lastResult;
    }

    renderProgress();
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

  function addLog(message) {
    state.logs.unshift(`${new Date().toLocaleTimeString()} - ${core.normalizeWhitespace(message)}`);
    state.logs = state.logs.slice(0, 6);
    renderLogs();
  }

  function getConfiguredConcurrency() {
    const input = document.querySelector("#mfsConcurrency");
    const value = Number(input?.value || core.SETTINGS.defaultConcurrency);
    return Math.max(1, Math.min(8, Number.isFinite(value) ? Math.round(value) : core.SETTINGS.defaultConcurrency));
  }

  async function runExclusive(status, task) {
    if (isRunning) {
      addLog("Ja existe um scraping em curso.");
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    resetStats(status);
    try {
      const result = await task();
      if (result) {
        lastResult = result;
        window.__MOODLE_FORUM_QA_SCRAPER__ = lastResult;
      }
      addLog("Scraping concluido");
    } catch (error) {
      state.status = "Erro";
      state.errors += 1;
      renderProgress();
      addLog(error instanceof Error ? error.message : String(error));
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
    }
  }

  function scrapeForum() {
    return runExclusive("A iniciar scraping do forum", () =>
      core.scrapeForum({
        concurrency: getConfiguredConcurrency(),
        onProgress: updateState,
        onLog: addLog,
      })
    );
  }

  function scrapeCurrentDiscussion() {
    return runExclusive("A iniciar scraping da discussao", () =>
      core.scrapeCurrentDiscussion({
        onProgress: updateState,
        onLog: addLog,
      })
    );
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
      `${core.safeBaseName(lastResult.forum)}.json`,
      "application/json;charset=utf-8"
    );
    addLog("JSON descarregado");
  }

  function downloadMarkdown() {
    if (!lastResult) {
      addLog("Sem dados para descarregar.");
      return;
    }

    downloadText(core.toMarkdown(lastResult), `${core.safeBaseName(lastResult.forum)}.md`, "text/markdown;charset=utf-8");
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
        area.className = "mfs-hidden-copy";
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

  function createButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mfs-button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function createUi() {
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
      createButton("Scrape forum", scrapeForum),
      createButton("Scrape current discussion", scrapeCurrentDiscussion),
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
    concurrency.value = String(core.SETTINGS.defaultConcurrency);
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

    if (core.getPageType() === "forum") {
      addLog("Pagina de forum detetada.");
    } else if (core.getPageType() === "discussion") {
      addLog("Pagina de discussao detetada.");
    }

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
