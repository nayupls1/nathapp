# gApp

Desktop app built with **Electron** + **SolidJS**, backed by a local **Bun** server.

Bun is used everywhere it can be: package manager, script runner, bundler for the
Electron main/preload scripts, and runtime for the backend server. The only thing
not running on Bun is Electron itself (it ships its own Node runtime).

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
bun run dev
```

## Scripts

| Command             | What it does                                                                           |
| ------------------- | -------------------------------------------------------------------------------------- |
| `bun run dev`       | Vite dev server (HMR) + Electron. Server hot-reloads, main/preload changes restart Electron. |
| `bun run build`     | Production build into `dist/` (renderer, main/preload, compiled server binary).         |
| `bun run start`     | Runs the production build (unpackaged).                                                 |
| `bun run package`   | Builds and packages a distributable into `release/` via electron-builder.              |
| `bun run server`    | Runs only the Bun server standalone (port 3000), with watch mode.                       |
| `bun run typecheck` | Type-checks the whole project.                                                          |

## How it fits together

```
src/
  main/       Electron main process: starts the server, creates the window
  preload/    Exposes `window.gapp` (server URL, versions) to the renderer
  renderer/   SolidJS UI (Vite)
  server/     Bun HTTP server (Bun.serve)
  shared/     Types shared by all of the above
scripts/      Bun scripts for dev / build / start
```

On startup the main process picks a free port and spawns the server as a child
process, waits for `/api/health`, then opens the window and passes the server URL
to the renderer through the preload script. When the app quits, the server is
stopped (and it also exits on its own if the app dies unexpectedly).

- **Dev:** the server runs from source with `bun --watch`.
- **Production:** the server is compiled with `bun build --compile` into a
  standalone executable shipped as an extra resource, so users don't need Bun
  installed.

In production the renderer is served from a custom `app://` protocol (instead of
`file://`) so it has a proper origin; the server only allows CORS requests from
the renderer's origin.
