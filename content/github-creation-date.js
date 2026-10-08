productivityModules.register("github-creation-date", () => {
  let active = true;
  let currentRepo = "";
  let requestVersion = 0;
  let pending = "";
  const dates = new Map();
  const marker = "data-productivity-repo-creation-date";

  function repoFromUrl() {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    const [, owner, repo] = match;
    if (["settings", "issues", "pulls", "actions", "projects", "wiki", "security", "pulse", "graphs", "network", "commits"].includes(repo)) return null;
    return { owner, repo, id: `${owner}/${repo}` };
  }

  function showDate(createdAt) {
    const headings = [...document.querySelectorAll("h2")].filter(node =>
      node.textContent.trim() === "About"
    );
    for (const heading of headings) {
      if (heading.querySelector(`[${marker}]`)) continue;
      const span = document.createElement("span");
      span.setAttribute(marker, "");
      span.textContent = ` · Created ${new Date(createdAt).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric"
      })}`;
      Object.assign(span.style, {
        fontWeight: "normal", fontSize: "0.8em", color: "var(--fgColor-muted)"
      });
      heading.appendChild(span);
    }
  }

  async function update() {
    if (!active) return;
    const target = repoFromUrl();
    const id = target?.id || "";
    if (id !== currentRepo) {
      currentRepo = id;
      requestVersion++;
      document.querySelectorAll(`[${marker}]`).forEach(node => node.remove());
    }
    if (!target) return;
    if (dates.has(id)) {
      showDate(dates.get(id));
      return;
    }
    // One request per repository navigation, even when GitHub rerenders the page.
    if (pending === id) return;
    pending = id;
    const version = requestVersion;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "github-repository-created-at", owner: target.owner, repo: target.repo
      });
      if (result?.error) throw new Error(result.error);
      if (!result?.createdAt) throw new Error("Missing creation date");
      dates.set(id, result.createdAt);
      if (active && version === requestVersion) showDate(result.createdAt);
    } catch (error) {
      console.warn("[GitHub Creation Date]", error);
    } finally {
      if (pending === id) pending = "";
      if (active && currentRepo === id && dates.has(id)) queueUpdate();
    }
  }

  let queued = false;
  function queueUpdate() {
    if (queued || !active) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  }

  const observer = new MutationObserver(queueUpdate);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", queueUpdate);
  document.addEventListener("turbo:load", queueUpdate);
  queueUpdate();

  return () => {
    active = false;
    requestVersion++;
    observer.disconnect();
    window.removeEventListener("popstate", queueUpdate);
    document.removeEventListener("turbo:load", queueUpdate);
    document.querySelectorAll(`[${marker}]`).forEach(node => node.remove());
  };
});
