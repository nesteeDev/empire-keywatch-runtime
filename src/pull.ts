const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:3100";
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN || "";

export interface PullResponse {
  commands: Array<{ id: number; command: string; payload: string }>;
  config: {
    plan: string;
    pullInterval: number;
    groupsLimit: number;
    keywordsLimit: number;
  };
  groups: string[];
  keywords: string[];
}

export async function pullCommands(): Promise<PullResponse | null> {
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/api/pull?token=${encodeURIComponent(RUNTIME_TOKEN)}`
    );

    if (!res.ok) {
      console.error(`Pull failed (${res.status}):`, await res.text());
      return null;
    }

    return await res.json() as PullResponse;
  } catch (err) {
    console.error("Pull error:", err);
    return null;
  }
}

export async function sendHeartbeat(): Promise<{ plan: string; pullInterval: number } | null> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/heartbeat`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${RUNTIME_TOKEN}` },
    });

    if (!res.ok) return null;
    return await res.json() as any;
  } catch {
    return null;
  }
}
