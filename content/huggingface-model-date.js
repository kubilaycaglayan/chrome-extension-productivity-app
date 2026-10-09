productivityModules.register("huggingface-model-date", () => {
  let active = true;
  let currentModel = "";
  let requestVersion = 0;
  let pending = "";
  const dates = new Map();
  const marker = "data-productivity-model-upload-date";

  function modelFromUrl() {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return null;
    const [, owner, model] = match;
    return { owner, model, id: `${owner}/${model}` };
  }

  function showDate({ createdAt, lastModified }) {
    const heading = document.querySelector("main h1, article h1, h1");
    if (!heading || heading.querySelector(`[${marker}]`)) return;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return;
    const label = document.createElement("span");
    label.setAttribute(marker, "");
    const formatDate = value => new Date(value).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });
    label.textContent = ` · Uploaded ${formatDate(createdAt)}`;
    if (lastModified && !Number.isNaN(new Date(lastModified).getTime())) {
      label.textContent += ` · Updated ${formatDate(lastModified)}`;
    }
    label.title = "Hugging Face repository upload and last update dates";
    Object.assign(label.style, {
      display: "inline-block", verticalAlign: "middle", fontWeight: "normal",
      fontSize: "0.7em", color: "var(--fgColor-muted, #71717a)"
    });
    heading.appendChild(label);
  }

  async function update() {
    if (!active) return;
    const target = modelFromUrl();
    const id = target?.id || "";
    if (id !== currentModel) {
      currentModel = id;
      requestVersion++;
      document.querySelectorAll(`[${marker}]`).forEach(node => node.remove());
    }
    if (!target) return;
    if (dates.has(id)) {
      showDate(dates.get(id));
      return;
    }
    if (pending === id) return;
    pending = id;
    const version = requestVersion;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "huggingface-model-created-at", owner: target.owner, model: target.model
      });
      if (result?.error) throw new Error(result.error);
      if (!result?.createdAt) throw new Error("Missing upload date");
      dates.set(id, { createdAt: result.createdAt, lastModified: result.lastModified });
      if (active && version === requestVersion) showDate(dates.get(id));
    } catch (error) {
      console.warn("[Hugging Face Model Date]", error);
    } finally {
      if (pending === id) pending = "";
      if (active && currentModel === id && dates.has(id)) queueUpdate();
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
