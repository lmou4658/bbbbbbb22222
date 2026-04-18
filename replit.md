# AI Monorepo (v1.1.8)

## Overview

AI Monorepo is an OpenAI-compatible API proxy that supports Claude, OpenAI, Gemini, and OpenRouter. It includes a web portal for monitoring usage, logs, and configuration.

Sourced from: https://github.com/Direet1/smdjajd.git

## Architecture

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Build**: esbuild (api-server), Vite (api-portal)

## Artifacts

- **api-server** (`artifacts/api-server/`) — The only registered runtime artifact. Express backend serving `/api`, `/`, and `/portal`. Owns the dev workflow which builds the portal then starts the server.
- **api-portal** (`artifacts/api-portal/`) — React + Vite source package only (no longer a registered artifact / no separate workflow). Built to `dist/public/` by `api-server`'s `build:portal` step, then served as static files by `api-server`.

## Configuration

- `PROXY_API_KEY` — Set to `0110158` (env var in shared environment)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY/BASE_URL` — Replit AI Integration (Anthropic)
- `AI_INTEGRATIONS_OPENAI_API_KEY/BASE_URL` — Replit AI Integration (OpenAI)
- `AI_INTEGRATIONS_GEMINI_API_KEY/BASE_URL` — Replit AI Integration (Gemini)
- `AI_INTEGRATIONS_OPENROUTER_API_KEY/BASE_URL` — Replit AI Integration (OpenRouter)

## Development Workflow

- Single workflow: `pnpm --filter @workspace/api-server run dev`
  - Step 1: `build:portal` (builds api-portal with `BASE_PATH=/`)
  - Step 2: `build` (esbuild bundles api-server into `dist/`)
  - Step 3: `start` (runs `dist/index.mjs` on port 8080)
- api-server serves portal static files from `artifacts/api-portal/dist/public/`
- After portal changes, just restart the api-server workflow — it rebuilds the portal automatically

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — full dev cycle: build portal + build server + start
- `pnpm --filter @workspace/api-server run build:portal` — rebuild only the portal
- `pnpm install` — install all workspace dependencies

## API Routes

- `GET /api/healthz` — health check
- `POST /api/v1/chat/completions` — OpenAI-compatible chat (requires Bearer token = PROXY_API_KEY)
- `GET /api/v1/models` — list available models
- `GET /api/admin/*` — admin endpoints (requires PROXY_API_KEY)
- `GET /api/setup/status` — configuration status for portal setup wizard
- `GET /api/version` — version info

## Portal Features

- Home: shows base URL, connection status, version info
- Usage (用量): per-model usage statistics
- Logs (日志): real-time SSE request log stream
