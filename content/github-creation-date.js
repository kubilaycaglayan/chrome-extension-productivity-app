productivityModules.register("github-creation-date", () => {
  let active = true;
  let currentRepo = "";
  let requestVersion = 0;
  let pending = "";
  const dates = new Map();
  const marker = "data-productivity-repo-creation-date";
  const commitsMarker = "data-productivity-base-commits";

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

  async function update() {
    if (!active) return;
    showBaseCommitsLink();
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
    document.querySelectorAll(`[${marker}], [${commitsMarker}]`).forEach(node => node.remove());
  };
});
