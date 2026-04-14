# WatchDeck

> **⚠️ Work in progress — not ready for production use.**

Self-hosted endpoint monitoring for solo devs and small teams. Drop it into any Node.js project and get uptime tracking, latency graphs, SSL expiry alerts, and incident history — all from a single npm package.

---

## Features

- **HTTP & port monitoring** — check any URL or TCP port on a custom interval
- **SSL certificate tracking** — get warned before certs expire
- **Incident management** — automatic open/resolve with full timeline
- **Notification channels** — Discord and Slack webhooks out of the box
- **Live dashboard** — real-time updates via SSE, no polling required
- **Flexible deployment** — run standalone or mount the dashboard inside your existing app
- **Self-hosted** — your data stays on your infrastructure

---

## Requirements

- Node.js 20+
- MongoDB instance (local or remote)

---

## Quick Start

```bash
npx watchdeck init
npx watchdeck start
```

The init wizard will generate a `watchdeck.config.js` and `.env` in your project directory, then start the server.

---

## Configuration

Configuration lives in `watchdeck.config.js` at your project root:

```js
export default {
  port: 4000,
  dashboardRoute: '/dashboard',
  dashboardMode: 'standalone',
  modules: {
    discord: true,
    slack: true,
    sslChecks: true,
    portChecks: true,
    bodyValidation: true,
  },
}
```

Sensitive values (DB connection string, tokens) go in `.env`:

```env
MX_DB_URI=mongodb://localhost:27017/watchdeck
MX_DISCORD_TOKEN=your_token
MX_SLACK_TOKEN=your_token
MX_ENCRYPTION_KEY=your_32_char_key
```

---

## Dashboard Modes

**Standalone** — WatchDeck serves the dashboard itself at `dashboardRoute`:

```bash
npx watchdeck start
# Dashboard at http://localhost:4000/dashboard
```

**Mounted** — import the React component into your existing app:

```tsx
import { WatchDeckDashboard } from 'watchdeck/dashboard'

export default function MonitoringPage() {
  return <WatchDeckDashboard apiUrl="https://your-app.com/api/mx" />
}
```

---

## License

MIT
