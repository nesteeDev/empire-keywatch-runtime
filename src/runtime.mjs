import 'dotenv/config'
import tdl from 'tdl'
import prebuilt from 'prebuilt-tdlib'
import fs from 'fs'
import path from 'path'
import {
  initArAccount,
  submitArCode,
  submitArPassword,
  closeArAccount,
  sendDmViaArClient,
  restoreArClients,
  getArClientStatus,
} from './ar-clients.mjs'

tdl.configure({ tdjson: prebuilt.getTdjson() })

const TOKEN = process.env.RUNTIME_TOKEN || ''
const ORCH = process.env.ORCHESTRATOR_URL || ''
const DATA = process.env.DATA_DIR || './data'

console.log('Starting KeyWatch Runtime...')
console.log('Orchestrator:', ORCH)

// --- Session transfer: download TDLib session from pool for Railway migration ---
const SESSION_URL = process.env.SESSION_URL || ''
const SESSION_SECRET = process.env.SESSION_SECRET || ''
if (SESSION_URL && !fs.existsSync(path.join(DATA, 'tdlib_db', 'db.sqlite'))) {
  console.log('[SESSION] Downloading TDLib session from pool...')
  try {
    const res = await fetch(SESSION_URL, {
      headers: SESSION_SECRET ? { 'Authorization': 'Bearer ' + SESSION_SECRET } : {},
    })
    if (res.ok) {
      const tarData = Buffer.from(await res.arrayBuffer())
      fs.mkdirSync(path.join(DATA, 'tdlib_db'), { recursive: true })
      fs.writeFileSync('/tmp/session.tar.gz', tarData)
      const { execSync } = await import('child_process')
      execSync(`tar xzf /tmp/session.tar.gz -C "${path.join(DATA, 'tdlib_db')}"`)
      fs.unlinkSync('/tmp/session.tar.gz')
      console.log('[SESSION] TDLib session restored from pool!')
    } else {
      console.error('[SESSION] Download failed:', res.status, await res.text().catch(() => ''))
    }
  } catch (e) {
    console.error('[SESSION] Failed to download session:', e.message)
  }
}

const client = tdl.createClient({
  apiId: parseInt(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  databaseDirectory: DATA + '/tdlib_db',
  filesDirectory: DATA + '/tdlib_files',
})

const RUNTIME_VERSION = '1.4.0'

let keywords = []
let monitoredChats = new Map() // chatId -> title
let filterMode = 'keywords' // user-level default (backward compat)
let promptText = ''
let anthropicKey = ''
let aiThreshold = 0.45
let useCandidate = false
let minMessageLength = 10 // configurable via /minlength
let haikuKey = ''          // built-in Haiku key from orchestrator
let haikuRemaining = 0     // checks remaining (daily for premium, lifetime for free)
let hasOwnKey = false       // user has their own Anthropic key
let haikuUsedSession = 0   // track usage this session to report back
let haikuModel = 'claude-haiku-4-5-20251001' // configurable from orchestrator

// --- Per-profile data ---
let profilesData = []       // from pull: [{id, name, mode, keywords, prompt, threshold, groupIds}]
let profileEmbeddings = new Map() // profileId -> Map<keyword, embedding>

// --- Orchestrator communication ---

async function orchPost(path, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(ORCH + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        body: JSON.stringify(body),
      })
      if (res.ok) return true
      if (res.status >= 400 && res.status < 500) return false // client error, don't retry
    } catch (e) {
      if (i === retries - 1) { console.error('orch error:', e.message); return false }
    }
    await new Promise(r => setTimeout(r, (i + 1) * 2000)) // 2s, 4s, 6s
  }
  return false
}

