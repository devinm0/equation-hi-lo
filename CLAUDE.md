# Equation Hi Lo — Project Context

## What It Is

Real-time multiplayer card game. Players are dealt number and operator cards, form mathematical equations (targeting values near 1 = low, 20 = high), and bet chips across multiple rounds — poker-like structure with math instead of hand ranks.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, TypeScript, Express v5, `ws` (WebSocket) |
| Frontend | Vanilla JavaScript, inline `<script type="module">` in `index.html` |
| Shared types | `enums.ts` (compiled separately to `public/enums.js`) |
| Process manager | PM2 (`ecosystem.config.js`) |
| Testing | Jest (unit), Playwright (E2E) |
| State | In-memory only — no database |

## Key Files

- `server.ts` (2,177 lines) — entire backend: WebSocket routing, game engine, winner logic, HTTP static serving
- `public/index.html` (1,699 lines) — entire frontend: HTML + all UI/game logic inline
- `enums.ts` — shared game constants (NumberCard, OperatorCard, Suit, GamePhase)
- `public/classes.ts` — Game, Player, Card data classes (TypeScript, used by frontend as JS)
- `public/utilities.ts` — helper functions (room code gen, HTML escaping)
- `ecosystem.config.js` — PM2 production config
- `__tests__/tests.ts` — Jest unit tests
- `automated_testing/` — Playwright E2E tests

## Game Flow (Phase Order)

`LOBBY → FIRSTDEAL → FIRSTBETTING → SECONDDEAL → EQUATIONFORMING → SECONDBETTING → HILOSELECTION → RESULTVIEWING`

During `EQUATIONFORMING` (90s timer, 20s in debug mode), players drag-reorder their cards to form an equation. The server evaluates it using a shunting-yard algorithm supporting +, −, ×, ÷, √.

Players then bet hi/lo/swing on whether their result is closer to 1 or 20.

## WebSocket Message Types

**Client → Server:** `create`, `enter`, `join`, `start`, `discard`, `hand-order`, `lock-in`, `hi-lo-selected`, `bet-placed`, `fold`, `acknowledge-hand-results`, `leave`, `refresh`

**Server → Client:** `init`, `begin-hand`, `deal`, `player-joined`, `first-round-betting-commenced`, `second-round-betting-commenced`, `player-discarded`, `player-folded`, `kicked`, `next-turn`, `end-betting-round`, `commence-equation-forming`, `hi-lo-selection`, `round-result`, `game-started`, `suggest-room`, `room-join-reject`

## Environment Variables

| Variable | Effect |
|---|---|
| `GAME_MODE=debug` | Equation timer 20s instead of 90s |
| `PORT` | Server port (default likely 3000) |

No `.env.example` exists yet — add one.

## Known Architectural Issues (fix before shipping)

1. **Hardcoded WebSocket URL** — `public/index.html` has `wss://equationhi.lol` hardcoded. Must be dynamic:
   ```js
   const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
   const socket = new WebSocket(`${protocol}//${window.location.host}`);
   ```

2. **`tsx` in production** — `ecosystem.config.js` runs TypeScript directly via `tsx` (a dev tool). Should compile first and run `dist/server.js`.
   - Fix `build` script: `tsc && npx tsc enums.ts --outDir public --target ES2020 --module NodeNext`
   - Fix `start` script: `node dist/server.js`
   - Fix `ecosystem.config.js`: `script: 'dist/server.js'`, remove `interpreter: 'tsx'`

3. **`socket.io` unused** — listed in dependencies, `ws` is what's actually used. Remove it.

4. **WebSocket origin check commented out** — re-enable to prevent cross-site WebSocket hijacking.

5. **Frontend is JS, backend is TypeScript** — `public/classes.ts` and `public/utilities.ts` are TypeScript but have no automated compile step. Only `enums.ts` is compiled (manually in the `start` script). Add a proper frontend compile step to `build`.

6. **Monolithic files** — `server.ts` (2,177 lines) and `index.html` (1,699 lines) mix all concerns. Not blocking for now but hard to maintain.

7. **In-memory state only** — server restart loses all active games. See persistence note below.

## Scripts

```bash
npm run dev     # nodemon, hot-reload for development
npm run build   # compile TypeScript
npm start       # start compiled server
npm test        # Jest unit tests (24 unit tests, uses --experimental-vm-modules + --forceExit)
```

## Before Every Commit

Run both test suites and verify manually:

1. **Unit tests:** `npm test` — must pass all 24
2. **E2E tests:** `npm run test:e2e` — runs headless, starts server automatically. Use `npm run test:e2e:headed` to watch browsers. Tests 3-player lobby and game start.

Do not commit if either fails.

### Running E2E tests during development

By default, run E2E tests **headed** (`npm run test:e2e:headed`, or `npx playwright test <name> --headed`) so the browsers are visible while iterating. The exception is the **full suite run before a commit** — run that **headless** (`npm run test:e2e`).

## Deployment Target: AWS EC2 t3.micro (Free Tier)

### Stack
- EC2 t3.micro — Amazon Linux 2023 or Ubuntu 24.04
- nginx — reverse proxy, SSL termination, HTTP→HTTPS redirect
- PM2 — Node.js process management, auto-restart on reboot
- Let's Encrypt (certbot) — free SSL certificate

### Security Group Ports
- 22 (SSH, restricted to your IP)
- 80 (HTTP, for certbot + redirect)
- 443 (HTTPS)

### nginx Config (WebSocket-aware)
```nginx
server {
    listen 80;
    server_name equationhi.lol;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name equationhi.lol;

    ssl_certificate /etc/letsencrypt/live/equationhi.lol/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/equationhi.lol/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Deploy Steps
```bash
# On EC2 instance:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2

git clone <repo>
cd equation-hi-lo
npm ci --omit=dev
npm run build

sudo certbot --nginx -d equationhi.lol

pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
pm2 install pm2-logrotate
```

### Persistence (Optional)
Install Redis locally on the EC2 instance (`sudo apt install redis-server`). On server startup, load game state from Redis. On state changes, write to Redis. This survives server restarts at zero extra cost.

Do NOT use AWS ElastiCache — it is not free tier.

### DNS
Point the domain's A record to the EC2 Elastic IP at your registrar (Cloudflare, Namecheap, etc.) — this is independent of which AWS account the instance lives on.

## SSH Access

```bash
ssh -i equation-hi-lo-keypair.pem ubuntu@equationhi.lol
```

Keypair file: `equation-hi-lo-keypair.pem` (in repo root, gitignored).

After pulling and building on EC2:
```bash
cd equation-hi-lo && git pull && npm run build && pm2 restart all
```

## Rate Limiting

Server enforces 20 WebSocket messages per 10-second window per client. Heartbeat ping every ~34s to detect disconnects.

## Player Limits

Max 10 players per room (per TODO.txt).
