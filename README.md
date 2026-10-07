# mawadao-agent-dashboard

Each member's private workspace, served at `<username>.<root domain>`. Members chat with
their agent and manage everything it can do from here.

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## What it does

- **Chat:** streaming conversations with the member's own agent (`mawadao-agent-gateway`).
- **Channels:** connect Slack, Discord, Telegram and WhatsApp.
- **Skills and keys:** install skills, store model-provider keys (encrypted at rest).
- **Mission Control:** boards, tasks, approvals and activity for teams of agents (`mawadao-agent-mission-control`).
- **Inbox:** Gmail and Outlook accounts with AI-drafted replies the member approves.
- **Seller tools:** products, campaigns, social accounts and wallet.

## How it fits

| Talks to | For |
| --- | --- |
| `mawadao-agent-gateway` | The member's running agent (chat, config, skills) |
| `mawadao-agent-api` | Agents, marketplace, seller data |
| `mawadao-agent-mission-control` | Boards, tasks and approvals |
| `mawadao-agent-channels` | Sending messages out through platform bots |
| `mawadao-agent-deployer`, `mawadao-agent-storage` | Workspace provisioning and files |
| Postgres (`mawadao-agent-db`) | Conversations, inbox, Slack links, preferences |

## Run it locally

Requires Node.js 22.

```bash
cp .env.example .env.local   # fill in the values
npm ci
npm run dev                  # http://localhost:3001
```

Checks: `npm run lint`, `npm run type-check`, `npm test`, `npm run build`.

## Configuration

Every variable the code reads is listed in [`.env.example`](.env.example). At minimum set
`DATABASE_URL`, `JWT_SECRET` (shared with `mawadao-agent-auth`), `PROVIDER_KEY_SECRET`,
`CONFIG_API_URL` and `OPENCLAW_GATEWAY_URL`/`OPENCLAW_GATEWAY_TOKEN`.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
Work lands on `main`; releases are tagged `vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](LICENSE), and [NOTICE](NOTICE) for the MIT-licensed code from Moltbook it builds on.
