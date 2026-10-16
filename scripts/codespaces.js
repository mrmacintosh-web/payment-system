import { codespacesOrigin } from "../lib/origin.js";

// Derive the exact trusted address from GitHub's environment, not request headers.
// Override stale PUBLIC_ORIGIN settings only for this explicit startup command.
process.env.PUBLIC_ORIGIN = codespacesOrigin();
process.env.HOST = "0.0.0.0";
console.log(`Codespaces browser address: ${process.env.PUBLIC_ORIGIN}`);
console.log("Open this port's browser address from the Codespaces Ports tab.");
await import("./demo.js");
