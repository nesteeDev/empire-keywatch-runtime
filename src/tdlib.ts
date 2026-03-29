import { TDLib } from "tdl-tdlib-addon";
import { Client } from "tdl";
import path from "path";
import fs from "fs";
import { keywordMatch } from "./matcher";
import { sendAlert, sendLoginStatus } from "./alert";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TG_API_ID = parseInt(process.env.TG_API_ID || "30388596");
const TG_API_HASH = process.env.TG_API_HASH || "a6f9e33394ef9a6f42ed086f205e7b8e";

fs.mkdirSync(DATA_DIR, { recursive: true });

let client: Client | null = null;
let monitoredGroups: Map<string, string> = new Map(); // groupId -> username
let keywords: string[] = [];
let loggedIn = false;

// State persistence
const STATE_FILE = path.join(DATA_DIR, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      monitoredGroups = new Map(Object.entries(state.groups || {}));
      keywords = state.keywords || [];
      console.log(`Loaded state: ${monitoredGroups.size} groups, ${keywords.length} keywords`);
    }
  } catch (err) {
    console.error("Failed to load state:", err);
  }
}

function saveState() {
  try {
    const state = {
      groups: Object.fromEntries(monitoredGroups),
      keywords,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

export function isLoggedIn(): boolean {
  return loggedIn;
}

export async function initTDLib(): Promise<Client> {
  client = new Client(new TDLib(), {
    apiId: TG_API_ID,
    apiHash: TG_API_HASH,
    databaseDirectory: path.join(DATA_DIR, "tdlib_db"),
    filesDirectory: path.join(DATA_DIR, "tdlib_files"),
  });

  loadState();

  // Handle updates
  client.on("update", async (update: any) => {
    if (update._ === "updateNewMessage") {
      await handleNewMessage(update.message);
    }
  });

  client.on("error", (err: any) => {
    console.error("TDLib error:", err);
  });

  // Try to login with existing session
  try {
    await client.login(() => ({
      getPhoneNumber: async (retry) => {
        if (retry) throw new Error("Need phone number from orchestrator");
        // This will be called only if no session exists
        // We need to wait for orchestrator to send phone number
        throw new Error("NEED_PHONE");
      },
      getAuthCode: async (retry) => {
        if (retry) throw new Error("Need auth code from orchestrator");
        throw new Error("NEED_CODE");
      },
      getPassword: async (_hint, retry) => {
        if (retry) throw new Error("Need 2FA password from orchestrator");
        throw new Error("NEED_PASSWORD");
      },
    }));
    loggedIn = true;
    console.log("TDLib logged in with existing session");
    await sendLoginStatus("logged_in");
  } catch (err: any) {
    if (err.message === "NEED_PHONE") {
      console.log("No session found. Waiting for login commands from orchestrator...");
      await sendLoginStatus("need_phone");
    } else {
      console.log("Login pending, waiting for orchestrator commands...");
    }
  }

  return client;
}

// Login commands from orchestrator
export async function handleLoginPhone(phone: string): Promise<void> {
  if (!client) return;
  try {
    await client.invoke({
      _: "setAuthenticationPhoneNumber",
      phone_number: phone,
    });
    await sendLoginStatus("need_code");
  } catch (err: any) {
    console.error("setAuthenticationPhoneNumber error:", err);
    await sendLoginStatus("error", err.message);
  }
}

export async function handleLoginCode(code: string): Promise<void> {
  if (!client) return;
  try {
    await client.invoke({
      _: "checkAuthenticationCode",
      code,
    });
    loggedIn = true;
    await sendLoginStatus("logged_in");
    console.log("Login successful!");
  } catch (err: any) {
    if (err.message?.includes("PASSWORD")) {
      await sendLoginStatus("need_password");
    } else {
      console.error("checkAuthenticationCode error:", err);
      await sendLoginStatus("error", err.message);
    }
  }
}

export async function handleLoginPassword(password: string): Promise<void> {
  if (!client) return;
  try {
    await client.invoke({
      _: "checkAuthenticationPassword",
      password,
    });
    loggedIn = true;
    await sendLoginStatus("logged_in");
    console.log("Login with 2FA successful!");
  } catch (err: any) {
    console.error("checkAuthenticationPassword error:", err);
    await sendLoginStatus("error", err.message);
  }
}

// Group management
export async function addGroup(username: string): Promise<void> {
  if (!client || !loggedIn) return;

  try {
    const chat = await client.invoke({
      _: "searchPublicChat",
      username: username.replace(/^@/, ""),
    });

    // Join the chat to receive updates
    await client.invoke({
      _: "joinChat",
      chat_id: (chat as any).id,
    });

    monitoredGroups.set(String((chat as any).id), username);
    saveState();
    console.log(`Joined group @${username} (id: ${(chat as any).id})`);
  } catch (err) {
    console.error(`Failed to join @${username}:`, err);
  }
}

export async function removeGroup(username: string): Promise<void> {
  if (!client || !loggedIn) return;

  // Find group ID by username
  for (const [id, name] of monitoredGroups) {
    if (name === username || name === username.replace(/^@/, "")) {
      try {
        await client.invoke({
          _: "leaveChat",
          chat_id: parseInt(id),
        });
      } catch (err) {
        console.error(`Failed to leave @${username}:`, err);
      }
      monitoredGroups.delete(id);
      saveState();
      console.log(`Left group @${username}`);
      return;
    }
  }
}

export function updateKeywords(newKeywords: string[]): void {
  keywords = newKeywords;
  saveState();
  console.log(`Keywords updated: ${keywords.join(", ")}`);
}

export function syncState(groups: string[], kws: string[]): void {
  // Sync keywords
  keywords = kws;

  // Sync groups: join any missing, leave any extra
  // For now just update state — actual join/leave happens via commands
  saveState();
}

// Message handler
async function handleNewMessage(message: any): Promise<void> {
  if (!message?.content || message.content._ !== "messageText") return;

  const chatId = String(message.chat_id);

  // Only process messages from monitored groups
  if (!monitoredGroups.has(chatId)) return;

  const text = message.content.text?.text;
  if (!text) return;

  // Don't process our own messages
  if (message.is_outgoing) return;

  // Match keywords
  const match = keywordMatch(text, keywords);
  if (!match) return;

  const groupUsername = monitoredGroups.get(chatId) || chatId;

  // Get sender name
  let senderName = "";
  try {
    if (message.sender_id?._ === "messageSenderUser") {
      const userInfo = await client!.invoke({
        _: "getUser",
        user_id: message.sender_id.user_id,
      }) as any;
      senderName = [userInfo.first_name, userInfo.last_name].filter(Boolean).join(" ");
    }
  } catch {
    // Ignore — sender name is optional
  }

  // Build message link
  let messageLink = "";
  if (groupUsername && message.id) {
    messageLink = `https://t.me/${groupUsername.replace(/^@/, "")}/${message.id}`;
  }

  console.log(`Match in @${groupUsername}: "${text.slice(0, 50)}..." — keyword: ${match.keyword}`);

  await sendAlert({
    text,
    groupUsername,
    groupId: chatId,
    keywordMatched: match.keyword,
    messageLink,
    senderName,
  });
}