async function orchGet(path) {
  try {
    const res = await fetch(ORCH + path, {
      headers: { 'Authorization': 'Bearer ' + TOKEN },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) { console.error('orch error:', e.message); return null }
}

// --- Cloudflare Workers AI embeddings (for keywords mode) ---

let cfAccountId = process.env.CF_ACCOUNT_ID || ''
let cfApiToken = process.env.CF_API_TOKEN || ''
let keywordEmbeddings = new Map() // keyword -> embedding vector (global cache for backward compat)
let embeddingsFailed = false // fallback flag when CF quota exceeded

async function getEmbedding(text) {
  // Try proxy first (orchestrator handles quota), fallback to direct CF
  if (ORCH && TOKEN) {
    try {
      const res = await fetch(ORCH + '/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        body: JSON.stringify({ texts: [text] }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.fallback) {
          // Quota exceeded or CF error — fallback to exact match
          if (data.reason === 'quota_exceeded') {
            console.log('[EMB] Quota exceeded (' + data.used + '/' + data.limit + '), falling back to exact match')
            embeddingsFailed = true
          }
          return null
        }
        return data.embeddings?.[0] || null
      }
    } catch (e) {
      // Proxy failed — try direct CF
    }
  }

  // Direct CF (if user has own keys)
  if (!cfAccountId || !cfApiToken) return null
  try {
    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + cfAccountId + '/ai/run/@cf/baai/bge-m3',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfApiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [text] }),
      }
    )
    if (!res.ok) {
      const err = await res.text()
      if (err.includes('rate') || err.includes('quota') || err.includes('limit')) {
        console.log('[EMB] CF quota exceeded, falling back to exact match')
        embeddingsFailed = true
      }
      return null
    }
    const data = await res.json()
    return data.result?.data?.[0] || null
  } catch (e) {
    console.error('[EMB] error:', e.message)
    return null
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Cache embeddings for each keyword individually (global — used for backward compat)
async function updateKeywordEmbeddings() {
  if (!cfAccountId && !cfApiToken && !ORCH) return
  if (keywords.length === 0) return
  embeddingsFailed = false
  console.log('[EMB] computing embeddings for', keywords.length, 'keywords...')

  let cached = 0
  for (const kw of keywords) {
    if (keywordEmbeddings.has(kw)) { cached++; continue }
    const emb = await getEmbedding(kw)
    if (emb) {
      keywordEmbeddings.set(kw, emb)
    } else if (embeddingsFailed) {
      break // stop if quota exceeded
    }
  }

  // Remove old keywords no longer in list
  for (const [k] of keywordEmbeddings) {
    if (!keywords.includes(k)) keywordEmbeddings.delete(k)
  }

  console.log('[EMB]', keywordEmbeddings.size, 'embeddings cached,', cached, 'reused')
}

// Compute per-profile embeddings (reuses global cache when possible)
async function updateProfileEmbeddings() {
  if (!cfAccountId && !cfApiToken && !ORCH) return
  if (profilesData.length === 0) return
  embeddingsFailed = false

  const allKws = new Set()
  for (const p of profilesData) {
    for (const kw of p.keywords) allKws.add(kw)
  }

  console.log('[EMB] computing profile embeddings for', allKws.size, 'unique keywords...')

  // Build/update global cache for all keywords across profiles
  let cached = 0
  for (const kw of allKws) {
    if (keywordEmbeddings.has(kw)) { cached++; continue }
    const emb = await getEmbedding(kw)
    if (emb) {
      keywordEmbeddings.set(kw, emb)
    } else if (embeddingsFailed) {
      break
    }
  }

  // Remove keywords no longer in any profile
  for (const [k] of keywordEmbeddings) {
    if (!allKws.has(k)) keywordEmbeddings.delete(k)
  }

  // Build per-profile embedding maps (references to global cache)
  profileEmbeddings.clear()
  for (const p of profilesData) {
    const map = new Map()
    for (const kw of p.keywords) {
      const emb = keywordEmbeddings.get(kw)
      if (emb) map.set(kw, emb)
    }
    profileEmbeddings.set(p.id, map)
  }

  console.log('[EMB]', keywordEmbeddings.size, 'embeddings cached,', cached, 'reused,', profileEmbeddings.size, 'profiles')
}

// Match message against a specific profile's keyword embeddings
async function embeddingKeywordMatchForProfile(text, profileId, threshold) {
  const profEmbs = profileEmbeddings.get(profileId)
  if (!profEmbs || profEmbs.size === 0 || embeddingsFailed) return null

  const msgEmb = await getEmbedding(text)
  if (!msgEmb) return null

  let bestScore = 0
  let bestKeyword = null

  for (const [kw, kwEmb] of profEmbs) {
    const score = cosineSimilarity(msgEmb, kwEmb)
    if (score > bestScore) {
      bestScore = score
      bestKeyword = kw
    }
  }

  if (bestScore >= threshold && bestKeyword) {
    console.log('[EMB] MATCH', bestKeyword, 'score=' + bestScore.toFixed(3), ':', text.slice(0, 50))
    return bestKeyword + ' (' + bestScore.toFixed(2) + ')'
  }

  return null
}

// Legacy: match against global keyword embeddings (backward compat)
async function embeddingKeywordMatch(text) {
  if (embeddingsFailed || keywordEmbeddings.size === 0) return null

  const msgEmb = await getEmbedding(text)
  if (!msgEmb) return null

  const threshold = aiThreshold
  let bestScore = 0
  let bestKeyword = null

  for (const [kw, kwEmb] of keywordEmbeddings) {
    const score = cosineSimilarity(msgEmb, kwEmb)
    if (score > bestScore) {
      bestScore = score
      bestKeyword = kw
    }
  }

  if (bestScore >= threshold && bestKeyword) {
    console.log('[EMB] MATCH', bestKeyword, 'score=' + bestScore.toFixed(3), ':', text.slice(0, 50))
    return bestKeyword + ' (' + bestScore.toFixed(2) + ')'
  }

  return null
}

// Exact keyword match against a specific keyword list
function exactKeywordMatchList(text, kwList) {
  const lower = text.toLowerCase()
  for (const kw of kwList) {
    const kwLower = kw.toLowerCase()
    let pos = 0
    while (true) {
      const idx = lower.indexOf(kwLower, pos)
      if (idx === -1) break

      const charBefore = idx > 0 ? lower[idx - 1] : ' '
      const charAfter = idx + kwLower.length < lower.length ? lower[idx + kwLower.length] : ' '

      const isLetterBefore = /\p{L}/u.test(charBefore)
      const isLetterAfter = /\p{L}/u.test(charAfter)

      if (!isLetterBefore && !isLetterAfter) return kw

      pos = idx + 1
    }
  }
  return null
}

// Exact keyword match (fallback when no CF or quota exceeded) — legacy global
function exactKeywordMatch(text) {
  return exactKeywordMatchList(text, keywords)
}

// --- Anthropic Haiku (for prompt mode) ---

// Returns: { match: 'AI: prompt match' | 'no' | null, autoResponse?: string }
// When autoresponseMode is set, uses combined prompt for check + response in one call
async function haikuMatchWithPrompt(text, prompt, autoresponseOpts = null) {
  const key = anthropicKey || haikuKey
  if (!key || !prompt) return { match: null }
  if (!anthropicKey && haikuRemaining <= 0) {
    console.log('[HAIKU] limit reached')
    return { match: null }
  }

  // Pre-track usage (before API call to survive crashes)
  if (!anthropicKey) {
    haikuRemaining--
  }
  haikuUsedSession++
  orchPost('/api/haiku-usage', { count: 1 }).catch(() => {})

  // Build prompt based on whether autoresponse is enabled
  const wantResponse = autoresponseOpts && autoresponseOpts.mode !== 'off'
  let userContent, maxTokens

  if (wantResponse) {
    const templateLine = autoresponseOpts.template
      ? `\nTone/context: ${autoresponseOpts.template}`
      : ''
    const isReferral = autoresponseOpts.strategy === 'referral' && autoresponseOpts.referral
    const replyRules = isReferral
      ? `Reply rules:
- Write in the SAME LANGUAGE as the original message
- Recommend @${autoresponseOpts.referral} as someone who can help with this topic
- Use a polite, slightly formal greeting: "Здравствуйте, по этой теме может помочь @user" / "Доброго дня, з цього питання може допомогти @user" / "Hello, @user can help with this topic"
- Sound like a real human writing a polite DM, not a bot
- NEVER start with "Привет" — use "Здравствуйте" / "Доброго дня" / "Добрий день" / "Hello" / "Good day" instead
- NO emojis, NO exclamation marks, NO filler phrases${templateLine}`
      : `Reply rules:
- Write in the SAME LANGUAGE as the original message
- Write like a real person, not a corporate bot or AI assistant
- Use a polite, slightly formal greeting: "Здравствуйте, могу помочь с X" / "Доброго дня, можу допомогти з X" / "Hello, I can help with X"
- NEVER start with "Привет" — use "Здравствуйте" / "Доброго дня" / "Добрий день" / "Hello" / "Good day" instead
- Ask a clarifying question to start a conversation
- NO emojis, NO exclamation marks, NO filler phrases like "Отлично!", "Great!", "I'd be happy to"
- Sound like a polite, real human${templateLine}`
    userContent = `Does this message match the following criteria? The message can be in ANY language — match by meaning, not language.

Criteria: ${prompt}

Message: ${text}

Answer YES or NO. If YES, also write a short DM reply to the message author.

${replyRules}

Format:
MATCH: YES or NO
RESPONSE: [only if YES — the DM text, 1-2 sentences max]`
    maxTokens = 200
  } else {
    userContent = `Does this message match the following criteria? The message can be in ANY language — match by meaning, not language. Answer ONLY "YES" or "NO".\n\nCriteria: ${prompt}\n\nMessage: ${text}`
    maxTokens = 5
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: haikuModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: AbortSignal.timeout(15000), // 15s max — don't stall runtime on slow/hanging API
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[HAIKU] error:', res.status, err.slice(0, 100))
      if (res.status === 401) {
        if (anthropicKey) {
          await orchPost('/api/login-status', { status: 'error', message: 'Anthropic API key is invalid. Check /setupai → Anthropic.' })
          anthropicKey = ''
        }
      }
      return { match: null }
    }

    const data = await res.json()
    const aiText = data.content?.[0]?.text?.trim() || ''

    if (wantResponse) {
      // Parse combined response (with fallback to simple YES check)
      const matchLine = /MATCH:\s*(YES|NO)/i.exec(aiText)
      const isMatch = matchLine
        ? matchLine[1].toUpperCase() === 'YES'
        : aiText.toUpperCase().startsWith('YES') // fallback if AI skips MATCH: prefix
      const responseLine = /RESPONSE:\s*(.+)/s.exec(aiText)
      const autoResponse = responseLine?.[1]?.trim() || null
      console.log('[HAIKU]', isMatch ? 'MATCH' : 'no match', ':', text.slice(0, 50), '-> AR:', autoResponse?.slice(0, 50) || 'none')
      return { match: isMatch ? 'AI: prompt match' : 'no', autoResponse: isMatch ? autoResponse : null }
    } else {
      const answer = aiText.toUpperCase()
      const isMatch = answer.startsWith('YES')
      console.log('[HAIKU]', isMatch ? 'MATCH' : 'no match', ':', text.slice(0, 50), '->', answer)
      return { match: isMatch ? 'AI: prompt match' : 'no' }
    }
  } catch (e) {
    console.error('[HAIKU] error:', e.message)
    return { match: null }
  }
}

