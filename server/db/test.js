import { pool } from "./database.js";

try {
  const result = await pool.query("SELECT NOW() AS time");

  console.log("PostgreSQL connected!");
  console.log("Database time:", result.rows[0].time);
} catch (error) {
  console.error("PostgreSQL connection failed:");
  console.error(error);
} finally {
  await pool.end();
}