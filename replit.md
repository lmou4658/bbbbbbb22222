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

- **api-server** (`artifacts/api-server/`) — Express backend, OpenAI-compatible proxy, serves at `/api`. Also serves the portal static files at `/`.
- **api-portal** (`artifacts/api-portal/`) — React + Vite frontend portal. Built to `dist/public/` and served by api-server.

## Configuration

- `PROXY_API_KEY` — Set to `0110158` (env var in shared environment)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY/BASE_URL` — Replit AI Integration (Anthropic)
- `AI_INTEGRATIONS_OPENAI_API_KEY/BASE_URL` — Replit AI Integration (OpenAI)
- `AI_INTEGRATIONS_GEMINI_API_KEY/BASE_URL` — Replit AI Integration (Gemini)
- `AI_INTEGRATIONS_OPENROUTER_API_KEY/BASE_URL` — Replit AI Integration (OpenRouter)

## Development Workflow

- **api-server** runs: `pnpm --filter @workspace/api-server run dev` (builds then starts on port 8080)
- **api-portal** is built separately: `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/api-portal run build`
- The api-server serves portal static files from `artifacts/api-portal/dist/public/`
- After portal changes, rebuild the portal and restart api-server

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — run API server (serves portal + API)
- `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/api-portal run build` — rebuild portal static files
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
