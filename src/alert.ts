const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:3100";
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN || "";

export async function sendAlert(data: {
  text: string;
  groupUsername: string;
  groupId: string;
  keywordMatched: string;
  messageLink?: string;
  senderName?: string;
}): Promise<void> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNTIME_TOKEN}`,
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      console.error(`Alert failed (${res.status}):`, await res.text());
    }
  } catch (err) {
    console.error("Failed to send alert:", err);
  }
}

export async function sendLoginStatus(status: string, message?: string): Promise<void> {
  try {
    await fetch(`${ORCHESTRATOR_URL}/api/login-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNTIME_TOKEN}`,
      },
      body: JSON.stringify({ status, message }),
    });
  } catch (err) {
    console.error("Failed to send login status:", err);
  }
}
