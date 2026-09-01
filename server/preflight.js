// Runtime dependency preflight for Google API stack.
// Fails early with an actionable message instead of a deep gaxios resolution error.
try {
  await import("node-fetch");
} catch (error) {
  console.error("[PREFLIGHT] node-fetch is missing. Run `npm i` from the project root.");
  throw error;
}

try {
  await import("gaxios");
} catch (error) {
  console.error("[PREFLIGHT] gaxios could not be loaded.");
  throw error;
}
