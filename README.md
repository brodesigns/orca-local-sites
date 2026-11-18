# Local Sites for Orca

One-click local preview for your web projects. A sidebar panel lists every web project in your Orca workspaces and detects its type automatically. Click **Start** and the dev server runs in a visible Orca terminal, so you see its logs and errors live. When the server answers, **Open in browser** opens it in your default browser.

Made by [BroDesigns](https://brodesigns.de).

## Features

- Detects the project type from `package.json`: Next.js, Nuxt, Astro, SvelteKit, Remix / React Router, Gatsby, Angular, Create React App, Vite. It needs a `dev`, `develop` or `start` script.
- Also serves PHP projects (`php -S`, `public/` is used as document root when it has an `index.php`) and static sites with an `index.html` (`python3 -m http.server`)
- **WordPress plugins and themes:** detects the plugin or theme header and starts a local WordPress with [WordPress Playground](https://wordpress.github.io/wordpress-playground/) (`npx @wp-playground/cli`, pinned version, no Docker, no MySQL). Your plugin or theme is mounted and you are logged in automatically. If it needs other plugins (`Requires Plugins:` header, or WooCommerce used in the code), they are installed from wordpress.org through a generated blueprint in the system temp folder. Data lives in memory and is gone after stopping.
- **Confirm before start** (on by default, can be switched off in the panel or in Orca's settings): a click on Start first shows the exact command and the port. You can change the port, then confirm. (For WordPress, the name of the private temp folder in the command is only a placeholder, it is created at the start.)
- **Ports in use** at the top of the panel: the listening TCP ports (1024 and up) of servers that belong to Orca, meaning servers this plugin started and web runtimes (node, bun, deno, Python, PHP, Ruby and similar) running in the folder of a project that has a row in the list, for example a dev server you started by hand in an Orca terminal. That project's row then counts as running, as if it had been started here: it has **Open in browser** and **Stop**, and no Start button. Stop asks for confirmation first and ends the process with a normal stop signal (SIGTERM). Ports of other programs on your machine (databases, browsers, system services, tools in other folders) are not shown. Each entry names the program and the project, and ports started by this plugin are marked. 
- **Installs first when needed:** a fresh worktree without `node_modules` shows **Install & start**. The terminal runs the install and only then the dev server.
- **The project you are in is always on top**, marked "you are here". It follows the workspace you focus in Orca, so you see at once which session you are in. Favorites come next.
- **Favorites, hide, start all:** pin projects (they sort first), hide the ones you never start, **Start all** (one confirmation, lists the projects) and **Stop all** (only servers this plugin started).
- **Ready hint after an agent:** when an Orca agent finishes in a project that is not running, the row shows "Ready to view" with a Start button and you get a desktop notification. Optionally the server starts by itself (setting, off by default, skips the confirmation).
- **Notifications and status bar:** a desktop notification when a server stops unexpectedly, cannot start or shows new errors (at most one per project and kind per minute). The status bar item shows how many servers run, red when one has errors.
- **Fix with agent:** next to the errors, one button starts an Orca agent (Claude Code by default, choose in the settings) in the project's workspace with the errors as its task. The error text comes from your dev server output and is quoted as data in the prompt.
- **Open in browser when ready** (setting, off by default): tries to open the browser as soon as a server you started from the panel is ready. Orca only lets plugins open a browser right after a click, so it may fall back to a hint "ready, click Open in browser".
- Picks the package manager from the lockfile (pnpm, npm, yarn, bun)
- Starts the dev script in an Orca terminal and passes the port the way the framework expects it (`PORT=` or `--port`), with a stable port per project (range 3200 to 3899) so the URL stays the same
- Shows status (starting, running, failed) and the **errors** from the dev server output, not the whole terminal: prompts, request lines and hydration diffs are left out, errors keep a little context (file, stack), and they disappear once a later compile succeeds. The raw terminal output is one click away.
- Never starts a project twice, reports `EADDRINUSE` and similar start errors. **Stop** closes the terminal it opened, which ends the server. A server only counts as running when it really answers (WordPress: after it printed `Ready!`).
- Takes over servers it started before Orca or the plugin restarted
- **Open in browser** uses your system default browser. To use Chrome, set Chrome as the default browser in macOS.

## Why "Full access"?

Orca labels every plugin with a worker this way. This plugin:

- reads your workspace list, the output of the terminals it opened and the status of your agents (to know when one finished)
- can end a dev server that runs in one of your project folders but was not started by this plugin (**Stop** on a server marked "started outside this plugin"). It asks first, sends SIGTERM only, and checks right before that the process still is the same web runtime on that port in that project. It never ends anything else, and never uses SIGKILL.
- starts an agent only when you press **Fix with agent** (or, if you switched it on, starts a server after an agent finished), and shows desktop notifications
- runs the system tool `lsof` (fixed arguments, 5 s timeout) to find listening ports and the working folder of each program. Only ports that belong to Orca projects are passed on to the panel. `lsof` itself only reads.
- opens a terminal, types one command into it (for example `PORT=… pnpm dev` or `pnpm dev --port …`) and closes that terminal again on Stop or restart
- reads `package.json` (up to 1 MB), the first 8 KB of `style.css` and of the top-level PHP files, up to 64 KB of the main plugin file and of a theme's `functions.php` (to spot WooCommerce), and checks whether a few files such as lockfiles or `index.html` exist, in your local workspaces. It never follows symlinks or reads anything else.
- in WordPress mode starts `npx` from a private empty temp folder (random name, mode 0700) and only mounts your project, so a project cannot bring its own `npx` package or `.npmrc`. The blueprint lies in that folder and is deleted after the run.
- makes no network requests itself and collects nothing, it only checks `localhost` ports. The commands it types into the terminal may download things: your package manager as usual, and in WordPress mode `npx` fetches the pinned `@wp-playground/cli` package and WordPress on the first start
- opens only an `http://localhost:<port>` URL, after your click (Orca asks once for `localhost`). The port is the one it chose or the one the server announces in its output, so a script that starts a second service can make it show that port.
- needs the `workspace:write` access only to show the dev terminal (**Terminal** button). Orca bundles more under that label than the plugin uses.
- starting a project runs that project's own dev script (or, for static sites, Python in isolated mode). Only start projects you trust.
- PHP and static servers (`php -S`, `python3 -I -m http.server`) serve the project folder on `127.0.0.1` while they run, like any such server. Stop them when you do not need them.

Tested on macOS. Linux should work, Windows is not supported (paths and shell commands). Needs Orca 1.4.259 or newer. The ports list needs `lsof` (included in macOS, usually in Linux).

## Install

Orca, Settings, Plugins, add a marketplace or install from this repository, check the access, approve.

## Development

```bash
orca plugin test .
orca plugin check .
orca plugin dev load .   # then --approve <fingerprint>
```

## License

MIT
