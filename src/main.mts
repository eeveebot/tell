'use strict';

// Tell module
// Fancy text-based answering machine

import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { NatsClient, log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();

const tellCommandUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const rmtellCommandUUID = 'b2c3d4e5-f6a7-8901-bcde-f01234567891';

// Rate limit configuration interface
interface RateLimitConfig {
  mode: 'enqueue' | 'drop';
  level: 'channel' | 'user' | 'global';
  limit: number;
  interval: string; // e.g., "30s", "1m", "5m"
}

// Tell module configuration interface
interface TellConfig {
  ratelimit?: RateLimitConfig;
  dbPath?: string;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<string | boolean>> = [];

// Database instance
let db: Database.Database | null = null;

/**
 * Load tell configuration from YAML file
 * @returns TellConfig parsed from YAML file
 */
function loadTellConfig(): TellConfig {
  // Get the config file path from environment variable
  const configPath = process.env.MODULE_CONFIG_PATH;
  if (!configPath) {
    log.warn('MODULE_CONFIG_PATH not set, using default config', {
      producer: 'tell',
    });
    return {};
  }

  try {
    // Read the YAML file
    const configFile = fs.readFileSync(configPath, 'utf8');

    // Parse the YAML content
    const config = yaml.load(configFile) as TellConfig;

    log.info('Loaded tell configuration', {
      producer: 'tell',
      configPath,
    });

    return config;
  } catch (error) {
    log.error('Failed to load tell configuration, using defaults', {
      producer: 'tell',
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

//
// Do whatever teardown is necessary before calling common handler
process.on('SIGINT', () => {
  if (db) {
    db.close();
  }
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

process.on('SIGTERM', () => {
  if (db) {
    db.close();
  }
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

//
// Setup NATS connection

// Get host and token
const natsHost = process.env.NATS_HOST || false;
if (!natsHost) {
  const msg = 'environment variable NATS_HOST is not set.';
  throw new Error(msg);
}

const natsToken = process.env.NATS_TOKEN || false;
if (!natsToken) {
  const msg = 'environment variable NATS_TOKEN is not set.';
  throw new Error(msg);
}

const nats = new NatsClient({
  natsHost: natsHost as string,
  natsToken: natsToken as string,
});
natsClients.push(nats);
await nats.connect();

// Load configuration at startup
const tellConfig = loadTellConfig();

// Initialize database
function initDatabase(): void {
  try {
    const dbPath = tellConfig.dbPath || './tell.sqlite';
    db = new Database(dbPath, {
      //verbose: console.log
    });

    // Create tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS tells (
        id TEXT PRIMARY KEY,
        dateSent TEXT,
        fromConnector TEXT,
        fromChannel TEXT,
        fromIdent TEXT,
        fromUser TEXT,
        toUser TEXT,
        platform TEXT,
        message TEXT,
        pm INTEGER,
        delivered INTEGER DEFAULT 0,
        dateDelivered TEXT
      );
    `);

    log.info('Initialized tell database', {
      producer: 'tell',
      dbPath,
    });
  } catch (error) {
    log.error('Failed to initialize tell database', {
      producer: 'tell',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Initialize database at startup
initDatabase();

// Prepared statements for database operations
const addTellStmt = db!.prepare(`
  INSERT INTO tells (id, dateSent, fromConnector, fromChannel, fromIdent, fromUser, toUser, platform, message, pm, delivered, dateDelivered)
  VALUES (@id, @dateSent, @fromConnector, @fromChannel, @fromIdent, @fromUser, @toUser, @platform, @message, @pm, @delivered, @dateDelivered)
`);

const findTellsByUserStmt = db!.prepare(`
  SELECT * FROM tells WHERE toUser = @toUser AND delivered = 0 ORDER BY dateSent ASC
`);

const findTellByIdStmt = db!.prepare(`
  SELECT * FROM tells WHERE id = @id
`);

const markAsDeliveredStmt = db!.prepare(`
  UPDATE tells SET dateDelivered = @date, delivered = 1 WHERE id = @id
`);

const removeTellByIdStmt = db!.prepare(`
  DELETE FROM tells WHERE id = @id
`);

// Function to register the tell command with the router
async function registerTellCommands(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 5,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = tellConfig.ratelimit || defaultRateLimit;

  // Register tell command
  const tellCommandRegistration = {
    type: 'command.register',
    commandUUID: tellCommandUUID,
    commandDisplayName: 'tell',
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: 'tell ', // Match tell command with at least one word after
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  // Register rmtell command
  const rmtellCommandRegistration = {
    type: 'command.register',
    commandUUID: rmtellCommandUUID,
    commandDisplayName: 'rmtell',
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: 'rmtell ', // Match rmtell command with at least one word after
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish(
      'command.register',
      JSON.stringify(tellCommandRegistration)
    );
    await nats.publish(
      'command.register',
      JSON.stringify(rmtellCommandRegistration)
    );
    log.info('Registered tell and rmtell commands with router', {
      producer: 'tell',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register tell commands', {
      producer: 'tell',
      error: error,
    });
  }
}

// Register commands at startup
await registerTellCommands();

// Subscribe to tell command execution messages
const tellCommandSub = nats.subscribe(
  `command.execute.${tellCommandUUID}`,
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for tell', {
        producer: 'tell',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Parse the command: tell <username> <message>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 3) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Usage: tell <username> <message>`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const toUser = parts[1].toLowerCase();
      const messageText = parts.slice(2).join(' ');

      // Create a unique ID for this tell
      const tellId = `${data.platform}-${data.instance}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Save the tell to database
      const newTellData = {
        id: tellId,
        dateSent: new Date().toISOString(),
        fromConnector: data.replyTo,
        fromChannel: data.channel,
        fromIdent: data.ident,
        fromUser: data.user,
        toUser: toUser,
        platform: data.platform,
        message: messageText,
        pm: 0,
        delivered: 0,
        dateDelivered: null,
      };

      addTellStmt.run(newTellData);

      // Send confirmation message
      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${data.user}: Message to ${toUser} saved! (ID: ${tellId})`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process tell command', {
        producer: 'tell',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(tellCommandSub);

// Subscribe to rmtell command execution messages
const rmtellCommandSub = nats.subscribe(
  `command.execute.${rmtellCommandUUID}`,
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for rmtell', {
        producer: 'tell',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Parse the command: rmtell <id>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 2) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Usage: rmtell <id>`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const tellId = parts[1];

      // Find the tell by ID
      const tell = findTellByIdStmt.get({ id: tellId }) as
        | {
            id: string;
            fromIdent: string;
            fromUser: string;
          }
        | undefined;

      if (!tell) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Message with ID ${tellId} was not found`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      // Check if the user is the original sender
      if (data.ident !== tell.fromIdent) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Message with ID ${tellId} was not sent by you`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      // Remove the tell
      removeTellByIdStmt.run({ id: tellId });

      // Send confirmation message
      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${data.user}: Message with ID ${tellId} deleted`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process rmtell command', {
        producer: 'tell',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(rmtellCommandSub);

// Subscribe to broadcast messages to check for users with pending tells
const messageBroadcastSub = nats.subscribe(
  'chat.message.incoming.>',
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.debug('Received incoming message for tell check', {
        producer: 'tell',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
      });

      // Check if this user has any pending tells
      const lowercaseNick = data.user.toLowerCase();
      const pendingTells = findTellsByUserStmt.all({
        toUser: lowercaseNick,
      }) as Array<{
        id: string;
        fromUser: string;
        dateSent: string;
        message: string;
        platform: string;
      }>;

      // If there are pending tells, send them
      if (pendingTells.length > 0) {
        let responseText = '';

        for (let i = 0; i < pendingTells.length; i++) {
          const tell = pendingTells[i];

          // Format the time difference
          const timeDiff = formatTimeDifference(tell.dateSent);

          responseText += `${data.user}: ${tell.fromUser}, ${timeDiff} ago: ${tell.message}\n`;

          // Mark as delivered
          markAsDeliveredStmt.run({
            date: new Date().toISOString(),
            id: tell.id,
          });
        }

        // Send the tells to the channel
        const response = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: responseText.trim(),
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(response));
      }
    } catch (error) {
      log.error('Failed to process incoming message for tells', {
        producer: 'tell',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(messageBroadcastSub);

/**
 * Format time difference in a human-readable way
 * @param date ISO date string
 * @returns Formatted time difference string
 */
function formatTimeDifference(date: string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();

  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  const diffMinutes = Math.floor(((diffMs % 86400000) % 3600000) / 60000);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''}`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  } else {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''}`;
  }
}

// Subscribe to control messages for re-registering commands
const controlSubRegisterCommandTell = nats.subscribe(
  'control.registerCommands.tell',
  () => {
    log.info('Received control.registerCommands.tell control message', {
      producer: 'tell',
    });
    void registerTellCommands();
  }
);
natsSubscriptions.push(controlSubRegisterCommandTell);

const controlSubRegisterCommandRmtell = nats.subscribe(
  'control.registerCommands.rmtell',
  () => {
    log.info('Received control.registerCommands.rmtell control message', {
      producer: 'tell',
    });
    void registerTellCommands();
  }
);
natsSubscriptions.push(controlSubRegisterCommandRmtell);

const controlSubRegisterCommandAll = nats.subscribe(
  'control.registerCommands',
  () => {
    log.info('Received control.registerCommands control message', {
      producer: 'tell',
    });
    void registerTellCommands();
  }
);
natsSubscriptions.push(controlSubRegisterCommandAll);

// Subscribe to stats.uptime messages and respond with module uptime
const statsUptimeSub = nats.subscribe('stats.uptime', (subject, message) => {
  try {
    const data = JSON.parse(message.string());
    log.info('Received stats.uptime request', {
      producer: 'tell',
      replyChannel: data.replyChannel,
    });

    // Calculate uptime in milliseconds
    const uptime = Date.now() - moduleStartTime;

    // Send uptime back via the ephemeral reply channel
    const uptimeResponse = {
      module: 'tell',
      uptime: uptime,
      uptimeFormatted: `${Math.floor(uptime / 86400000)}d ${Math.floor((uptime % 86400000) / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
    };

    if (data.replyChannel) {
      void nats.publish(data.replyChannel, JSON.stringify(uptimeResponse));
    }
  } catch (error) {
    log.error('Failed to process stats.uptime request', {
      producer: 'tell',
      error: error,
    });
  }
});
natsSubscriptions.push(statsUptimeSub);

// Help information for tell commands
const tellHelp = [
  {
    command: 'tell',
    descr:
      'Leave a message for someone. Returns a tell ID that can be used with rmtell',
    params: [
      {
        param: 'to',
        required: true,
        descr: 'Person to send the tell to',
      },
      {
        param: 'message',
        required: true,
        descr: 'Text to send',
      },
    ],
  },
  {
    command: 'rmtell',
    descr:
      "Delete a tell that you sent. Your current hostmask must match the orig. sender's hostmask",
    params: [
      {
        param: 'tell ID',
        required: true,
        descr: 'ID of the tell to delete',
      },
    ],
  },
];

// Function to publish help information
async function publishHelp(): Promise<void> {
  const helpUpdate = {
    from: 'tell',
    help: tellHelp,
  };

  try {
    await nats.publish('help.update', JSON.stringify(helpUpdate));
    log.info('Published tell help information', {
      producer: 'tell',
    });
  } catch (error) {
    log.error('Failed to publish tell help information', {
      producer: 'tell',
      error: error,
    });
  }
}

// Publish help information at startup
await publishHelp();

// Subscribe to help update requests
const helpUpdateRequestSub = nats.subscribe('help.updateRequest', () => {
  log.info('Received help.updateRequest message', {
    producer: 'tell',
  });
  void publishHelp();
});
natsSubscriptions.push(helpUpdateRequestSub);
