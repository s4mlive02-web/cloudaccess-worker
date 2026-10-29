# CloudAccess Browser Worker

Playwright/Chromium worker for **CloudAccess Browser**. It runs isolated
browser sessions (one Chromium context per session), streams the viewport to
the main app over WebSocket (CDP screencast, JPEG frames), forwards
mouse/keyboard input, and handles the admin "connect" flow: the worker
verifies a login in the remote browser and returns the storage state to the
main app over the internal-token channel only. No cookies or storage state are
ever sent to end-user browsers.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BROWSER_WORKER_TOKEN` | yes | Shared internal token. HTTP control calls must send it as `x-internal-token`; must match the main app's token. |
| `MAIN_APP_URL` | yes | Base URL of the main CloudAccess app, e.g. `https://cloudaccess-browser.vercel.app`. |
| `WORKER_PUBLIC_WS` | yes | Public WebSocket base URL of this worker, e.g. `wss://cloudaccess-worker.onrender.com` (set after the host URL is known). |
| `PORT` | no | Port to listen on. Set automatically by the host (Render); defaults to 8080 locally. |

## Run

```bash
npm install
npm start          # node src/index.js
# health check: GET /health -> {"ok":true,"sessions":N}
```

Docker: build the included `Dockerfile` (Playwright base image). A
`render.yaml` Blueprint for a Render free web service is included.
