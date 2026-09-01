import { pool } from "./db/database.js";

async function runTest() {
  const accountId = 'test-account-123';
  const accountKey = String(accountId);

  console.log("Worker A: Acquiring lock...");
  const clientA = await pool.connect();
  await clientA.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [accountKey]);
  console.log("Worker A: Lock acquired. Simulating work...");

  let workerB_acquired = false;

  const promiseB = (async () => {
    console.log("Worker B: Attempting to acquire lock...");
    const clientB = await pool.connect();
    
    // We will use a timeout to see if B is blocked
    const start = Date.now();
    await clientB.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [accountKey]);
    const elapsed = Date.now() - start;
    
    workerB_acquired = true;
    console.log(`Worker B: Lock acquired after ${elapsed}ms.`);
    
    await clientB.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [accountKey]);
    clientB.release();
  })();

  // Wait a bit to ensure B is waiting
  await new Promise(r => setTimeout(r, 1000));
  
  console.log(`Main: Is Worker B blocked? ${!workerB_acquired}`);
  
  console.log("Worker A: Releasing lock...");
  await clientA.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [accountKey]);
  clientA.release();

  await promiseB;
  console.log("Test complete.");
}

runTest().catch(console.error).finally(() => pool.end());