// Legacy wrapper using global promptText
async function haikuMatch(text) {
  const result = await haikuMatchWithPrompt(text, promptText)
  return result.match
}

// --- Per-profile message handler ---

function getProfilesForChat(chatId) {
  if (profilesData.length === 0) return []
  const matching = profilesData.filter(p => p.groupIds.includes(chatId))
  if (matching.length > 0) return matching
  // Fallback: default profile
  const def = profilesData.find(p => p.name === 'default')
  return def ? [def] : []
}

// --- Message deduplication ---
const recentMessages = new Map() // "chatId:msgId" -> timestamp
const DEDUP_TTL = 5 * 60 * 1000  // 5 minutes

function isDuplicate(chatId, msgId) {
  const key = chatId + ':' + msgId
  const now = Date.now()
  // Cleanup old entries every check (cheap — map is small)
  if (recentMessages.size > 500) {
    for (const [k, ts] of recentMessages) {
      if (now - ts > DEDUP_TTL) recentMessages.delete(k)
    }
  }
  if (recentMessages.has(key)) return true
  recentMessages.set(key, now)
  return false
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now()
  for (const [k, ts] of recentMessages) {
    if (now - ts > DEDUP_TTL) recentMessages.delete(k)
  }
}, 60000)

// --- Combined message handler ---

