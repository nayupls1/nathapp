# {{name}}

This app runs inside NathApp, which starts it and shows it in a live preview.

- **Commands** are in `nathapp.json`: NathApp installs dependencies, runs `dev` while you work (it reloads on changes) and `build` + `start` when the user is done. Don't start servers yourself; use NathApp's `restart_app` tool after changing dependencies or nathapp.json.
- **Environment** (set by NathApp): `PORT` (listen on 127.0.0.1:$PORT), `DATABASE_PATH` (SQLite file; also as `DATABASE_URL=file:…`), `NODE_ENV`.
- **Design tokens** live in `src/tokens.css` (colors, radii, fonts, spacing as CSS variables). Style everything with them so the app matches the user's theme.
- **Realtime**: after writing data, call `realtime.publish(topic)` on the server; clients `subscribe(topic, fn)` from `src/live.ts`.
- **AI**: `src/ai.ts` lets the server ask a model (`ai.chat`, `ai.json`, `ai.stream`). NathApp answers with the user's own AI subscription, so there are no API keys. Server-side only: never expose `NATHAPP_AI_TOKEN` to the browser; the frontend calls the app's own API. Requests count against a daily limit, so don't call AI in loops or on every page load, and cache results in the database where it makes sense. Handle `AiError` (e.g. 403 when the user turned AI off, 429 at the limit) with a friendly message.
- **Command bar actions**: list the app's main tasks in `nathapp.json` `"actions"` so the user can run them from NathApp's command bar (Ctrl+K). `{ "id", "title", "input"?, "endpoint" }` actions get a POST with JSON `{ input }` and answer JSON `{ message }`; `{ "id", "title", "path" }` actions open the app at that page.
- **Secrets** (API keys, passwords) come from NathApp as environment variables: read `process.env.NAME` on the server only. Never hardcode them, write them to files, log them or send them to the browser. Missing ones are requested with NathApp's `request_secret` tool.
