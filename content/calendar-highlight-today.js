productivityModules.register("calendar-highlight-today", () => {
  const marker = "data-productivity-calendar-today";
  let active = true;
  let highlighted = null;
  let originalBorder = "";
  let originalPriority = "";

  function clearHighlight() {
    if (!highlighted) return;
    if (originalBorder) highlighted.style.setProperty("border", originalBorder, originalPriority);
    else highlighted.style.removeProperty("border");
    highlighted.removeAttribute(marker);
    highlighted = null;
  }

  function highlightToday() {
    const now = new Date();
    const dateKey = (now.getFullYear() - 1970) * 512 + (now.getMonth() + 1) * 32 + now.getDate();
    const today = document.querySelector(`.MGaLHf[data-datekey="${dateKey}"]`);
    if (today === highlighted) return;
    clearHighlight();
    if (!today) return;
    highlighted = today;
    originalBorder = today.style.getPropertyValue("border");
    originalPriority = today.style.getPropertyPriority("border");
    today.style.setProperty("border", "2px solid red", "important");
    today.setAttribute(marker, "");
  }

  let queued = false;
  function queueHighlight() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (active) highlightToday();
    });
  }

  const observer = new MutationObserver(queueHighlight);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const interval = setInterval(queueHighlight, 60 * 1000);
  queueHighlight();

  return () => {
    active = false;
    observer.disconnect();
    clearInterval(interval);
    clearHighlight();
  };
});
