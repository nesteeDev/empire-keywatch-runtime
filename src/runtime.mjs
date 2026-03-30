import 'dotenv/config'
import tdl from 'tdl'
import prebuilt from 'prebuilt-tdlib'

tdl.configure({ tdjson: prebuilt.getTdjson() })

const TOKEN = process.env.RUNTIME_TOKEN || ''
const ORCH = process.env.ORCHESTRATOR_URL || ''
const DATA = process.env.DATA_DIR || './data'

console.log('Starting KeyWatch Runtime...')
console.log('Orchestrator:', ORCH)

const client = tdl.createClient({
  apiId: parseInt(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  databaseDirectory: DATA + '/tdlib_db',
  filesDirectory: DATA + '/tdlib_files',
})

const RUNTIME_VERSION = '1.2.0'

let keywords = []
let monitoredChats = new Map() // chatId -> title
let filterMode = 'keywords' // keywords | prompt | hybrid
let promptText = ''
let anthropicKey = ''

// --- Orchestrator communication ---

async function orchPost(path, body) {
  try {
    const res = await fetch(ORCH + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch (e) { console.error('orch error:', e.message); return false }
}

async function orchGet(path) {
  try {
    const res = await fetch(ORCH + path + '?token=' + encodeURIComponent(TOKEN))
    if (!res.ok) return null
    return await res.json()
  } catch (e) { console.error('orch error:', e.message); return null }
}

// --- Cloudflare Workers AI embeddings (for keywords mode) ---

let cfAccountId = process.env.CF_ACCOUNT_ID || ''
let cfApiToken = process.env.CF_API_TOKEN || ''
let keywordEmbeddings = new Map() // keyword -> embedding vector
let embeddingsFailed = false // fallback flag when CF quota exceeded

async function getEmbedding(text) {
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

// Cache embeddings for each keyword individually
async function updateKeywordEmbeddings() {
  if (!cfAccountId || !cfApiToken || keywords.length === 0) return
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

// Match message against keyword embeddings
async function embeddingKeywordMatch(text) {
  if (embeddingsFailed || keywordEmbeddings.size === 0) return null

  const msgEmb = await getEmbedding(text)
  if (!msgEmb) return null

  const threshold = parseFloat(process.env.AI_THRESHOLD || '0.55')
  let bestScore = 0
  let bestKeyword = null

  for (const [kw, kwEmb] of keywordEmbeddings) {
    const score = cosineSimilarity(msgEmb, kwEmb)
    if (score > bestScore) {
      bestScore = score
      bestKeyword = kw
    }
  }

  if (bestScore >= threshold) {
    console.log('[EMB] MATCH', bestKeyword, 'score=' + bestScore.toFixed(3), ':', text.slice(0, 50))
    return bestKeyword + ' (' + bestScore.toFixed(2) + ')'
  }

  return null
}

// Exact keyword match (fallback when no CF or quota exceeded)
// Word boundary: character before and after keyword must NOT be a letter
function exactKeywordMatch(text) {
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase()
    let pos = 0
    while (true) {
      const idx = lower.indexOf(kwLower, pos)
      if (idx === -1) break

      const charBefore = idx > 0 ? lower[idx - 1] : ' '
      const charAfter = idx + kwLower.length < lower.length ? lower[idx + kwLower.length] : ' '

      // Check that surrounding chars are not letters (any script)
      const isLetterBefore = /\p{L}/u.test(charBefore)
      const isLetterAfter = /\p{L}/u.test(charAfter)

      if (!isLetterBefore && !isLetterAfter) return kw

      pos = idx + 1
    }
  }
  return null
}

// --- Anthropic Haiku (for prompt mode) ---

async function haikuMatch(text) {
  if (!anthropicKey || !promptText) return null

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [
          { role: 'user', content: `Does this message match the following criteria? Answer ONLY "YES" or "NO".\n\nCriteria: ${promptText}\n\nMessage: ${text}` }
        ],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[HAIKU] error:', res.status, err.slice(0, 100))
      return null
    }

    const data = await res.json()
    const answer = data.content?.[0]?.text?.trim().toUpperCase() || ''
    const isMatch = answer.startsWith('YES')
    console.log('[HAIKU]', isMatch ? 'MATCH' : 'no match', ':', text.slice(0, 50), '->', answer)
    return isMatch ? 'AI: prompt match' : null
  } catch (e) {
    console.error('[HAIKU] error:', e.message)
    return null
  }
}

// --- Combined message handler ---

client.on('update', async (update) => {
  if (update._ !== 'updateNewMessage') return
  const msg = update.message
  if (!msg || msg.is_outgoing) return
  if (msg.content?._ !== 'messageText') return

  const text = msg.content.text.text
  const chatId = String(msg.chat_id)

  if (!monitoredChats.has(chatId)) return

  let matched = null

  if (filterMode === 'keywords') {
    // Try embeddings first, fallback to exact match
    if (cfAccountId && cfApiToken && keywordEmbeddings.size > 0 && !embeddingsFailed) {
      matched = await embeddingKeywordMatch(text)
    }
    if (!matched) {
      matched = exactKeywordMatch(text)
    }
  } else if (filterMode === 'prompt') {
    // Haiku only
    matched = await haikuMatch(text)
  } else if (filterMode === 'hybrid') {
    // Keywords first (embeddings or exact), then Haiku confirms
    if (cfAccountId && cfApiToken && keywordEmbeddings.size > 0 && !embeddingsFailed) {
      matched = await embeddingKeywordMatch(text)
    }
    if (!matched) {
      matched = exactKeywordMatch(text)
    }
    if (matched) {
      // Haiku double-checks
      const haikuResult = await haikuMatch(text)
      if (!haikuResult) matched = null // keyword matched but Haiku rejected
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

  await orchPost('/api/alert', {
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

setInterval(() => orchPost('/api/heartbeat', {}), 120000)
await orchPost('/api/heartbeat', {})
console.log('[heartbeat] sent')

// --- Pull loop ---

async function pullLoop() {
  const data = await orchGet('/api/pull')
  if (data) {
    // Auto-update: restart if new version available (only for Docker deployments)
    const isDocker = process.env.RAILWAY_DEPLOYMENT_ID && !process.env.RAILWAY_GIT_COMMIT_SHA
    if (isDocker && data.runtimeVersion && data.runtimeVersion !== RUNTIME_VERSION) {
      console.log('[UPDATE] New version available:', data.runtimeVersion, '(current:', RUNTIME_VERSION + ')')
      console.log('[UPDATE] Restarting to update...')
      await orchPost('/api/login-status', {
        status: 'updated',
        version: data.runtimeVersion,
        changelog: data.changelog || '',
      })
      process.exit(0) // Railway will restart with new Docker image
    } else if (data.runtimeVersion && data.runtimeVersion !== RUNTIME_VERSION) {
      // Git deployment — just log, don't restart
      console.log('[UPDATE] Version mismatch:', data.runtimeVersion, 'vs', RUNTIME_VERSION, '(git deploy, skipping restart)')
    }

    // Sync config
    if (data.filterMode) filterMode = data.filterMode
    if (data.aiThreshold) process.env.AI_THRESHOLD = String(data.aiThreshold)
    if (data.anthropicKey) anthropicKey = data.anthropicKey
    if (data.aiPrompt !== undefined && data.aiPrompt !== promptText) {
      promptText = data.aiPrompt
      console.log('[PROMPT]', promptText.slice(0, 80))
    }

    // Sync keywords + recompute embeddings if changed
    if (data.keywords) {
      const newKw = JSON.stringify(data.keywords)
      const oldKw = JSON.stringify(keywords)
      if (newKw !== oldKw) {
        keywords = data.keywords
        console.log('[KEYWORDS]', keywords.length, 'words')
        await updateKeywordEmbeddings()
      }
    }

    // Sync monitored groups
    if (data.groups && monitoredChats.size === 0) {
      for (const g of data.groups) {
        const chatId = g.id || ''
        const name = g.username || ''
        if (chatId) {
          try {
            const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chatId) })
            monitoredChats.set(chatId, chat.title || name || chatId)
            console.log('[RESTORED]', chat.title, 'id:', chatId)
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
            monitoredChats.set(chatId, chat.title || chatId)
            console.log('[MONITORING]', chat.title)
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
        if (cmd.command === 'update_threshold') {
          process.env.AI_THRESHOLD = cmd.payload
          console.log('[THRESHOLD]', cmd.payload)
        }
        if (cmd.command === 'set_cloudflare') {
          try {
            const cf = JSON.parse(cmd.payload)
            cfAccountId = cf.accountId
            cfApiToken = cf.apiToken
            embeddingsFailed = false
            console.log('[CF] credentials updated')
            await updateKeywordEmbeddings()
          } catch {}
        }
        if (cmd.command === 'set_anthropic') {
          anthropicKey = cmd.payload
          console.log('[ANTHROPIC] key updated')
        }
        if (cmd.command === 'list_chats') {
          await syncChatList()
        }
      } catch (e) { console.error('[CMD ERROR]', e.message) }
    }
  }
  const interval = (data?.config?.pullInterval || 120) * 1000
  setTimeout(pullLoop, interval)
}

// Initial keyword embeddings
await updateKeywordEmbeddings()

console.log('Runtime ready. Pull loop starting...')
pullLoop()
