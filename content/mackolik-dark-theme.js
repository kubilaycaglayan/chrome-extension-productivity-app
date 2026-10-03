// Site-wide dark theme for arsiv.mackolik.com.
//
// The rules come from content/mackolik-dark-theme-rules.js, which is generated
// from the site's own stylesheets -- see tools/build-mackolik-dark-theme.mjs.
// Injected at document_start so the page never paints white first.
productivityModules.register("mackolik-dark-theme", () => {
  const style = document.createElement("style");
  style.id = "productivity-mackolik-dark-theme";
  style.textContent = mackolikDarkThemeRules;
  // Our declarations and the site's are both !important, so ties are broken by
  // document order -- and Canli-Sonuclar loads LiveScore.css a second time from
  // inside <body>, which puts it after anything in <head>. Sitting as the last
  // child of <html>, past </body>, is the only position that always wins.
  const root = document.documentElement;
  root.appendChild(style);
  const observer = new MutationObserver(() => {
    if (style.parentNode !== root || root.lastElementChild !== style) root.appendChild(style);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    style.remove();
  };
});
