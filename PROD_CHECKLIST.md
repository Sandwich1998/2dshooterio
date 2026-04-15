# Production Readiness Checklist

## Deployment
- Configure environment variables from `.env.example`.
- Run `npm run build` and `npm run start` for the web app.
- Set `NEXT_PUBLIC_WS_URL` to the public `wss://` URL of the game server.
- Run the game server with a process manager (PM2/systemd) or managed host auto-restart.
- Ensure the game server accepts the platform `PORT` env var when applicable.
- Use higher realtime defaults for combat feel, e.g. `SERVER_TICK_RATE=30` and `SNAPSHOT_RATE=30`.
- Add TLS termination (reverse proxy like nginx) for secure WebSocket (wss://).
- Configure health check path: `/health` on the game server.

## Security & Abuse
- Rate limits enabled for input, chat, and ping.
- Validate and clamp incoming input payloads.
- Add IP-level throttling at the edge (CDN/WAF) if exposed publicly.

## Observability
- Capture server errors via `uncaughtException` and `unhandledRejection` logging.
- Add structured logs if deploying to hosted environments.
- Enable basic uptime monitoring on `/health`.

## Scalability
- Plan for multiple rooms across processes or servers.
- Use a matchmaking layer if player volume grows.

## QA
- Test movement/collision on all obstacles.
- Test input spam, chat spam, and reconnect behavior.
- Test mobile input: pointer + touch.
- Test low-FPS devices with Performance Mode.
