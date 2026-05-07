# tell

> Interstellar answering machine — leave messages for offline users, delivered when they return.

## Overview

The tell module is a fancy text-based answering machine that allows users to leave messages for other users who may not be online at the moment. When the recipient joins a channel or sends a message, they will receive all pending messages that were left for them.

Tell integrates with the eevee ecosystem through the router's command and broadcast systems. It registers three commands (`tell`, `rmtell`, `list-tells`) and a broadcast listener that monitors all chat activity. When a user with pending tells becomes active, the broadcast handler delivers their messages immediately.

Messages are persisted in a SQLite database, so tells survive bot restarts and are never lost. The module also includes a migration utility for upgrading from the legacy eevee.bot tell module.

## Features

- Leave messages for offline users with `tell <username> <message>`
- Delete your own messages with `rmtell <message-id>`
- List your outstanding (undelivered) tells with `list-tells`
- Automatic delivery of pending messages when users are active
- Persistent storage using SQLite
- Rate limiting to prevent abuse
- Multi-platform support (works across all chat connectors)
- Help registration for `!help` and `!bots` integration

## Install

```bash
npm install @eeveebot/tell
```

Or, within the eevee workspace, the module is available directly.

### Requirements

- **Node.js** 24+
- **Python** 3.x (required for building the `better-sqlite3` native module)
- **npm**

When building with Docker, Python is included in the container image.

## Configuration

See `config/example.yaml` for the full configuration file:

```yaml
# Rate limit configuration
ratelimit:
  mode: drop        # drop or queue
  level: user       # user or channel
  limit: 5          # max commands per interval
  interval: 1m      # time window

# Database path (optional, defaults to MODULE_DATA/tell.db)
dbPath: "./tell.sqlite"
```

| Key | Default | Description |
|-----|---------|-------------|
| `ratelimit.mode` | `drop` | How to handle rate-limited commands (`drop` or `queue`) |
| `ratelimit.level` | `user` | Rate limit scope (`user` or `channel`) |
| `ratelimit.limit` | `5` | Maximum commands allowed per interval |
| `ratelimit.interval` | `1m` | Rate limit time window |
| `dbPath` | `MODULE_DATA/tell.db` | Path to the SQLite database file |

## Commands

### tell

Leave a message for someone. Returns a tell ID that can be used with `rmtell`.

Usage: `tell <username> <message>`

Example: `tell alice Hey, check out this cool link!`

### rmtell

Delete a tell that you sent. Your current hostmask must match the original sender's hostmask.

Usage: `rmtell <message-id>`

Example: `rmtell a1b2c3d4`

### list-tells

List your outstanding (undelivered) tells.

Usage: `list-tells`

## Architecture

```
┌──────────┐    command.execute.*     ┌──────────────┐
│  Router   │ ──────────────────────▶ │  tell module │
│          │                          │              │
│          │ ◀─────────────────────── │  (nats)      │
└──────────┘    sendChatMessage       └──────┬───────┘
                                              │
       broadcast.message.*                    │
       (all chat activity)                    │
              │                               │
              ▼                               ▼
        ┌─────────────────────────────┐
        │  Broadcast handler          │
        │  - Match nick/ident         │
        │  - Deliver pending tells    │
        │  - Mark as delivered        │
        └─────────────┬───────────────┘
                      │
                      ▼
               ┌─────────────┐
               │  SQLite DB  │
               │  (tells)    │
               └─────────────┘
```

The module follows the standard eevee module pattern:

1. **Startup** — Connects to NATS, loads config, initializes the SQLite database, registers commands and a broadcast listener.
2. **Command handling** — Subscribes to `command.execute.<uuid>` subjects for `tell`, `rmtell`, and `list-tells`. Each command is processed, persisted (or removed), and a confirmation is sent back to chat.
3. **Broadcast listening** — Subscribes to `broadcast.message.<uuid>` to observe all chat activity. When a user with pending tells is detected (matched by nick or `nick@ident`), their tells are delivered and marked as delivered in the database.
4. **Graceful shutdown** — Closes the database connection and NATS clients on shutdown signals.

### Database Schema

All tells are stored in a single `tells` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | 8-character hex identifier |
| `dateSent` | TEXT | ISO timestamp when the tell was created |
| `fromConnector` | TEXT | Connector that sent the tell |
| `fromChannel` | TEXT | Channel where the tell was sent |
| `fromIdent` | TEXT | Sender's full ident (`nick@host`) |
| `fromUser` | TEXT | Sender's nickname |
| `toUser` | TEXT | Recipient's nickname (lowercase) |
| `platform` | TEXT | Chat platform |
| `message` | TEXT | The message text |
| `pm` | INTEGER | Whether this is a private message |
| `delivered` | INTEGER | 0 = pending, 1 = delivered |
| `dateDelivered` | TEXT | ISO timestamp when delivered |

## Migration from Old Version

If you're upgrading from the old eevee.bot tell module, you can migrate your existing data using the migration script:

```bash
npm run migrate -- <old-db-path> <new-db-path> [instance-name]
```

Example for main database:
```bash
npm run migrate -- ../old-eevee-bot/db/tell.sqlite ./tell.sqlite
```

Example for instance-specific database:
```bash
npm run migrate -- ../old-eevee-bot/db/tell.sqlite ./tell-instance1.sqlite instance1
```

The migration script will:
1. Read all existing tell records from the old database
2. Transform them to match the new schema
3. Insert them into the new database in a transaction
4. Preserve all message IDs, timestamps, and metadata

Note: The old database is opened in read-only mode, so your original data remains untouched.

## Development

```bash
# clone the repo and install dependencies
git clone https://github.com/eeveebot/eevee.git
cd eevee/tell
npm install

# run linting
npm test

# build
npm run build

# watch mode for development
npm run dev
```

## Contributing

Contributions are welcome! Please see the [eevee contributing guide](https://github.com/eeveebot/eevee) for details.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](./LICENSE) for the full text.
