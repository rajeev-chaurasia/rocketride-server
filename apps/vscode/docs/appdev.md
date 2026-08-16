# App Builder (app development surface)

The VS Code extension hosts the **App Builder** — the surface for developing,
previewing, and deploying RocketRide apps. This page documents the contracts
that surface exposes; the runtime lives under `apps/vscode/src/appdev/` and
`apps/vscode/src/providers/AppScreenProvider.ts`.

## The `.rrapp` trigger (contentless marker)

`<folder>/<name>.rrapp` is a **contentless** trigger file. Double-clicking it
in the Explorer opens the App Builder, and VS Code uses it for tab identity.
It carries no data: everything about the app — `id`, `name`, and the
working-copy `projectId` — lives in one place, the folder's `package.json`
`appManifest` block.

- `projectId` is a client-side GUID that distinguishes one working copy
  (checkout, duplicate) of an app from another. It is never a server key —
  deploys record it only as `metadata.projectId` provenance.
- **Migration:** legacy markers that still carry `{ id, projectId }` JSON are
  migrated on first `ensure` — the `projectId` is adopted into the folder's
  `appManifest` and the marker is emptied.

## MY APPS sidebar (scan-only)

The App Builder sidebar's `apps` list is built **from the workspace scan
alone** — every row is a `.rrapp`-bound local working copy discovered under the
open workspace folders. It is not merged with the server `list_mine` catalog.
Discovery is driven by `.rrapp`/`package.json` file events and by
workspace-folder changes; there is no rescan on connect.

## Live preview overlay & dev servers

A local dev build is previewed by registering a per-user `moduleId → entry URL`
overlay (via `rrext_deploy_app.register_dev`) so the developer's shell points at
their locally built bundle. The extension manages the underlying rsbuild dev
servers through a serialized per-app operation chain (start/stop/restart run one
at a time). Closing a preview **lingers** the server for 60 s so a quick reopen
revives it instantly; a Reload or extension deactivation stops immediately.
Orphaned dev servers from a previous session are adopted rather than
double-spawned.

## `appdev:call` — the app-control message

The webview drives all app lifecycle actions through one correlated message:

```
{ type: 'appdev:call', id, appId, method, args?: unknown[] }
```

The host replies on the same `id`:

```
{ type: 'appdev:result', id, ok: true,  value }   // success
{ type: 'appdev:result', id, ok: false, error }   // failure (error is a string)
```

Registry-version arguments are validated as integers before any write (a
missing/non-numeric version is rejected, not sent as `null`).

| `method`          | args                          | returns |
| ----------------- | ----------------------------- | ------- |
| `listVersions`    | —                             | the version rail: one entry per registry version `{ registryVersion, appVersion, state, ... }` |
| `where`           | —                             | the audience pins currently serving the app `{ audience, version, ... }` |
| `deploy`          | `[sourceZipComment?]`         | packs the app SOURCE and deploys it (server builds it); returns the new rail entry |
| `submit`          | `[registryVersion]`           | flips the deployment `private → submit` (enters review) |
| `publish`         | `[registryVersion, target]`   | binds a version to an audience (`@me`/`@team`/`@public`) |
| `withdraw`        | `[registryVersion]`           | cancels a pending review (`submit → private`) |
| `unpublish`       | `[target]`                    | removes an audience binding (soft — republishing revives) |
| `teams`           | —                             | the caller's org teams `[{ id, name }]` |
| `developerStatus` | —                             | the org's developer-namespace registration status |
| `registerDeveloper` | `[developerId]`             | claims the org's developer-id slug |
| `loadListing` / `saveListing` | `[listing?]`      | read/write the app's store listing metadata |
| `preflight`       | —                             | pre-submit checks (app entry point + rsbuild config present) |

Deploy packages the app's **source** — `dist/` is never uploaded; the server
injects platform deps and performs the build.

## Account & checkout messages

- `{ type: 'account:setDevTeam', teamId }` — set the caller's development team
  for the active org (dev-run billing + environment layer). Per-org selection.
- `{ type: 'checkout:getStripeKey' }` → host replies
  `{ type: 'checkout:stripeKey', key, reason? }`. The publishable key is fetched
  at runtime from the connected server's public probe (never baked into the
  build). When the key is empty, `reason` explains why
  (`'no-connection' | 'probe-failed'`) so the webview can show a message instead
  of a dead Subscribe button; the requesting hook re-requests when a connection
  lands.
