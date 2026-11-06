productivityModules.register("github-creation-date", () => {
  let active = true;
  let currentRepo = "";
  let requestVersion = 0;
  let pending = "";
  const dates = new Map();
  const marker = "data-productivity-repo-creation-date";
  const commitsMarker = "data-productivity-base-commits";
  const sidebarMarker = "data-productivity-github-sidebar";
  const sidebarRequest = "data-productivity-github-repositories";

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

  // The branch a pull request merges into, read from its header ("merge into <base> from
  // <head>"). The base is the first branch name linking into this repository; a fork's
  // head branch links into the fork instead.
  function baseBranch(owner, repo) {
    const prefix = `/${owner}/${repo}/tree/`;
    const link = [...document.querySelectorAll('a[data-component="BranchName"]')].find(node =>
      node.pathname.startsWith(prefix)
    );
    return link ? link.pathname.slice(prefix.length) : "";
  }

  // A pull request's tab bar gains a link to the history of the branch it targets. It is
  // cloned from the PR's own Commits tab so it keeps GitHub's styling, and is dropped
  // again as soon as the page is no longer that pull request or its target changes.
  function showBaseCommitsLink() {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const branch = match ? baseBranch(match[1], match[2]) : "";
    const href = branch ? `/${match[1]}/${match[2]}/commits/${branch}/` : "";
    document.querySelectorAll(`[${commitsMarker}]`).forEach(node => {
      if (node.getAttribute("href") !== href || !node.parentElement?.closest("nav")) node.remove();
    });
    if (!href || document.querySelector(`[${commitsMarker}]`)) return;
    const commitsPath = `/${match[1]}/${match[2]}/pull/${match[3]}/commits`;
    const tab = [...document.querySelectorAll("nav a[href]")].find(node =>
      node.pathname === commitsPath
    );
    if (!tab) return;
    const link = tab.cloneNode(true);
    link.setAttribute(commitsMarker, "");
    link.removeAttribute("id");
    link.removeAttribute("aria-current");
    link.removeAttribute("data-discover");
    [...link.classList].filter(name => /selected/i.test(name)).forEach(name => link.classList.remove(name));
    link.href = href;
    link.title = `Commits on ${decodeURIComponent(branch)}, the branch this pull request targets`;
    link.querySelectorAll("span").forEach(node => node.remove());
    for (const node of [...link.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
    link.append(`${decodeURIComponent(branch)} commits`);
    tab.parentElement.appendChild(link);
  }

  function addSidebarShortcuts() {
    const login = document.querySelector('meta[name="user-login"]')?.content;
    if (!login || !/^[\w-]+$/.test(login)) return;
    const home = location.pathname === "/" || location.pathname.startsWith("/dashboard");
    const targets = [...document.querySelectorAll("h2, h3")];
    const feed = [...document.querySelectorAll('a[href="/dashboard"], a[href="/dashboard-feed"], nav a[href]')]
      .find(node => /^feed$/i.test(node.textContent.trim()) || /^feed$/i.test(node.getAttribute("aria-label") || ""));
    if (feed?.parentElement && !document.querySelector(`[${sidebarMarker}]`)) {
      const links = document.createElement("div");
      links.setAttribute(sidebarMarker, "");
      Object.assign(links.style, { display: "flex", flexDirection: "column", gap: "8px", margin: "8px 0" });
      for (const [label, href] of [["Repositories", `/${login}?tab=repositories`], ["My profile", `/${login}`]]) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        Object.assign(link.style, { color: "var(--fgColor-default)", fontSize: "14px", fontWeight: "600", textDecoration: "none" });
        links.appendChild(link);
      }
      feed.parentElement.insertAdjacentElement("afterend", links);
    }
    if (!home) return;
    const topHeading = targets.find(node => node.textContent.trim() === "Top repositories");
    const topSection = topHeading?.parentElement?.parentElement;
    if (!topSection) return;
    let list = topSection.parentElement?.querySelector(`[${sidebarRequest}]`);
    if (!list) {
      const panel = document.createElement("section");
      panel.setAttribute(sidebarRequest, "");
      Object.assign(panel.style, { marginBottom: "16px", fontSize: "12px" });
      const title = document.createElement("h2");
      title.textContent = "Recently updated";
      Object.assign(title.style, { fontSize: "12px", fontWeight: "600", margin: "0 0 8px" });
      list = document.createElement("div");
      list.setAttribute("data-productivity-github-repository-list", "");
      Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "6px" });
      panel.append(title, list);
      topSection.parentElement.insertBefore(panel, topSection);
    } else {
      list = list.querySelector('[data-productivity-github-repository-list]');
    }
    if (!list) return;
    if (list.dataset.loaded || list.dataset.loading) return;
    list.dataset.loading = "true";
    chrome.runtime.sendMessage({ type: "github-recent-repositories", login }).then(result => {
      if (!active || !list.isConnected) return;
      delete list.dataset.loading;
      if (!Array.isArray(result?.repositories)) return;
      list.dataset.loaded = "true";
      for (const repo of result.repositories.slice(0, 10)) {
        const link = document.createElement("a");
        link.href = `/${repo.full_name}`;
        link.textContent = repo.name;
        link.title = `${repo.full_name} · Updated ${new Date(repo.updated_at).toLocaleDateString()}`;
        Object.assign(link.style, { color: "var(--fgColor-muted)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        list.appendChild(link);
      }
    }).catch(() => { delete list.dataset.loading; });
  }

  async function update() {
    if (!active) return;
    showBaseCommitsLink();
    addSidebarShortcuts();
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
    document.querySelectorAll(`[${marker}], [${commitsMarker}], [${sidebarMarker}]`).forEach(node => node.remove());
  };
});
