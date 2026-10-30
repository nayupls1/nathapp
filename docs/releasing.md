# Releasing

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

## Versions and channels

Versions follow [SemVer](https://semver.org), starting at 0.1.0; before 1.0
anything may change between minor versions. The version lives in
`package.json`, and every release is a tag `v<version>` on `master`.

- **Stable:** `0.2.0`. Everyone gets it.
- **Pre-release:** `0.2.0-beta.1` (or `-alpha.N`, `-rc.N`). Published as a
  GitHub pre-release; only copies on the **Beta** channel (Settings → About)
  get it.

## Cutting a release

```sh
bun run release 0.2.0     # bumps package.json on release/v0.2.0 and opens its PR
# …CI passes, merge the PR…
git switch master && git pull
bun run release           # tags master as v0.2.0 and pushes the tag
```

Pushing the tag starts the **Release** workflow (`.github/workflows/release.yml`):

1. **Draft:** checks that the tag matches `package.json` and creates a draft
   release with GitHub's generated notes: "What's Changed" (the merged pull
   requests since the last release) and the "Full Changelog" compare link.
2. **Checks:** the whole CI workflow (typecheck, unit tests, build, e2e) on
   Linux, Windows and macOS.
3. **Build:** on each OS, `bun run build` and electron-builder, which uploads
   the installers into the draft, with the update feeds the app reads
   (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`, or `beta*.yml` for
   pre-releases) and their blockmaps.
4. **Publish:** adds `SHA256SUMS.txt` and publishes the draft.

Nothing is published unless every step passed. A failed run leaves a draft
release and the tag behind: fix the problem, delete both
(`gh release delete v0.2.0 --cleanup-tag`), and release again (with a new
version if the fix needs a PR).

The notes are only as good as the pull request titles: they're the list.

## What a release contains

| OS      | Files                                                                        | Updates itself                                                                                |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Linux   | `rune-browser-<v>-linux-x86_64.AppImage`, `rune-browser-<v>-linux-amd64.deb` | yes (the AppImage replaces itself; the deb asks for your password to install the new package) |
| Windows | `rune-browser-<v>-setup-x64.exe` (NSIS, per-user)                            | yes                                                                                           |
| macOS   | `rune-browser-<v>-mac-arm64.dmg` and `.zip` (Apple Silicon)                  | no: it shows the new version and links to its release                                         |

macOS is supported but not tested by hand (CI runs the checks there, without
blocking on them).

## Updates

`src/main/updates.ts` uses [electron-updater](https://www.electron.build/auto-update)
with the GitHub releases as the feed. Installed copies check 15 seconds after
starting and every 4 hours, download a newer release in the background and
install it when the app quits; Settings → About shows the state, "Check for
updates" and "Restart to update", and a notice appears once an update is ready.
Runs from source (`bun run dev`, `bun run start`) never update.

## Signing

Releases aren't signed yet (tracked as NAT-89):

- **Windows** shows a SmartScreen warning on install ("More info" → "Run anyway").
- **macOS** builds are ad-hoc signed: the first start needs right-click → Open
  (or System Settings → Privacy & Security → "Open anyway"), and they can't
  update themselves.
- **Linux** needs no signing; check downloads against `SHA256SUMS.txt`.

Once certificates exist, they go into the repository's Actions secrets
(`CSC_LINK`/`CSC_KEY_PASSWORD` for macOS with `APPLE_ID`… for notarization,
or Azure Trusted Signing for Windows) and the build step stops setting
`CSC_IDENTITY_AUTO_DISCOVERY=false`.
