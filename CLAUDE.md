# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

WatchParty: synchronized watch-together lobbies (YouTube or MP4 URL) with chat. .NET 10 backend (ASP.NET Core minimal API + SignalR, in-memory state) and a React 19 + TypeScript + Vite frontend. Code comments, commit messages, UI text and server error messages are in Turkish — keep it that way.

## Commands

Backend (SDK pinned in `global.json`, 10.0.401):
```powershell
cd backend\WatchParty.Api; dotnet watch      # http://localhost:5205 (launchSettings "http" profile)
dotnet build backend\WatchParty.slnx
dotnet test backend\WatchParty.slnx                                   # xUnit integration tests (WatchParty.Api.Tests)
dotnet test backend\WatchParty.slnx --filter "FullyQualifiedName~<TestName>"   # single test
```

Frontend (Node 20.19+ / 22.12+):
```powershell
cd frontend; npm install
npm run dev        # http://localhost:5173, proxies /api and /hubs (incl. WebSocket) to BACKEND_URL (default http://localhost:5205)
npm run dev:mock   # no backend needed: VITE_MOCK=true from .env.mock, tabs in the same browser share a fake server
npm run build      # tsc -b && vite build -> dist/ (also the only type check; there is no linter)
```

Tests: `backend/WatchParty.Api.Tests` is an xUnit project (`WatchPartyFactory` runs the app in-process over TestServer; SignalR clients use LongPolling). In addition, `backend/e2e/e2e.mjs` is a single end-to-end script that drives a **running** backend over REST and SignalR and prints PASS/FAIL per check (it can't run individual tests; it takes ~30 s because it waits out the host grace period):
```powershell
cd backend\e2e; npm install; npm test          # BASE_URL env var overrides http://localhost:5205
```
It asserts on substrings of the Turkish `HubException` messages (e.g. "bulunamadı", "Sadece host", "dolu"), so changing those messages breaks it. Run it with the backend in Development (appsettings.Development.json raises the rate/connection limits to 1000 because e2e opens many connections from one IP). `backend/WatchParty.Api/wwwroot/test.html` is a manual hub test page, served only in Development.

## Architecture

**Server is the single source of truth.** All lobby state lives in `InMemoryLobbyStore` (singleton `ConcurrentDictionary`, note the filename `InMemoryLobbyStore .cs` contains a space). Nothing is persisted; restarting the backend drops all lobbies.

- REST (`Program.cs`): `POST /api/lobbies` (creates lobby, returns 6-char code from an alphabet without ambiguous chars), `GET /api/lobbies/{code}` (case-insensitive), `GET /api/health` (includes `serverTime`).
- SignalR hub `LobbyHub` at `/hubs/lobby`. A connection's lobby membership is stored in `Context.Items` (`lobbyCode`, `clientId`), so after a reconnect the server no longer knows the client and it must call `JoinLobby` again (the frontend `connection.ts` does this automatically).
- Identity: `clientId` is a stable per-browser id (localStorage); `ConnectionId` is per-connection and is what clients see as participant `id`/`selfId`. Host is tracked by `HostClientId`, so a host who refreshes keeps the role. `clientId` is never sent to other clients.
- Playback: every Play/Pause/Seek/SetMedia replaces the immutable `PlaybackState` record (with `UpdatedAt` = server unix ms) and broadcasts `PlaybackUpdated` to the lobby group. In host-only mode, non-hosts get a `HubException`.
- Background services: `LobbyTickService` (1 s tick) transfers host to the oldest participant after the host has been gone 10 s and re-broadcasts playback every 10 s; `LobbyCleanupService` deletes lobbies empty for 10 min. Messages sent from both hub and services go through `LobbyEvents`.
- `Lobby` state changes go through `Lobby` methods (`TryJoin`, `Leave`, `TryClose`, `TryTransferHost`) which take `Lobby.Gate`; hub `Update`/`SetControlMode` use `lock (lobby.Gate)`. Don't mutate lobby state from outside these.
- `Lobbies/MediaValidator.cs` validates media server-side: YouTube id `^[A-Za-z0-9_-]{11}\z`, file = absolute https URL, max 200 chars.
- `Security/`: `HttpRateLimits` (per-IP fixed window on `POST`/`GET /api/lobbies`, 429), `HubRateLimitFilter` (per-connection token buckets for chat/playback/other, plus per-IP concurrent connection limit via `ConnectionCounter`), `ClientIp`. All limits come from the `Security` config section (`SecurityOptions`); Development raises them.
- Limits are duplicated in backend constants and `frontend/src/lib/types.ts` (20 participants, nickname 30, chat 500, media id 200, chat history 50) and in `lib/mock.ts`, which re-implements hub rules — keep all three in sync when changing hub behaviour.

**Frontend sync model** (details in `frontend/README.md`):
- `LobbyConnection` interface in `lib/connection.ts` has two implementations: real SignalR and `MockLobbyConnection` (`lib/mock.ts`, localStorage + BroadcastChannel). Event names map 1:1 to hub `SendAsync("...")` names; JSON is camelCase.
- `lib/clock.ts` estimates server clock offset via the hub's `Ping`; `expectedPosition()` in `types.ts` computes where playback should be now.
- `lib/sync.ts` `SyncEngine` pulls the player toward server state every 500 ms (seek if drift > 1.5 s; for MP4, 0.95/1.05 playback rate for 0.3–1.5 s drift).
- Player native controls are disabled; only our buttons send commands to the server, and player events are **never** sent back. This prevents feedback loops from programmatic seeks — preserve this when touching `players/` or `components/Controls.tsx`.
- Routing is hand-rolled in `App.tsx` (`/` and `/l/CODE`), no router library.

Deployment target (planned, not yet in the repo): `dist/` on S3/CloudFront, backend on EC2 with CloudFront routing `/api` and `/hubs` to it (hence no CORS config).

Deploy notes:
- Set `Security:TrustForwardedHeaders=true` (env `Security__TrustForwardedHeaders`) behind CloudFront so limits see the real client IP (rightmost `X-Forwarded-For`, `ForwardLimit = 1`). Only do this if the origin is reachable **only** from CloudFront; otherwise a spoofed `X-Forwarded-For` bypasses the limits. If another proxy (e.g. an ALB) sits between CloudFront and the app, `ForwardLimit` in `Program.cs` must be raised accordingly.
- Set `AllowedHosts` via environment variable (`AllowedHosts=your.domain`); the default is `*`.
