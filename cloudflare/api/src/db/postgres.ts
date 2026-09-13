import { Client } from "pg";

export async function withDatabase<T>(
  env: Env,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });

  await client.connect();

  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function withTransaction<T>(
  env: Env,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  return withDatabase(env, async (client) => {
    await client.query("BEGIN");

    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}
