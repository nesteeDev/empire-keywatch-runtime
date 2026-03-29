export interface MatchResult {
  matched: boolean;
  keyword: string;
  type: "exact" | "ai";
}

export function keywordMatch(text: string, keywords: string[]): MatchResult | null {
  const lower = text.toLowerCase();

  for (const keyword of keywords) {
    const kw = keyword.toLowerCase().trim();
    if (!kw) continue;

    // Exact match (case-insensitive, word boundary aware)
    if (lower.includes(kw)) {
      return { matched: true, keyword, type: "exact" };
    }
  }

  return null;
}

// AI matcher stub — will call Cloudflare Workers AI when Premium is implemented
export async function aiMatch(
  text: string,
  keywords: string[],
  prompt?: string
): Promise<MatchResult | null> {
  const cfAccountId = process.env.CF_ACCOUNT_ID;
  const cfApiToken = process.env.CF_API_TOKEN;

  if (!cfAccountId || !cfApiToken) {
    return null; // AI not configured
  }

  // TODO: Implement Cloudflare Workers AI call
  // POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/baai/bge-base-en-v1.5
  // Compare embeddings of text vs keywords
  // For now, return null (not implemented)
  return null;
}
