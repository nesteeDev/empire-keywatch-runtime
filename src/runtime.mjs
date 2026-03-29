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
  apiId: parseInt(process.env.TG_API_ID || '30388596'),
  apiHash: process.env.TG_API_HASH || 'REDACTED',
  databaseDirectory: DATA + '/tdlib_db',
  filesDirectory: DATA + '/tdlib_files',
})

let keywords = []
let monitoredChats = new Map() // chatId -> title

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

// AI matching via Cloudflare Workers AI embeddings (bge-m3)
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || ''
const CF_API_TOKEN = process.env.CF_API_TOKEN || ''
let aiPromptText = process.env.AI_PROMPT || ''
let filterMode = process.env.FILTER_MODE || 'keywords'
let promptEmbedding = null // cached embedding of the prompt

async function getEmbedding(text) {
  const res = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/run/@cf/baai/bge-m3',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: [text] }),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    console.error('[AI] embedding error:', res.status, err.slice(0, 100))
    return null
  }
  const data = await res.json()
  return data.result?.data?.[0] || null
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

async function updatePromptEmbedding() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !aiPromptText) return
  console.log('[AI] computing prompt embedding for:', aiPromptText.slice(0, 50))
  promptEmbedding = await getEmbedding(aiPromptText)
  if (promptEmbedding) console.log('[AI] prompt embedding ready, dim:', promptEmbedding.length)
  else console.log('[AI] failed to compute prompt embedding')
}

async function aiMatch(text) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !promptEmbedding) return null

  const msgEmbedding = await getEmbedding(text)
  if (!msgEmbedding) return null

  const similarity = cosineSimilarity(promptEmbedding, msgEmbedding)
  const threshold = 0.45 // tunable, 0.4-0.6 range
  const isMatch = similarity >= threshold

  console.log('[AI]', isMatch ? 'MATCH' : 'no match', 'score=' + similarity.toFixed(3), ':', text.slice(0, 50))
  return isMatch ? 'AI: ' + similarity.toFixed(2) : null
}

// Send chat list to orchestrator
async function syncChatList() {
  try {
    const chats = await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 200 })
    const result = []
    for (const chatId of chats.chat_ids) {
      try {
        const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
        // Only groups and supergroups
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

// Message handler
client.on('update', async (update) => {
  if (update._ !== 'updateNewMessage') return
  const msg = update.message
  if (!msg || msg.is_outgoing) return
  if (msg.content?._ !== 'messageText') return

  const text = msg.content.text.text
  const chatId = String(msg.chat_id)

  if (!monitoredChats.has(chatId)) return

  let matched = null
  
  if (filterMode === 'keywords' || filterMode === 'hybrid') {
    const lower = text.toLowerCase()
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) { matched = kw; break }
    }
  }
  
  if (filterMode === 'ai' || (filterMode === 'hybrid' && matched)) {
    const aiResult = await aiMatch(text)
    if (filterMode === 'ai') {
      matched = aiResult
    } else if (filterMode === 'hybrid' && !aiResult) {
      matched = null // keyword matched but AI rejected
    }
  }
  
  if (!matched) return

  const groupTitle = monitoredChats.get(chatId) || chatId
  console.log('[MATCH]', groupTitle, ':', text.slice(0, 80), '| kw:', matched)

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

// Login with orchestrator-based flow (no stdin)
async function waitForCommand(cmdName) {
  console.log('[LOGIN] waiting for command:', cmdName)
  await orchPost('/api/login-status', { status: cmdName === 'login_phone' ? 'need_phone' : cmdName === 'login_code' ? 'need_code' : 'need_password' })
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

// Sync chat list on startup
await syncChatList()

// Compute prompt embedding if AI prompt is set
if (aiPromptText) await updatePromptEmbedding()

// Heartbeat
setInterval(() => orchPost('/api/heartbeat', {}), 120000)
await orchPost('/api/heartbeat', {})
console.log('[heartbeat] sent')

// Pull loop
async function pullLoop() {
  const data = await orchGet('/api/pull')
  if (data) {
    if (data.keywords) keywords = data.keywords
    if (data.filterMode) filterMode = data.filterMode
    if (data.aiPrompt && data.aiPrompt !== aiPromptText) {
      aiPromptText = data.aiPrompt
      process.env.AI_PROMPT = data.aiPrompt
      await updatePromptEmbedding()
    }

    // Sync monitored groups from orchestrator
    if (data.groups && monitoredChats.size === 0) {
      for (const g of data.groups) {
        const chatId = g.id || ''
        const name = g.username || ''
        if (chatId) {
          try {
            const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chatId) })
            monitoredChats.set(chatId, chat.title || name || chatId)
            console.log('[RESTORED]', chat.title, 'id:', chatId)
          } catch (e) {
            monitoredChats.set(chatId, name || chatId)
            console.log('[RESTORED by ID]', chatId)
          }
        }
      }
    }

    for (const cmd of data.commands) {
      console.log('[CMD]', cmd.command, cmd.payload)
      try {
        if (cmd.command === 'add_group') {
          const username = cmd.payload.replace(/^@/, '')
          const chat = await client.invoke({ _: 'searchPublicChat', username })
          await client.invoke({ _: 'joinChat', chat_id: chat.id })
          monitoredChats.set(String(chat.id), username)
          console.log('[JOINED]', username, 'id:', chat.id)
        }
        if (cmd.command === 'add_group_by_id') {
          const chatId = cmd.payload
          monitoredChats.set(chatId, chatId)
          // Get title
          try {
            const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chatId) })
            monitoredChats.set(chatId, chat.title || chatId)
            console.log('[MONITORING]', chat.title, 'id:', chatId)
          } catch {
            console.log('[MONITORING] id:', chatId)
          }
        }
        if (cmd.command === 'remove_group') {
          const username = cmd.payload.replace(/^@/, '')
          for (const [id, name] of monitoredChats) {
            if (name === username) { monitoredChats.delete(id); break }
          }
        }
        if (cmd.command === 'remove_group_by_id') {
          monitoredChats.delete(cmd.payload)
          console.log('[UNMONITORING] id:', cmd.payload)
        }
        if (cmd.command === 'update_keywords') {
          keywords = cmd.payload.split(',').map(s => s.trim()).filter(Boolean)
          console.log('[KEYWORDS]', keywords)
        }
        if (cmd.command === 'list_chats') {
          await syncChatList()
        }
        if (cmd.command === 'update_mode') {
          filterMode = cmd.payload
          console.log('[MODE]', filterMode)
        }
        if (cmd.command === 'update_prompt') {
          aiPromptText = cmd.payload
          process.env.AI_PROMPT = cmd.payload
          console.log('[PROMPT]', cmd.payload)
          await updatePromptEmbedding()
        }
        if (cmd.command === 'set_cloudflare') {
          try {
            const cf = JSON.parse(cmd.payload)
            process.env.CF_ACCOUNT_ID = cf.accountId
            process.env.CF_API_TOKEN = cf.apiToken
            console.log('[CF] credentials updated')
          } catch {}
        }
        if (cmd.command === 'update_mode') {
          filterMode = cmd.payload
          console.log('[MODE]', filterMode)
        }
        if (cmd.command === 'update_prompt') {
          // Update AI_PROMPT dynamically
          process.env.AI_PROMPT = cmd.payload
          console.log('[PROMPT]', cmd.payload)
        }
      } catch (e) { console.error('[CMD ERROR]', e.message) }
    }
  }
  setTimeout(pullLoop, 10000)
}

console.log('Runtime ready. Pull loop starting...')
pullLoop()
