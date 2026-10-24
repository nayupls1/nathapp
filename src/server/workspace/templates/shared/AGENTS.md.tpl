# {{name}}

This app runs inside gApp, which starts it and shows it in a live preview.

- **Commands** are in `gapp.json`: gApp installs dependencies, runs `dev` while you work (it reloads on changes) and `build` + `start` when the user is done. Don't start servers yourself; use gApp's `restart_app` tool after changing dependencies or gapp.json.
- **Environment** (set by gApp): `PORT` (listen on 127.0.0.1:$PORT), `DATABASE_PATH` (SQLite file; also as `DATABASE_URL=file:…`), `NODE_ENV`.
- **Design tokens** live in `src/tokens.css` (colors, radii, fonts, spacing as CSS variables). Style everything with them so the app matches the user's theme.
- **Realtime**: after writing data, call `realtime.publish(topic)` on the server; clients `subscribe(topic, fn)` from `src/live.ts`.
- **AI**: `src/ai.ts` lets the server ask a model (`ai.chat`, `ai.json`, `ai.stream`). gApp answers with the user's own AI subscription, so there are no API keys. Server-side only: never expose `GAPP_AI_TOKEN` to the browser; the frontend calls the app's own API. Requests count against a daily limit, so don't call AI in loops or on every page load, and cache results in the database where it makes sense. Handle `AiError` (e.g. 403 when the user turned AI off, 429 at the limit) with a friendly message.
- **Secrets** (API keys, passwords) come from gApp as environment variables: read `process.env.NAME` on the server only. Never hardcode them, write them to files, log them or send them to the browser. Missing ones are requested with gApp's `request_secret` tool.
