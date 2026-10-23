# {{name}}

This app runs inside gApp, which starts it and shows it in a live preview.

- **Commands** are in `gapp.json`: gApp installs dependencies, runs `dev` while you work (it reloads on changes) and `build` + `start` when the user is done. Don't start servers yourself; use gApp's `restart_app` tool after changing dependencies or gapp.json.
- **Environment** (set by gApp): `PORT` (listen on 127.0.0.1:$PORT), `DATABASE_PATH` (SQLite file; also as `DATABASE_URL=file:…`), `NODE_ENV`.
- **Design tokens** live in `src/tokens.css` (colors, radii, fonts, spacing as CSS variables). Style everything with them so the app matches the user's theme.
- **Realtime**: after writing data, call `realtime.publish(topic)` on the server; clients `subscribe(topic, fn)` from `src/live.ts`.
