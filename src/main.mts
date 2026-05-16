'use strict';

// Tell module
// Fancy text-based answering machine

import { NatsClient, log, createNatsConnection, registerGracefulShutdown, createModuleMetrics, loadModuleConfig, RateLimitConfig, defaultRateLimit, registerCommand, sendChatMessage, registerHelp, HelpEntry,
  registerStatsHandlers,
  registerBroadcast,
  initializeSystemMetrics,
  setupHttpServer,
  NatsSubscriptionResult,
} from '@eeveebot/libeevee';
import fs from 'node:fs';
import Database from 'better-sqlite3';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();
const moduleVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

const tellCommandUUID = '8626542f-7154-42ed-8fc4-3817fe912959';
const rmtellCommandUUID = 'db53b187-1f37-43e9-b9bb-ddaa7b1a1eb8';
const listtellsCommandUUID = 'bd15d52f-8bbb-4b93-ac4b-4533f65b2062';
const tellBroadcastUUID = '69b5b61b-2bc8-4d62-95cb-799c24e156d3';
const tellBroadcastDisplayName = 'tell';

// Tell module configuration interface
interface TellConfig {
  ratelimit?: RateLimitConfig;
  dbPath?: string;
}

const metrics = createModuleMetrics('tell');

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<NatsSubscriptionResult>> = [];

// Initialize system metrics
initializeSystemMetrics('tell');

// Setup HTTP server for metrics and health checks
setupHttpServer({
  port: process.env.HTTP_API_PORT || '9000',
  serviceName: 'tell',
  natsClients: natsClients,
});

// Database instance
let db: Database.Database | null = null;



registerGracefulShutdown(natsClients, async () => {
  if (db) db.close();
});

const nats = await createNatsConnection();
natsClients.push(nats);

// Load configuration at startup
const tellConfig = loadModuleConfig<TellConfig>({});

