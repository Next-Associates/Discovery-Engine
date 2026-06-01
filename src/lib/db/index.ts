import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const dbDir = path.join(DATA_DIR, 'data');
const dbPath = path.join(dbDir, 'db.sqlite');

try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (err) {
  console.error('Could not create database directory:', err);
}

const sqlite = new Database(dbPath);
const db = drizzle(sqlite, {
  schema: schema,
});

export default db;