// Temporary: log all update types to debug missing messages
let debugUpdateCounter = 0
client.on('update', async (update) => {
  // Log every 100th non-message update + ALL message updates for monitored chats
  if (update._ === 'updateNewMessage') {
    const m = update.message
    if (m) console.log(`[UPD] newMsg chat=${m.chat_id} chatStr="${String(m.chat_id)}" monitored=${monitoredChats.has(String(m.chat_id))} keys=[${[...monitoredChats.keys()].join(',')}] outgoing=${m.is_outgoing} type=${m.content?._}`)
  } else if (debugUpdateCounter++ % 200 === 0) {
    console.log(`[UPD] ${update._}`)
  }

  if (update._ !== 'updateNewMessage') return
  const msg = update.message
  if (!msg || msg.is_outgoing) return

  // Extract text: from messageText or caption of media messages
  let text = ''
  const contentType = msg.content?._
  if (contentType === 'messageText') {
    text = msg.content.text.text
  } else if (msg.content?.caption?.text) {
    // Photo, document, video, voice, audio — have caption
    text = msg.content.caption.text
  }
  if (!text) return

  // Deduplication: skip if we already processed this message
  if (isDuplicate(String(msg.chat_id), msg.id)) {
    console.log(`[DEDUP] skip chat=${msg.chat_id} msg=${msg.id}`)
    return
  }

  const chatId = String(msg.chat_id)

  // Debug: log first message from any chat to see chat_id format
  if (!monitoredChats.has(chatId)) {
    if (text.length > 5) {
      console.log(`[MSG] chat=${chatId} monitored=${[...monitoredChats.keys()].join(',')} text="${text.slice(0,30)}"`)
    }
    return
  }
  if (text.length < minMessageLength) {
    console.log(`[SKIP] minLen chat=${chatId} len=${text.length} min=${minMessageLength}`)
    return
  }

  // --- Per-profile path (new) ---
  if (profilesData.length > 0 && useCandidate) {
    const profiles = getProfilesForChat(chatId)
    console.log(`[PROFILE] chat=${chatId} profiles=${profiles.length} profilesData=${profilesData.length} useCandidate=${useCandidate} groupIds=${profilesData.map(p=>p.name+':'+JSON.stringify(p.groupIds)).join('|')}`)
    if (profiles.length === 0) return

    // Cache message embedding (computed once, reused across profiles)
    let msgEmbedding = null
    let msgEmbeddingComputed = false

    for (const profile of profiles) {
      let matched = null

      if (profile.mode === 'keywords') {
        // Embedding match against this profile's keywords
        const profEmbs = profileEmbeddings.get(profile.id)
        console.log(`[EMB-DBG] profile=${profile.name} mode=${profile.mode} profEmbs=${profEmbs?.size || 0} embeddingsFailed=${embeddingsFailed} cfAccountId=${!!cfAccountId}`)
        if (profEmbs && profEmbs.size > 0 && !embeddingsFailed) {
          if (!msgEmbeddingComputed) {
            msgEmbedding = await getEmbedding(text)
            msgEmbeddingComputed = true
            console.log(`[EMB-DBG] msgEmb=${!!msgEmbedding} text="${text.slice(0,30)}"`)
          }
          if (msgEmbedding) {
            let bestScore = 0
            let bestKeyword = null
            for (const [kw, kwEmb] of profEmbs) {
              const score = cosineSimilarity(msgEmbedding, kwEmb)
              if (score > bestScore) {
                bestScore = score
                bestKeyword = kw
              }
            }
            console.log(`[EMB-DBG] score=${bestScore.toFixed(3)} kw=${bestKeyword} thresh=${profile.threshold}`)
            if (bestScore >= profile.threshold && bestKeyword) {
              matched = bestKeyword + ' (' + bestScore.toFixed(2) + ')'
            }
          } else {
            console.log(`[EMB-DBG] getEmbedding returned null!`)
          }
        }
        // Fallback: exact match
        if (!matched) {
          const exact = exactKeywordMatchList(text, profile.keywords)
          if (exact) matched = exact + ' [exact]'
        }
      } else if (profile.mode === 'prompt') {
        // Haiku only — no keywords needed
        const arOpts = (profile.autoresponseMode && profile.autoresponseMode !== 'off')
          ? { mode: profile.autoresponseMode, template: profile.autoresponseTemplate || '', strategy: profile.autoresponseStrategy || 'direct', referral: profile.autoresponseReferral || '' }
          : null
        const hResult = await haikuMatchWithPrompt(text, profile.prompt, arOpts)
        matched = hResult.match
        if (matched === 'no') matched = null
        if (hResult.autoResponse) profile._autoResponse = hResult.autoResponse
      } else if (profile.mode === 'hybrid') {
        // Keywords first
        const profEmbs = profileEmbeddings.get(profile.id)
        console.log(`[EMB-DBG] profile=${profile.name} mode=${profile.mode} profEmbs=${profEmbs?.size || 0} embeddingsFailed=${embeddingsFailed} cfAccountId=${!!cfAccountId}`)
        if (profEmbs && profEmbs.size > 0 && !embeddingsFailed) {
          if (!msgEmbeddingComputed) {
            msgEmbedding = await getEmbedding(text)
            msgEmbeddingComputed = true
          }
          if (msgEmbedding) {
            let bestScore = 0
            let bestKeyword = null
            for (const [kw, kwEmb] of profEmbs) {
              const score = cosineSimilarity(msgEmbedding, kwEmb)
              if (score > bestScore) {
                bestScore = score
                bestKeyword = kw
              }
            }
            console.log(`[EMB-DBG] score=${bestScore.toFixed(3)} kw=${bestKeyword} thresh=${profile.threshold}`)
            if (bestScore >= profile.threshold && bestKeyword) {
              matched = bestKeyword + ' (' + bestScore.toFixed(2) + ')'
            }
          }
        }
        if (!matched) {
          const exact = exactKeywordMatchList(text, profile.keywords)
          if (exact) matched = exact + ' [exact]'
        }
        // Haiku double-check if keyword matched
        if (matched && profile.prompt) {
          const arOpts = (profile.autoresponseMode && profile.autoresponseMode !== 'off')
            ? { mode: profile.autoresponseMode, template: profile.autoresponseTemplate || '', strategy: profile.autoresponseStrategy || 'direct', referral: profile.autoresponseReferral || '' }
            : null
          const hResult = await haikuMatchWithPrompt(text, profile.prompt, arOpts)
          if (hResult.match === 'no') {
            matched = null
          } else if (hResult.match === null) {
            console.log('[HYBRID] Haiku unavailable for profile', profile.name, ', passing keyword match through')
          }
          if (hResult.autoResponse) profile._autoResponse = hResult.autoResponse
        }
      }

      if (!matched) continue

      // Generate autoresponse via Haiku ONLY if profile has a real prompt.
      // Pure keywords mode → no autoresponse (Haiku has no context to generate a sensible reply).
      if (!profile._autoResponse && profile.autoresponseMode && profile.autoresponseMode !== 'off' && profile.prompt) {
        const arOpts = { mode: profile.autoresponseMode, template: profile.autoresponseTemplate || '', strategy: profile.autoresponseStrategy || 'direct', referral: profile.autoresponseReferral || '' }
        const arResult = await haikuMatchWithPrompt(text, profile.prompt, arOpts)
        if (arResult.autoResponse) profile._autoResponse = arResult.autoResponse
      }

      const groupTitle = monitoredChats.get(chatId) || chatId
      console.log('[MATCH]', groupTitle, '| profile:', profile.name, ':', text.slice(0, 80), '| by:', matched)

      let senderName = '', senderUsername = '', senderId = 0
      try {
        if (msg.sender_id?._ === 'messageSenderUser') {
          const user = await client.invoke({ _: 'getUser', user_id: msg.sender_id.user_id })
          senderName = [user.first_name, user.last_name].filter(Boolean).join(' ')
          senderUsername = user.usernames?.active_usernames?.[0] || ''
          senderId = user.id
        }
      } catch {}

      let messageLink = ''
      const strChatId = String(msg.chat_id)
      if (strChatId.startsWith('-100') && msg.id) {
        messageLink = 'https://t.me/c/' + strChatId.slice(4) + '/' + msg.id
      }

      // Forward original message to profile destinations
      let forwarded = false
      const destChatIds = profile.destinations || []
      console.log('[FWD] profile:', profile.name, 'destinations:', JSON.stringify(destChatIds))
      if (destChatIds.length > 0) {
        for (const destId of destChatIds) {
          try {
            const targetChatId = Number(destId)
            // Ensure TDLib has loaded the destination chat
            try {
              if (targetChatId > 0) {
                await client.invoke({ _: 'createPrivateChat', user_id: targetChatId, force: false })
              } else if (targetChatId > -1000000000000) {
                await client.invoke({ _: 'createBasicGroupChat', basic_group_id: Math.abs(targetChatId), force: false })
              } else {
                await client.invoke({ _: 'createSupergroupChat', supergroup_id: Math.abs(targetChatId) - 1000000000000, force: false })
              }
            } catch (loadErr) {
              console.log('[FWD] chat load attempt for', targetChatId, ':', loadErr.message)
            }
            console.log('[FWD] forwarding msg', msg.id, 'from', msg.chat_id, 'to', targetChatId)
            await client.invoke({
              _: 'forwardMessages',
              chat_id: targetChatId,
              from_chat_id: msg.chat_id,
              message_ids: [msg.id],
              send_copy: false,
              remove_caption: false,
            })
            forwarded = true
            console.log('[FWD] success to', targetChatId)
          } catch (e) {
            console.log('[FWD] fail', destId, e.message)
          }
        }
      }

      await orchPost('/api/candidate', {
        text,
        groupUsername: groupTitle,
        groupId: chatId,
        keywordMatched: matched,
        profileId: profile.id,
        profileName: profile.name,
        messageLink,
        senderName,
        senderUsername,
        senderId,
        forwarded,
        autoResponse: profile._autoResponse || undefined,
        autoresponseMode: profile.autoresponseMode || 'off',
      })
      // Clean up temp field
      delete profile._autoResponse
    }
    return
  }

  // --- Legacy flat path (backward compat: no profilesData or useCandidate=false) ---
  let matched = null

  if (filterMode === 'keywords') {
    if (cfAccountId && cfApiToken && keywordEmbeddings.size > 0 && !embeddingsFailed) {
      matched = await embeddingKeywordMatch(text)
    } else {
      const exact = exactKeywordMatch(text)
      if (exact) matched = exact + ' [exact]'
    }
  } else if (filterMode === 'prompt') {
    matched = await haikuMatch(text)
  } else if (filterMode === 'hybrid') {
    if (cfAccountId && cfApiToken && keywordEmbeddings.size > 0 && !embeddingsFailed) {
      matched = await embeddingKeywordMatch(text)
    } else {
      const exact = exactKeywordMatch(text)
      if (exact) matched = exact + ' [exact]'
    }
    if (matched) {
      const haikuResult = await haikuMatch(text)
      if (haikuResult === 'no') {
        matched = null
      } else if (haikuResult === null) {
        console.log('[HYBRID] Haiku unavailable, passing keyword match through')
      }
    }
  }

  if (!matched) return

  const groupTitle = monitoredChats.get(chatId) || chatId
  console.log('[MATCH]', groupTitle, ':', text.slice(0, 80), '| by:', matched)

  let senderName = '', senderUsername = '', senderId = 0
  try {
    if (msg.sender_id?._ === 'messageSenderUser') {
      const user = await client.invoke({ _: 'getUser', user_id: msg.sender_id.user_id })
      senderName = [user.first_name, user.last_name].filter(Boolean).join(' ')
      senderUsername = user.usernames?.active_usernames?.[0] || ''
      senderId = user.id
    }
  } catch {}

  let messageLink = ''
  const strChatId = String(msg.chat_id)
  if (strChatId.startsWith('-100') && msg.id) {
    messageLink = 'https://t.me/c/' + strChatId.slice(4) + '/' + msg.id
  }

  const endpoint = useCandidate ? '/api/candidate' : '/api/alert'
  await orchPost(endpoint, {
    text,
    groupUsername: groupTitle,
    groupId: chatId,
    keywordMatched: matched,
    messageLink,
    senderName,
    senderUsername,
    senderId,
  })
})