// Initialize database
function initDatabase(): void {
  try {
    const moduleDataPath = process.env.MODULE_DATA;
    if (!moduleDataPath) {
      throw new Error('MODULE_DATA environment variable not set');
    }

    // Ensure the directory exists
    if (!fs.existsSync(moduleDataPath)) {
      fs.mkdirSync(moduleDataPath, { recursive: true });
    }

    const dbPath = `${moduleDataPath}/tell.db`;
    db = new Database(dbPath);

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

const findTellsByNickOrIdentStmt = db!.prepare(`
  SELECT * FROM tells WHERE (toUser = @nick OR toUser = @nickIdent) AND delivered = 0 ORDER BY dateSent ASC
`);

const findOutgoingTellsByUserStmt = db!.prepare(`
  SELECT * FROM tells WHERE fromUser = @user AND delivered = 0 ORDER BY dateSent DESC
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

// Register broadcast at startup using registerBroadcast helper
const tellBroadcastSubs = await registerBroadcast(nats, {
  broadcastUUID: tellBroadcastUUID,
  broadcastDisplayName: tellBroadcastDisplayName,
}, metrics);
natsSubscriptions.push(...tellBroadcastSubs);

// Register tell commands using registerCommand helper
const rateLimitConfig = tellConfig.ratelimit || defaultRateLimit;

const tellCmdSubs = await registerCommand(nats, {
  commandUUID: tellCommandUUID,
  commandDisplayName: 'tell',
  regex: '^tell\\s+',
  platformPrefixAllowed: true,
  ratelimit: rateLimitConfig,
}, metrics);
natsSubscriptions.push(...tellCmdSubs);

const rmtellCmdSubs = await registerCommand(nats, {
  commandUUID: rmtellCommandUUID,
  commandDisplayName: 'rmtell',
  regex: '^rmtell\\s+',
  platformPrefixAllowed: true,
  ratelimit: rateLimitConfig,
}, metrics);
natsSubscriptions.push(...rmtellCmdSubs);

const listtellsCmdSubs = await registerCommand(nats, {
  commandUUID: listtellsCommandUUID,
  commandDisplayName: 'list-tells',
  regex: '^list-tells\\s*',
  platformPrefixAllowed: true,
  ratelimit: rateLimitConfig,
}, metrics);
natsSubscriptions.push(...listtellsCmdSubs);

// Register broadcast at startup
const tellBroadcastRegSubs = await registerBroadcast(nats, {
  broadcastUUID: tellBroadcastUUID,
  broadcastDisplayName: tellBroadcastDisplayName,
}, metrics);
natsSubscriptions.push(...tellBroadcastRegSubs);



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
        user: data.nick,
        originalText: data.originalText,
      });

      // Parse the command: tell <username> <message>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 2) {
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.nick}: Usage: tell <username> <message>`,
          trace: data.trace,
        }, metrics);
        return;
      }

      const toUser = parts[0].toLowerCase();
      const messageText = parts.slice(1).join(' ');

      // If the recipient contains "@", store it as-is (nick@ident format)
      // Otherwise, store just the nick for loose matching
      if (toUser.includes('@')) {
        // Already in nick@ident format
      } else {
        // Just store the nick for loose matching
      }

      // Create a unique ID for this tell (8-character lowercase hex string)
      const tellId = Math.random().toString(16).substring(2, 10);

      // Construct ident from user@userHost if available
      const constructedIdent = data.userHost
        ? `${data.user}@${data.userHost}`
        : data.ident;

      // Save the tell to database
      const newTellData = {
        id: tellId,
        dateSent: new Date().toISOString(),
        fromConnector: data.replyTo,
        fromChannel: data.channel,
        fromIdent: constructedIdent,
        fromUser: data.nick,
        toUser: toUser,
        platform: data.platform,
        message: messageText,
        pm: 0,
        delivered: 0,
        dateDelivered: null,
      };

      log.info('Saving new tell with ident info', {
        producer: 'tell',
        tellId: tellId,
        fromIdent: constructedIdent,
        fromUser: data.nick,
        toUser: toUser,
      });

      addTellStmt.run(newTellData);

      // Send confirmation message
      void sendChatMessage(nats, {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${data.nick}: Message to ${toUser} saved! (ID: ${tellId})`,
        trace: data.trace,
      }, metrics);
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
        user: data.nick,
        originalText: data.originalText,
      });

      // Parse the command: rmtell <id>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 1) {
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.nick}: Usage: rmtell <id>`,
          trace: data.trace,
        }, metrics);
        return;
      }

      const tellId = parts[0];

      // Find the tell by ID
      const tell = findTellByIdStmt.get({ id: tellId }) as
        | {
            id: string;
            fromIdent: string;
            fromUser: string;
          }
        | undefined;

      if (!tell) {
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.nick}: Message with ID ${tellId} was not found`,
          trace: data.trace,
        }, metrics);
        return;
      }

      // Construct ident from user@userHost if available
      const constructedIdent = data.userHost
        ? `${data.user}@${data.userHost}`
        : data.ident;

      log.info('Checking ident for rmtell command', {
        producer: 'tell',
        currentIdent: constructedIdent,
        storedIdent: tell.fromIdent,
        currentUser: data.user,
        storedUser: tell.fromUser,
        tellId: tellId,
        userHost: data.userHost,
        dataIdent: data.ident,
      });

      // Check if the user is the original sender
      // Also check if the username matches as a fallback
      if (constructedIdent !== tell.fromIdent && data.nick !== tell.fromUser) {
        log.info('Ident mismatch in rmtell - access denied', {
          producer: 'tell',
          currentIdent: constructedIdent,
          storedIdent: tell.fromIdent,
          currentUser: data.nick,
          storedUser: tell.fromUser,
          tellId: tellId,
          userHost: data.userHost,
          dataIdent: data.ident,
        });
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.nick}: Message with ID ${tellId} was not sent by you`,
          trace: data.trace,
        }, metrics);
        return;
      }

      log.info('Ident check passed for rmtell command', {
        producer: 'tell',
        currentIdent: constructedIdent,
        storedIdent: tell.fromIdent,
        currentUser: data.user,
        storedUser: tell.fromUser,
        tellId: tellId,
      });

      // Remove the tell
      removeTellByIdStmt.run({ id: tellId });

      // Send confirmation message
      void sendChatMessage(nats, {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${data.nick}: Message with ID ${tellId} deleted`,
        trace: data.trace,
      }, metrics);
    } catch (error) {
      log.error('Failed to process rmtell command', {
        producer: 'tell',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(rmtellCommandSub);

// Subscribe to list-tells command execution messages
const listtellsCommandSub = nats.subscribe(
  `command.execute.${listtellsCommandUUID}`,
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for list-tells', {
        producer: 'tell',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.nick,
        originalText: data.originalText,
      });

      // Find all outgoing tells from this user
      const outgoingTells = findOutgoingTellsByUserStmt.all({
        user: data.nick,
      }) as Array<{
        id: string;
        toUser: string;
        dateSent: string;
        message: string;
      }>;

      // Send the list of tells to the user
      if (outgoingTells.length === 0) {
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.nick}: You have no outgoing tells.`,
          trace: data.trace,
        }, metrics);
        return;
      }

      let responseText = `${data.nick}: Your outgoing tells:\n`;

      for (let i = 0; i < outgoingTells.length; i++) {
        const tell = outgoingTells[i];

        // Format the time difference
        const timeDiff = formatTimeDifference(tell.dateSent);

        responseText += `ID: ${tell.id.substring(0, 8)} To: ${tell.toUser} (${timeDiff} ago): ${tell.message}\n`;
      }

      // Send the tells to the channel
      void sendChatMessage(nats, {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: responseText.trim(),
        trace: data.trace,
      }, metrics);
    } catch (error) {
      log.error('Failed to process list-tells command', {
        producer: 'tell',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(listtellsCommandSub);

// Subscribe to broadcast messages to check for users with pending tells
const tellBroadcastSub = nats.subscribe(
  `broadcast.message.${tellBroadcastUUID}`,
  async (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.debug('Received broadcast.message for tell', {
        producer: 'tell',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.nick,
      });

      // Check if this user has any pending tells
      const lowercaseNick = data.nick.toLowerCase();
      const identWithNick = `${lowercaseNick}@${data.ident}`;

      // Check for both nick and nick@ident matches in a single query
      const pendingTells = findTellsByNickOrIdentStmt.all({
        nick: lowercaseNick,
        nickIdent: identWithNick,
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

          responseText += `${data.nick}: ${tell.fromUser}, ${timeDiff} ago: ${tell.message}\n`;

          // Mark as delivered
          markAsDeliveredStmt.run({
            date: new Date().toISOString(),
            id: tell.id,
          });
        }

        // Send the tells to the channel
        void sendChatMessage(nats, {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: responseText.trim(),
          trace: data.trace,
        }, metrics);
      }
    } catch (error) {
      log.error('Failed to process tell broadcast', {
        producer: 'tell',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);
natsSubscriptions.push(tellBroadcastSub);

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

// Control subscriptions for re-registering commands are now handled by registerCommand()
// Control subscriptions for re-registering broadcasts are now handled by registerBroadcast()

// Subscribe to stats.uptime and stats.emit.request
const statsSubs = registerStatsHandlers({ nats, moduleName: 'tell', startTime: moduleStartTime, version: moduleVersion, metrics });
natsSubscriptions.push(...statsSubs);

// Help information for tell commands
const tellHelp: HelpEntry[] = [
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
  {
    command: 'list-tells',
    descr: 'List your outstanding (undelivered) tells',
    params: [],
  },
];

// Register help using registerHelp helper (publishes immediately + subscribes to update requests)
const helpSubs = await registerHelp(nats, 'tell', tellHelp, metrics);
natsSubscriptions.push(...helpSubs);
