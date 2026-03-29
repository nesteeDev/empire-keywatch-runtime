import {
  initTDLib,
  isLoggedIn,
  addGroup,
  removeGroup,
  updateKeywords,
  handleLoginPhone,
  handleLoginCode,
  handleLoginPassword,
  syncState,
} from "./tdlib";
import { pullCommands, sendHeartbeat } from "./pull";

let pullInterval = 600; // seconds, default free tier

async function main() {
  console.log("KeyWatch Runtime starting...");

  // Initialize TDLib
  await initTDLib();

  // Start heartbeat loop (every 2 min)
  setInterval(async () => {
    const result = await sendHeartbeat();
    if (result) {
      pullInterval = result.pullInterval;
    }
  }, 2 * 60 * 1000);

  // Send first heartbeat immediately
  const firstBeat = await sendHeartbeat();
  if (firstBeat) {
    pullInterval = firstBeat.pullInterval;
  }

  // Start pull loop
  async function doPull() {
    const response = await pullCommands();

    if (response) {
      // Update pull interval from config
      if (response.config.pullInterval) {
        pullInterval = response.config.pullInterval;
      }

      // Sync state
      syncState(response.groups, response.keywords);

      // Process commands
      for (const cmd of response.commands) {
        console.log(`Command: ${cmd.command} ${cmd.payload}`);

        switch (cmd.command) {
          case "add_group":
            await addGroup(cmd.payload);
            break;
          case "remove_group":
            await removeGroup(cmd.payload);
            break;
          case "update_keywords":
            updateKeywords(cmd.payload.split(",").map((s: string) => s.trim()));
            break;
          case "login_phone":
            await handleLoginPhone(cmd.payload);
            break;
          case "login_code":
            await handleLoginCode(cmd.payload);
            break;
          case "login_password":
            await handleLoginPassword(cmd.payload);
            break;
          case "shutdown":
            console.log("Shutdown command received. Exiting...");
            process.exit(0);
            break;
          default:
            console.warn(`Unknown command: ${cmd.command}`);
        }
      }
    }

    // Schedule next pull
    setTimeout(doPull, pullInterval * 1000);
  }

  // First pull after 5 seconds (let TDLib initialize)
  setTimeout(doPull, 5000);

  console.log(`KeyWatch Runtime running. Pull interval: ${pullInterval}s`);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
