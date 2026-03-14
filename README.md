# tell

interstellar answering machine

## Overview

The tell module is a fancy text-based answering machine that allows users to leave messages for other users who may not be online at the moment. When the recipient joins a channel or sends a message, they will receive all pending messages that were left for them.

## Features

- Leave messages for offline users with `tell <username> <message>`
- Delete your own messages with `rmtell <message-id>`
- Automatic delivery of pending messages when users are active
- Persistent storage using SQLite database
- Rate limiting to prevent abuse
- Multi-platform support

## Commands

### tell
Leave a message for someone.

Usage: `tell <username> <message>`

Example: `tell alice Hey, check out this cool link!`

### rmtell
Remove a message you previously sent.

Usage: `rmtell <message-id>`

Example: `rmtell a1b2c3d4-e5f6-7890-abcd-ef1234567890`

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
3. Insert them into the new database
4. Preserve all message IDs, timestamps, and metadata

Note: The old database is opened in read-only mode, so your original data remains untouched.

## Configuration

See `config/example.yaml` for configuration options:

- Rate limiting settings
- Database path customization