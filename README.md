# Productivity — a Chrome extension

One extension that does what would otherwise take a dozen small ones: it blocks ads,
replaces the new tab page, shows CSV files as tables, lets you jump back to your last
tab, and fixes a handful of sites it gets used on.

Each feature is a module you can switch on or off from the toolbar popup. Everything
runs locally. Nothing is sent anywhere, apart from the few requests a feature clearly
needs, such as search suggestions on the new tab page.

## What's inside

### Everyday browsing

| Module | What it does |
| --- | --- |
| 🛡️ **Ad blocker** | Blocks ads and hides the empty space they leave. It's built on EasyList, and you can pause it on any site with one switch. |
| 🗂️ **New Tab page** | A search bar with Google suggestions, bookmark groups you can drag around, Chrome tab groups as chips, and Google or custom wallpapers. A column in the top right corner opens the inbox of each Google account you're signed into. In edit mode you can hide accounts or add your own inbox links. |
| 🔁 **Recent-tab switching** | Jumps between your two most recent tabs: <kbd>⌘⇧D</kbd> on Mac, <kbd>Ctrl+Shift+Tab</kbd> elsewhere. |
| 🏷️ **Tab markers** | Marks a tab with a coloured emoji from the right-click menu, so you can find it again. |
| 📑 **Page outline** | Shows a clickable outline of the headings on the current page in the popup. |
| 📊 **CSV viewer** | Opens CSV and TSV links as a sortable, filterable table instead of downloading them. |
| 🖍️ **Text highlights** | Select text and press <kbd>⌘⇧S</kbd> (<kbd>Ctrl+Shift+S</kbd>) to keep a yellow highlight on the page. |
| ↩️ **Code block wrapping** | Adds a small button to code blocks whose lines run off the edge, which wraps them onto the next line. *Off until you enable it.* |
| 🍪 **Cookie accepter** | Clicks "accept all" on cookie banners it recognises. *Off until you enable it*, because it accepts on your behalf. |

### Site-specific

| Module | What it does |
| --- | --- |
| 🎛️ **YouTube recommendations** | Adds a button to show or hide the recommendations column. |
| 🚫 **YouTube Shorts blocker** | Hides Shorts and sends Shorts pages back to Home. |
| 🛡️ **X keyword filter** | Hides posts on X / Twitter that contain phrases you've blocked. |
| 🐙 **GitHub** | Shows when a repository was created, next to its About heading, and adds a link to the target branch’s commits to pull request tabs. |
| 🤗 **Hugging Face model date** | Shows when a model was first uploaded, next to its title. |
| 📅 **Calendar: highlight today** | Outlines today's date in Google Calendar. |
| ↔️ **Wider scrollbars** | Makes Hugging Face scrollbars easier to grab. |
| 🌙 **Mackolik dark theme** / 🧹 **Mackolik cleanup** | A dark theme and a decluttered layout for arsiv.mackolik.com. |

## Install

The extension isn't on the Chrome Web Store, so you load it from this folder:

1. Clone the repo:
   ```sh
   git clone https://github.com/kubilaycaglayan/chrome-extension-productivity-app.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the cloned folder.
4. Pin the extension and click its icon to choose which modules you want.

After pulling new changes, press the reload icon on the extension's card in
`chrome://extensions`.

### Backups

The popup can export all your settings (enabled modules, paused sites, bookmark groups,
wallpaper, inbox links and so on) to a JSON file, and import them again later. The file
is personal: it includes things like the emails of accounts you've hidden.

## How it's put together

There's no build step and there are no runtime dependencies. It's plain JavaScript, HTML
and CSS, loaded straight by Chrome (Manifest V3).

```
manifest.json      what Chrome loads, and the permissions it asks for
background/        the service worker, which starts the background modules
modules/           background logic (ad blocker, tab history, Gmail accounts, …)
content/           scripts that run inside web pages, one per feature
newtab/            the New Tab page
popup/             the toolbar popup: module switches, outline, backups
shared/            settings and helpers used by more than one of the above
rules/             ad-blocking rules generated from EasyList
tests/             unit tests
tools/             checks that run in a real Chrome, plus the ad-rule builder
```

A content script registers itself as a module and only runs while its switch in the popup
is on. Turning a module off removes what it added to the page.

## Development

The unit tests need Node.js 20 or newer and nothing else:

```sh
for f in tests/*.test.cjs; do node "$f" || break; done
```

Some behaviour only exists in a real browser: layout, clicks, or how Google answers a
request. The scripts in `tools/check-*-live.*` cover that. They need Node.js 22+ and
Google Chrome installed, and they start a throwaway headless Chrome profile, so your own
profile is never touched:

```sh
node tools/check-mail-accounts-live.mjs
```

To regenerate the ad-blocking rules from the latest EasyList:

```sh
cd tools/ad-blocker-build && npm install && npm run build
```

### Personal lists

Two optional files seed lists that are personal and so not part of the repo. Both are
gitignored:

- `x-keywords.local.json`: phrases the X keyword filter starts out blocking
- `mackolik-teams.local.json`: teams Mackolik cleanup starts out highlighting

## Credits

The ad-blocking rules are generated from [EasyList](https://easylist.to/), which is
dual-licensed under GPLv3 and CC BY-SA 3.0. They're converted to Chrome's rule format
with [@adguard/dnr-converter](https://github.com/AdguardTeam/tsurlfilter).
