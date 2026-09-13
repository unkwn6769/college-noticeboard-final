import { Client } from "pg";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "college-noticeboard-api",
      });
    }

    if (url.pathname === "/health/db") {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      try {
        await client.connect();

        const result = await client.query(`
          SELECT
            NOW() AS now,
            current_database() AS database_name
        `);

        return Response.json({
          ok: true,
          database: result.rows[0],
        });
      } catch (error) {
        console.error("Database health check failed:", error);

        return Response.json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          { status: 500 },
        );
      } finally {
        await client.end().catch(() => {});
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch): Promise<void> {
    for (const message of batch.messages) {
      console.log(
        `migration queue message ${message.id}: ${JSON.stringify(message.body)}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;
