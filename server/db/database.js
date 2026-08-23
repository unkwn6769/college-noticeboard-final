import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "college_noticeboard",
  user: "badrisatwik",
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error);
});