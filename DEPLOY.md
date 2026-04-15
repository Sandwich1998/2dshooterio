# Deploy

This repo should be deployed as two services:

- Vercel for the Next.js frontend
- Render, Railway, or Fly.io for the Node WebSocket game server

## 1. Push the repo to GitHub

Vercel and most server hosts deploy directly from GitHub, so start by publishing this repository there.

## 2. Deploy the frontend on Vercel

Use the repo root as the Vercel project.

Build settings:

- Framework preset: `Next.js`
- Install command: `npm install`
- Build command: `npm run build`

Environment variable:

```bash
NEXT_PUBLIC_WS_URL=wss://game.your-domain.com
```

After deployment, attach your site domain, for example `www.your-domain.com`.

## 3. Deploy the game server

Deploy the same repository to a Node host, but start the game server instead of the Next.js app.

Commands:

```bash
npm install
npm run start:server
```

Environment variables:

```bash
SERVER_TICK_RATE=30
SNAPSHOT_RATE=30
```

The server will use `SERVER_PORT` if set, otherwise it will fall back to the platform-provided `PORT`.

Health check:

```text
/health
```

Suggested domain:

```text
game.your-domain.com
```

## 4. Wire them together

Set the Vercel frontend env var:

```bash
NEXT_PUBLIC_WS_URL=wss://game.your-domain.com
```

Then redeploy the frontend so the browser bundle gets the correct WebSocket URL.

## 5. Verify production

- Open the site over `https://`
- Confirm the browser connects to `wss://game.your-domain.com`
- Confirm the game server health check returns `{"ok":true,...}`
- Join a match in two browser tabs
- Check reconnect behavior by restarting the server once
