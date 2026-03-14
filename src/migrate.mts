#!/usr/bin/env node

/**
 * Tell Database Migration Utility
 *
 * This script migrates tell data from the old SQLite database format
 * to the new database schema used by the modern tell module.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { exit } from 'node:process';

interface OldTellRecord {
  index: number;
  id: string;
  dateSent: string;
  fromConnector: string;
  fromChannel: string;
  fromIdent: string;
  fromUser: string;
  toUser: string;
  platform: string;
  message: string;
  pm: number;
  delivered: number;
  dateDelivered: string | null;
}

interface NewTellRecord {
  id: string;
  dateSent: string;
  fromConnector: string;
  fromChannel: string;
  fromIdent: string;
  fromUser: string;
  toUser: string;
  platform: string;
  message: string;
  pm: number;
  delivered: number;
  dateDelivered: string | null;
}

async function migrateDatabase(
  oldDbPath: string,
  newDbPath: string
): Promise<void> {
  console.log(`Migrating tell database from ${oldDbPath} to ${newDbPath}`);

  // Check if old database exists
  if (!existsSync(oldDbPath)) {
    console.error(`Old database file not found: ${oldDbPath}`);
    exit(1);
  }

  // Open both databases
  const oldDb = new Database(oldDbPath, { readonly: true });
  const newDb = new Database(newDbPath);

  try {
    // Create the new table schema
    newDb.exec(`
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

    // Prepare insert statement for new database
    const insertStmt = newDb.prepare(`
      INSERT OR REPLACE INTO tells 
      (id, dateSent, fromConnector, fromChannel, fromIdent, fromUser, toUser, platform, message, pm, delivered, dateDelivered)
      VALUES (@id, @dateSent, @fromConnector, @fromChannel, @fromIdent, @fromUser, @toUser, @platform, @message, @pm, @delivered, @dateDelivered)
    `);

    // Read all records from old database
    const selectStmt = oldDb.prepare('SELECT * FROM tell');
    const oldRecords = selectStmt.all() as OldTellRecord[];

    console.log(`Found ${oldRecords.length} records to migrate`);

    // Begin transaction for better performance
    const insertTransaction = newDb.transaction((records: NewTellRecord[]) => {
      for (const record of records) {
        insertStmt.run(record);
      }
    });

    // Transform and insert records
    const newRecords: NewTellRecord[] = oldRecords.map((record) => ({
      id: record.id,
      dateSent: record.dateSent,
      fromConnector: record.fromConnector,
      fromChannel: record.fromChannel,
      fromIdent: record.fromIdent,
      fromUser: record.fromUser,
      toUser: record.toUser,
      platform: record.platform,
      message: record.message,
      pm: record.pm,
      delivered: record.delivered,
      dateDelivered: record.dateDelivered,
    }));

    // Insert all records in a transaction
    insertTransaction(newRecords);

    console.log(`Successfully migrated ${newRecords.length} records`);
  } catch (error) {
    console.error('Migration failed:', error);
    exit(1);
  } finally {
    oldDb.close();
    newDb.close();
  }
}

// Support for instance-specific tables
async function migrateInstanceDatabase(
  oldDbPath: string,
  instanceName: string,
  newDbPath: string
): Promise<void> {
  console.log(
    `Migrating tell database for instance ${instanceName} from ${oldDbPath} to ${newDbPath}`
  );

  // Check if old database exists
  if (!existsSync(oldDbPath)) {
    console.error(`Old database file not found: ${oldDbPath}`);
    exit(1);
  }

  // Open both databases
  const oldDb = new Database(oldDbPath, { readonly: true });
  const newDb = new Database(newDbPath);

  try {
    // Create the new table schema
    newDb.exec(`
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

    // Prepare insert statement for new database
    const insertStmt = newDb.prepare(`
      INSERT OR REPLACE INTO tells 
      (id, dateSent, fromConnector, fromChannel, fromIdent, fromUser, toUser, platform, message, pm, delivered, dateDelivered)
      VALUES (@id, @dateSent, @fromConnector, @fromChannel, @fromIdent, @fromUser, @toUser, @platform, @message, @pm, @delivered, @dateDelivered)
    `);

    // Read all records from old database instance table
    const tableName = `tell-${instanceName}`;
    const selectStmt = oldDb.prepare(`SELECT * FROM "${tableName}"`);
    const oldRecords = selectStmt.all() as OldTellRecord[];

    console.log(
      `Found ${oldRecords.length} records to migrate for instance ${instanceName}`
    );

    // Begin transaction for better performance
    const insertTransaction = newDb.transaction((records: NewTellRecord[]) => {
      for (const record of records) {
        insertStmt.run(record);
      }
    });

    // Transform and insert records
    const newRecords: NewTellRecord[] = oldRecords.map((record) => ({
      id: record.id,
      dateSent: record.dateSent,
      fromConnector: record.fromConnector,
      fromChannel: record.fromChannel,
      fromIdent: record.fromIdent,
      fromUser: record.fromUser,
      toUser: record.toUser,
      platform: record.platform,
      message: record.message,
      pm: record.pm,
      delivered: record.delivered,
      dateDelivered: record.dateDelivered,
    }));

    // Insert all records in a transaction
    insertTransaction(newRecords);

    console.log(
      `Successfully migrated ${newRecords.length} records for instance ${instanceName}`
    );
  } catch (error) {
    console.error('Migration failed:', error);
    exit(1);
  } finally {
    oldDb.close();
    newDb.close();
  }
}

// Main execution
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage:');
    console.log('  migrate.mts <old-db-path> <new-db-path> [instance-name]');
    console.log('');
    console.log('Examples:');
    console.log('  migrate.mts ../old-eevee-bot/db/tell.sqlite ./tell.sqlite');
    console.log(
      '  migrate.mts ../old-eevee-bot/db/tell.sqlite ./tell-instance1.sqlite instance1'
    );
    exit(1);
  }

  const oldDbPath = args[0];
  const newDbPath = args[1];
  const instanceName = args[2];

  if (instanceName) {
    await migrateInstanceDatabase(oldDbPath, instanceName, newDbPath);
  } else {
    await migrateDatabase(oldDbPath, newDbPath);
  }

  console.log('Migration completed successfully!');
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
