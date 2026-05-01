import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { config } from "./config.js";
import * as schema from "./schema.js";

if (!config.database.url) {
  throw new Error("DATABASE_URL is required for PostgreSQL.");
}

const pool = new Pool({
  connectionString: config.database.url,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(pool, { schema });

export async function ensureDatabaseSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'local',
      provider_sub TEXT,
      password_hash TEXT,
      salt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS authorization_codes (
      code TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_provider TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      state TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}