client.on('error', (e) => console.error('TDLib error:', e))

// --- Login ---

async function waitForCommand(cmdName) {
  console.log('[LOGIN] waiting for command:', cmdName)
  const statusMap = { login_phone: 'need_phone', login_code: 'need_code', login_password: 'need_password' }
  await orchPost('/api/login-status', { status: statusMap[cmdName] || cmdName })
  while (true) {
    const data = await orchGet('/api/pull')
    if (data) {
      for (const cmd of data.commands) {
        if (cmd.command === cmdName) return cmd.payload
      }
    }
    await new Promise(r => setTimeout(r, 3000))
  }
}

try {
  await client.login(() => ({
    getPhoneNumber: async () => await waitForCommand('login_phone'),
    getAuthCode: async () => await waitForCommand('login_code'),
    getPassword: async () => await waitForCommand('login_password'),
  }))
  console.log('Logged in!')
  await orchPost('/api/login-status', { status: 'logged_in' })
} catch (e) {
  console.error('Login failed:', e.message)
  await orchPost('/api/login-status', { status: 'error', message: e.message })
  process.exit(1)
}

// --- Sync chat list ---

async function syncChatList() {
  try {
    try {
      for (let i = 0; i < 10; i++) {
        await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 100 })
      }
    } catch {}
    const chats = await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 500 })
    const result = []
    for (const chatId of chats.chat_ids) {
      try {
        const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
        if (chat.type?._ === 'chatTypeSupergroup' || chat.type?._ === 'chatTypeBasicGroup') {
          let memberCount = 0
          if (chat.type?._ === 'chatTypeSupergroup') {
            try {
              const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id })
              memberCount = sg.member_count || 0
            } catch {}
          }
          result.push({
            id: String(chatId),
            title: chat.title || String(chatId),
            type: chat.type?._ === 'chatTypeSupergroup' ? (chat.type.is_channel ? 'channel' : 'group') : 'group',
            memberCount,
          })
        }
      } catch {}
    }
    console.log('[SYNC] found', result.length, 'groups')
    await orchPost('/api/chats', result)
    return result
  } catch (e) {
    console.error('syncChatList error:', e.message)
    return []
  }
}

