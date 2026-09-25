// @ts-nocheck
/* Test script to verify native schema imports */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

async function test() {
  const file = `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/8710fa53f868dfbb80a7114b087a32fd5dfedc13ab0fffc0f295b3f11c8a1fe4.sqlite`;
  const sqlite = new Database(file);
  const db = drizzle(sqlite);
  
  const tables = db.all(db.run('SELECT name FROM sqlite_master WHERE type="table";'));
  console.log("Tables:", tables);
}
test();
