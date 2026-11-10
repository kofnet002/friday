# Packaged App Startup and Updates Design

## Intent

Make Friday launch from its installed Mac app without a development server, fix the packaged backend startup failure, and let signed app installs receive updates published through GitHub Releases. Provide a local command to rebuild the DMG from current source.

## Goals

- Bundle the backend runtime dependencies so the packaged backend starts and passes its health check.
- Start the bundled backend and web server when Friday.app opens, independent of `pnpm run dev`.
- Check GitHub Releases for app updates, download available updates, and ask the user to restart to install.
- Keep a manual local build command that regenerates the ARM64 DMG and updater ZIP from the current checkout.
- Provide a release command that uploads the signed DMG, ZIP, and update metadata to GitHub Releases.

## Non-goals

- Publish a release as part of this code change.
- Ship or store Apple signing credentials in the repository.
- Migrate the current unsigned DMG install in place. Users must install the first signed release manually before automatic updates can work.
- Automatically rewrite a DMG already copied to Desktop. A build creates a new DMG artifact; installed app updates are downloaded from GitHub Releases.

## Approaches

1. **GitHub Releases with `electron-updater` (selected):** the app checks GitHub Releases, downloads a signed update, and prompts for restart. The local build command regenerates the DMG and ZIP; the release command publishes artifacts. This gives the requested in-app flow and explicit manual release controls, with Apple Developer ID signing and notarization required for distributable updates.
2. **Local DMG rebuild only:** regenerate the DMG on demand and reinstall manually. This needs no release host or Apple signing setup but does not provide automatic app updates.

## Design

The PyInstaller build will include the backend's runtime packages from the project environment and validate its collected runtime imports. The packaged service supervisor will continue launching backend and web services on app startup and stopping them at quit. A packaged-only updater module will use `electron-updater` and the `kofnet002/friday` GitHub Releases provider; it will report update availability/download progress to the main process and request restart confirmation before installation. Development builds will not contact GitHub.

Electron Builder will generate the ARM64 DMG and ZIP needed by the macOS updater. `pnpm --filter @friday/desktop dist` will rebuild artifacts locally, while a separate publish command will publish versioned signed artifacts to GitHub Releases using `GH_TOKEN` and the maintainer's external Apple signing/notarization credentials. README instructions will identify the one-time manual transition from the current unsigned DMG and required secrets.

## Constraints and open setup requirements

- The app is Apple Silicon ARM64 only.
- Auto-update payloads must be signed with the same Apple Developer Team as the installed app and distributed with a valid Developer ID signature; notarization is required for friction-free macOS distribution.
- Release version must increase for every published update.
- GitHub Releases must be reachable by the installed app. If the repository is private, access-token delivery must be designed separately; a token must not be embedded in the app.
- Redis stays optional and external. API provider keys remain in the per-user `.env` file.
- The current unsigned DMG cannot receive the first signed update; users install the first signed release manually.

## Acceptance checks

- Built backend executable imports `uvicorn`, serves `/healthz`, and returns readiness in a packaged-bundle smoke test.
- Opening the packaged app starts backend and web services without `pnpm run dev`; exiting stops both.
- Development mode never performs update checks.
- Packaged builds use the GitHub Releases provider and display available/downloaded update state; install happens only after restart confirmation.
- Local package command produces both `.dmg` and `.zip` artifacts.
- Release command requires a versioned build and `GH_TOKEN`; release documentation lists the Apple signing/notarization credentials needed for updatable macOS packages.