await syncChatList()

// --- Heartbeat ---

setInterval(() => orchPost('/api/heartbeat', { version: RUNTIME_VERSION }), 120000)
await orchPost('/api/heartbeat', { version: RUNTIME_VERSION })
console.log('[heartbeat] sent')

// --- Pull loop ---

async function pullLoop() {
  const data = await orchGet('/api/pull')
  if (data) {
    // Auto-update: only for Contabo pool (pool manager pulls new image on restart)
    // Railway & self-hosted Docker: restart just uses cached image → infinite loop
    const isPool = !!process.env.POOL_MODE
    if (data.runtimeVersion && data.runtimeVersion !== RUNTIME_VERSION) {
      if (isPool) {
        console.log('[UPDATE] New version available:', data.runtimeVersion, '(current:', RUNTIME_VERSION + ')')
        console.log('[UPDATE] Pool mode — restarting to update...')
        await orchPost('/api/login-status', {
          status: 'updated',
          version: data.runtimeVersion,
          changelog: data.changelog || '',
        })
        process.exit(0) // Pool manager will pull new image and restart
      } else {
        console.log('[UPDATE] New version available:', data.runtimeVersion, '(current:', RUNTIME_VERSION + '). Not auto-restarting (non-pool deployment).')
      }
    }

    // Sync config
    if (data.filterMode) filterMode = data.filterMode
    if (data.aiThreshold) {
      aiThreshold = parseFloat(data.aiThreshold)
    }
    if (data.useCandidate !== undefined) useCandidate = !!data.useCandidate
    if (data.minMessageLength !== undefined) minMessageLength = parseInt(data.minMessageLength) || 10

    // --- Per-profile sync ---
    if (data.profilesData && data.profilesData.length > 0) {
      const newPD = JSON.stringify(data.profilesData)
      const oldPD = JSON.stringify(profilesData)
      if (newPD !== oldPD) {
        profilesData = data.profilesData
        console.log('[PROFILES]', profilesData.length, 'profiles:', profilesData.map(p => p.name + '(' + p.mode + ',' + p.keywords.length + 'kw)').join(', '))
        await updateProfileEmbeddings()
      }
    }

    // Use allKeywords (union of all profiles) for backward compat + global cache
    if (data.allKeywords && data.allKeywords.length > 0) {
      const newKw = JSON.stringify(data.allKeywords)
      const oldKw = JSON.stringify(keywords)
      if (newKw !== oldKw) {
        keywords = data.allKeywords
        console.log('[KEYWORDS from profiles]', keywords.length, 'words')
        // Only update global embeddings if no profilesData (backward compat)
        if (!data.profilesData || data.profilesData.length === 0) {
          await updateKeywordEmbeddings()
        }
      }
    }
    if (data.anthropicKey) anthropicKey = data.anthropicKey
    if (data.haikuKey !== undefined) haikuKey = data.haikuKey
    if (data.haikuRemaining !== undefined) haikuRemaining = data.haikuRemaining
    if (data.hasOwnKey !== undefined) hasOwnKey = data.hasOwnKey
    if (data.haikuModel) haikuModel = data.haikuModel
    // Reset session counter on pull (usage already reported per-call)
    haikuUsedSession = 0
    if (data.aiPrompt !== undefined && data.aiPrompt !== promptText) {
      promptText = data.aiPrompt
      console.log('[PROMPT]', promptText.slice(0, 80))
    }

    // Legacy keywords sync (only if allKeywords not provided)
    if (!data.allKeywords && data.keywords) {
      const newKw = JSON.stringify(data.keywords)
      const oldKw = JSON.stringify(keywords)
      if (newKw !== oldKw) {
        keywords = data.keywords
        console.log('[KEYWORDS legacy]', keywords.length, 'words')
        await updateKeywordEmbeddings()
      }
    }

    // Sync monitored groups
    if (data.groups) {
      // Remove groups no longer in orchestrator
      const newGroupIds = new Set(data.groups.map(g => g.id).filter(Boolean))
      for (const [id] of monitoredChats) {
        if (!newGroupIds.has(id)) { monitoredChats.delete(id); console.log('[UNSYNC]', id) }
      }
      // Add missing groups
      for (const g of data.groups) {
        const chatId = g.id || ''
        const name = g.username || ''
        if (chatId && !monitoredChats.has(chatId)) {
          try {
            const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chatId) })
            try { await client.invoke({ _: 'openChat', chat_id: parseInt(chatId) }) } catch {}
            try { await client.invoke({ _: 'getChatHistory', chat_id: parseInt(chatId), from_message_id: 0, offset: 0, limit: 1, only_local: false }) } catch {}
            monitoredChats.set(chatId, chat.title || name || chatId)
            console.log('[SYNC+]', chat.title, 'id:', chatId, 'type:', chat.type?._)
          } catch {
            monitoredChats.set(chatId, name || chatId)
          }
        }
      }
    }

    // Process commands
    for (const cmd of data.commands) {
      console.log('[CMD]', cmd.command, cmd.payload)
      try {
        if (cmd.command === 'add_group_by_id') {
          const chatId = cmd.payload
          try {
            const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chatId) })
            // Open chat + load history so TDLib starts sending updateNewMessage
            try { await client.invoke({ _: 'openChat', chat_id: parseInt(chatId) }) } catch {}
            try { await client.invoke({ _: 'getChatHistory', chat_id: parseInt(chatId), from_message_id: 0, offset: 0, limit: 1, only_local: false }) } catch {}
            monitoredChats.set(chatId, chat.title || chatId)
            console.log('[MONITORING]', chat.title, 'type:', chat.type?._)
          } catch {
            monitoredChats.set(chatId, chatId)
          }
        }
        if (cmd.command === 'remove_group_by_id') {
          monitoredChats.delete(cmd.payload)
        }
        if (cmd.command === 'update_keywords') {
          keywords = cmd.payload.split(',').map(s => s.trim()).filter(Boolean)
          console.log('[KEYWORDS]', keywords)
          await updateKeywordEmbeddings()
        }
        if (cmd.command === 'update_mode') {
          filterMode = cmd.payload
          console.log('[MODE]', filterMode)
        }
        if (cmd.command === 'update_prompt') {
          promptText = cmd.payload
          console.log('[PROMPT]', promptText.slice(0, 80))
        }
        if (cmd.command === 'update_minlength') {
          minMessageLength = parseInt(cmd.payload) || 10
          console.log('[MINLENGTH]', minMessageLength)
        }
        if (cmd.command === 'update_threshold') {
          aiThreshold = parseFloat(cmd.payload)
          console.log('[THRESHOLD]', aiThreshold)
        }
        if (cmd.command === 'set_cloudflare') {
          try {
            const cf = JSON.parse(cmd.payload)
            cfAccountId = cf.accountId
            cfApiToken = cf.apiToken
            embeddingsFailed = false
            console.log('[CF] credentials updated')
            if (profilesData.length > 0) {
              await updateProfileEmbeddings()
            } else {
              await updateKeywordEmbeddings()
            }
          } catch {}
        }
        if (cmd.command === 'set_anthropic') {
          anthropicKey = cmd.payload
          console.log('[ANTHROPIC] key updated')
        }
        if (cmd.command === 'list_chats') {
          await syncChatList()
        }
        if (cmd.command === 'send_dm') {
          try {
            const payload = JSON.parse(cmd.payload)
            const recipientUserId = Number(payload.userId)
            // Random delay 30-90s to look natural
            if (payload.delay) {
              const delaySec = 30 + Math.floor(Math.random() * 61)
              console.log(`[DM] waiting ${delaySec}s before sending to user ${recipientUserId}`)
              await new Promise(r => setTimeout(r, delaySec * 1000))
            }
            // NEW: route via linked AR client if profile has one ready
            if (payload.arProfileId) {
              const arStatus = getArClientStatus(payload.arProfileId)
              if (arStatus.status === 'ready') {
                console.log(`[DM] via AR profile ${payload.arProfileId} → user ${recipientUserId}`)
                await sendDmViaArClient(payload.arProfileId, recipientUserId, payload.text)
                console.log(`[DM] AR send ok (profile ${payload.arProfileId})`)
              } else {
                throw new Error(`AR client for profile ${payload.arProfileId} not ready (status=${arStatus.status})`)
              }
            } else {
              // Default path: send from main user client
              console.log('[DM] creating private chat with user', recipientUserId)
              const chat = await client.invoke({
                _: 'createPrivateChat',
                user_id: recipientUserId,
                force: false,
              })
              console.log('[DM] private chat created, chat_id:', chat.id)
              await client.invoke({
                _: 'sendMessage',
                chat_id: chat.id,
                input_message_content: {
                  _: 'inputMessageText',
                  text: { _: 'formattedText', text: payload.text },
                },
              })
              console.log('[DM] sent to user', recipientUserId, 'via chat', chat.id)
            }
          } catch (e) {
            console.error('[DM] failed:', e.message)
            orchPost('/api/dm-status', { status: 'failed', recipientId: JSON.parse(cmd.payload).userId, error: e.message }).catch(() => {})
          }
        }
        // AR account linking commands
        if (cmd.command === 'ar_account_init') {
          try {
            const { profileId, phone } = JSON.parse(cmd.payload)
            console.log(`[AR] init profile=${profileId}`)
            const report = (status, error) => {
              orchPost('/api/ar-account/status', { profileId, status, error: error || null }).catch(() => {})
            }
            await initArAccount(profileId, phone, report)
          } catch (e) {
            console.error('[AR] init failed:', e.message)
            try {
              const { profileId } = JSON.parse(cmd.payload)
              orchPost('/api/ar-account/status', { profileId, status: 'error', error: e.message }).catch(() => {})
            } catch {}
          }
        }
        if (cmd.command === 'ar_account_code') {
          try {
            const { profileId, code } = JSON.parse(cmd.payload)
            console.log(`[AR] submit code profile=${profileId}`)
            await submitArCode(profileId, code)
          } catch (e) {
            console.error('[AR] submitCode failed:', e.message)
          }
        }
        if (cmd.command === 'ar_account_password') {
          try {
            const { profileId, password } = JSON.parse(cmd.payload)
            console.log(`[AR] submit password profile=${profileId}`)
            await submitArPassword(profileId, password)
          } catch (e) {
            console.error('[AR] submitPassword failed:', e.message)
          }
        }
        if (cmd.command === 'ar_account_close') {
          try {
            const { profileId } = JSON.parse(cmd.payload)
            console.log(`[AR] close profile=${profileId}`)
            await closeArAccount(profileId)
            orchPost('/api/ar-account/status', { profileId, status: 'none', error: null }).catch(() => {})
          } catch (e) {
            console.error('[AR] close failed:', e.message)
          }
        }
        if (cmd.command === 'restart') {
          console.log('[RESTART] Restart command received')
          process.exit(0) // Railway/systemd will restart
        }
        if (cmd.command === 'shutdown') {
          console.log('[SHUTDOWN] Shutdown command received')
          // Upload session back to pool before exit
          const sessionDir = path.join(DATA_DIR, 'tdlib_db')
          const poolUrl = process.env.SESSION_UPLOAD_URL
          const poolSecret = process.env.SESSION_SECRET
          if (poolUrl && fs.existsSync(sessionDir)) {
            try {
              const { execSync } = await import('child_process')
              const tarData = execSync(`tar czf - -C "${sessionDir}" .`, { maxBuffer: 50 * 1024 * 1024 })
              const uploadRes = await fetch(poolUrl, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + (poolSecret || ''), 'Content-Type': 'application/gzip' },
                body: tarData,
              })
              console.log('[SHUTDOWN] Session uploaded:', uploadRes.ok)
            } catch (e) { console.error('[SHUTDOWN] Session upload failed:', e.message) }
          }
          process.exit(0)
        }
      } catch (e) { console.error('[CMD ERROR]', e.message) }
    }
  }
  const interval = (data?.config?.pullInterval || 120) * 1000
  setTimeout(pullLoop, interval)
}

// Initial keyword embeddings
if (profilesData.length > 0) {
  await updateProfileEmbeddings()
} else {
  await updateKeywordEmbeddings()
}

// Restore any linked AR accounts from disk (session files persist across restarts)
try {
  const arReport = (profileId, status, error) =>
    orchPost('/api/ar-account/status', { profileId, status, error: error || null }).catch(() => {})
  await restoreArClients(arReport)
} catch (e) {
  console.error('[AR] restore failed:', e.message)
}

console.log('Runtime ready. Pull loop starting...')
pullLoop()
