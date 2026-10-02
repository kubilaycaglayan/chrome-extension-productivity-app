productivityModules.register("scrollbar-width", () => {
  const STYLE_ID = "productivity-scrollbar-width";

  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Make Chromium's scrollbars easier to grab with a mouse. */
    *, *::before, *::after {
      scrollbar-width: auto;
    }

    ::-webkit-scrollbar {
      width: 16px !important;
      height: 16px !important;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background-color: rgba(100, 100, 100, 0.65);
      border: 4px solid transparent;
      border-radius: 999px;
      background-clip: padding-box;
    }

    ::-webkit-scrollbar-thumb:hover {
      background-color: rgba(80, 80, 80, 0.85);
    }

    @media (prefers-color-scheme: dark) {
      ::-webkit-scrollbar-thumb {
        background-color: rgba(180, 180, 180, 0.65);
      }

      ::-webkit-scrollbar-thumb:hover {
        background-color: rgba(210, 210, 210, 0.85);
      }
    }
  `;

  (document.head || document.documentElement).appendChild(style);
  return () => style.remove();
});
