// Site-wide dark theme for arsiv.mackolik.com.
//
// The rules come from content/mackolik-dark-theme-rules.js, which is generated
// from the site's own stylesheets -- see tools/build-mackolik-dark-theme.mjs.
// Injected at document_start so the page never paints white first.
productivityModules.register("mackolik-dark-theme", () => {
  const style = document.createElement("style");
  style.id = "productivity-mackolik-dark-theme";
  style.textContent = `${mackolikDarkThemeRules}

/* The site's datepicker uses light jQuery UI day tiles. */
#ui-datepicker-div {
  background: #101820 !important;
  border-color: #34424c !important;
  color: #e5edf6 !important;
}
#ui-datepicker-div .ui-datepicker-header {
  background: #172633 !important;
  background-image: none !important;
  border-color: #34424c !important;
}
#ui-datepicker-div .ui-datepicker-title select {
  background: #1b2934 !important;
  color: #e5edf6 !important;
  border-color: #465664 !important;
}
#ui-datepicker-div .ui-datepicker-calendar,
#ui-datepicker-div .ui-datepicker-calendar thead,
#ui-datepicker-div .ui-datepicker-calendar tbody,
#ui-datepicker-div .ui-datepicker-calendar th,
#ui-datepicker-div .ui-datepicker-calendar td {
  background: #101820 !important;
  background-image: none !important;
  color: #e5edf6 !important;
}
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-default {
  background: #1b2a36 !important;
  background-image: none !important;
  border-color: #344957 !important;
  color: #c8def5 !important;
}
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-default:hover,
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-hover,
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-focus {
  background: #29465b !important;
  background-image: none !important;
  border-color: #5d8197 !important;
  color: #ffffff !important;
}
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-highlight {
  background: #324456 !important;
  background-image: none !important;
  border-color: #6a8da5 !important;
  color: #ffffff !important;
}
#ui-datepicker-div .ui-datepicker-calendar td .ui-state-active {
  background: #51421d !important;
  background-image: none !important;
  border-color: #b39239 !important;
  color: #ffe49a !important;
}
#ui-datepicker-div .ui-datepicker-calendar .ui-datepicker-other-month .ui-state-default {
  background: #17212a !important;
  color: #8396a9 !important;
}`;
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
