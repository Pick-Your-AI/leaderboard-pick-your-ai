import pg from "pg";

export function localDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const localDatabase = /_(dev|test)$/.test(url.pathname.slice(1));
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (!localHost || !localDatabase) {
    throw new Error("Database scaffold commands require a local host and a database name ending in _dev or _test");
  }
  return value;
}

export function connectLocalDatabase() {
  return new pg.Client({ connectionString: localDatabaseUrl() });
}
