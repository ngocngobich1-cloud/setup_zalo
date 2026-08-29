#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { resolveDatabasePaths } from "../database-path.js";
import { migrateP9ZaloUidProfile, validateLegacyOwnerUid } from "./p9-zalo-uid-profile.js";

function ownerUidFromArgs(args) {
  let rawOwnerUid;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--owner-uid") {
      if (rawOwnerUid !== undefined || index + 1 >= args.length) {
        throw new Error("Cach dung: node lib/migrations/chuyen-doi-p9-legacy-owner.js --owner-uid <UID>");
      }
      rawOwnerUid = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--owner-uid=")) {
      if (rawOwnerUid !== undefined) {
        throw new Error("Chi duoc cung cap --owner-uid mot lan.");
      }
      rawOwnerUid = arg.slice("--owner-uid=".length);
    } else {
      throw new Error(`Tham so khong duoc ho tro: ${arg}`);
    }
  }
  if (rawOwnerUid === undefined) {
    throw new Error("Thieu --owner-uid; one-shot migration khong co owner mac dinh.");
  }
  return validateLegacyOwnerUid(rawOwnerUid);
}

function openDatabase(file) {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
}

function databaseAdapter(connection) {
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => {
      connection.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve(this);
      });
    }),
    all: (sql, params = []) => new Promise((resolve, reject) => {
      connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => {
      connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    }),
    close: () => new Promise((resolve, reject) => {
      connection.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export async function main(args = process.argv.slice(2)) {
  // Argument validation is deliberately before opening SQLite: invalid input
  // cannot create, lock or mutate a database.
  const legacyOwnerUid = ownerUidFromArgs(args);
  const { dbPath } = resolveDatabasePaths();
  const connection = await openDatabase(dbPath);
  const db = databaseAdapter(connection);
  try {
    const report = await migrateP9ZaloUidProfile(db, { legacyOwnerUid });
    console.log("P9_LEGACY_OWNER_MIGRATION = PASS");
    console.log(`OWNER_UID = ${legacyOwnerUid}`);
    console.log(`AI_MIGRATED = ${report.aiMigrated ? "YES" : "NO"}`);
    console.log(`TRAINING_MIGRATED = ${report.trainingMigrated ? "YES" : "NO"}`);
  } finally {
    await db.close();
  }
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`P9_LEGACY_OWNER_MIGRATION = FAIL\n${error.message}`);
    process.exitCode = 1;
  });
}
