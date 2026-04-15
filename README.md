Dustline is a top-down tactical battle royale built with Next.js and a lightweight Node WebSocket server.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the game client + multiplayer server together:

```bash
npm run dev:all
```

Or run them separately in two terminals:

```bash
npm run dev
npm run dev:server
```

Open [http://localhost:3000](http://localhost:3000) to play. The WebSocket server runs on `ws://localhost:3001`.

Gameplay summary:
- Loot crates for weapons/ammo.
- Stay inside the fog ring as it shrinks.
- Eliminate opponents to win the match.
- Bots spawn automatically to keep the arena populated (target 6 total players).

Main files:
- `src/app/page.tsx` — canvas client and HUD
- `server/index.ts` — authoritative game server (ws)

## Deployment

This project is split into two deploy targets:

- Frontend: Next.js app on Vercel
- Game server: long-lived Node.js WebSocket process on a host like Render, Railway, or Fly.io

Vercel is a good fit for the frontend, but not for the raw game server in `server/index.ts`. The client reads the server URL from `NEXT_PUBLIC_WS_URL`.

### Environment variables

Frontend:

```bash
NEXT_PUBLIC_WS_URL=wss://game.your-domain.com
```

Game server:

```bash
SERVER_PORT=3001
SERVER_TICK_RATE=30
SNAPSHOT_RATE=30
```

Notes:

- On managed hosts such as Render and Railway, the server also accepts the platform-provided `PORT` variable automatically.
- Browsers require `wss://` when your site is served over `https://`.

### Vercel frontend

1. Push this repository to GitHub.
2. Import the repo into Vercel.
3. Add `NEXT_PUBLIC_WS_URL` in the Vercel project settings.
4. Deploy. Vercel will use `npm run build` for the Next.js app.

### Game server

Deploy the same repository to a Node host and start only the WebSocket server:

```bash
npm install
npm run start:server
```

Set these values on the server host:

- `SERVER_TICK_RATE=30`
- `SNAPSHOT_RATE=30`

Use `/health` as the health check endpoint.

### Recommended setup

- `www.your-domain.com` -> Vercel project
- `game.your-domain.com` -> Node/WebSocket server
- `NEXT_PUBLIC_WS_URL=wss://game.your-domain.com`

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

For an exact split-host deployment walkthrough, see `DEPLOY.md`.
