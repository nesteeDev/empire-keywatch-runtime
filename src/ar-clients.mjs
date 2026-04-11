// Per-profile Telegram accounts for sending autoresponse DMs.
// Each linked account is a separate TDLib client with its own session dir,
// isolated from the main user client.
//
// Lifecycle:
//   initArAccount(profileId, phone, onStatusChange)
//     → TDLib asks for phone (auto-sent), then code, then maybe password
//     → onStatusChange('code_needed' | 'password_needed' | 'ready' | 'error')
//   submitArCode(profileId, code)
//   submitArPassword(profileId, password)
//   sendDmViaArClient(profileId, recipientUserId, text)
//   closeArAccount(profileId)  — logs out, deletes session files
//
// restoreArClients() is called on runtime startup to re-init clients for
// profiles that have a session dir on disk (survived process restart).

import tdl from 'tdl'
import fs from 'fs'
import path from 'path'

const DATA = process.env.DATA_DIR || './data'
const MAX_AR_CLIENTS = 10

// Map<profileId, entry>
const arClients = new Map()

function clientConfig(profileId) {
  const dbDir = path.join(DATA, `tdlib_db_ar_${profileId}`)
  const filesDir = path.join(DATA, `tdlib_files_ar_${profileId}`)
  return { dbDir, filesDir }
}

function makeClient(profileId) {
  const { dbDir, filesDir } = clientConfig(profileId)
  fs.mkdirSync(dbDir, { recursive: true })
  fs.mkdirSync(filesDir, { recursive: true })
  return tdl.createClient({
    apiId: parseInt(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH,
    databaseDirectory: dbDir,
    filesDirectory: filesDir,
  })
}

// Attach auth state handler that drives the login flow and reports status.
// For initial login, phone is provided; for restore, phone is empty (session already exists).
function attachAuthHandler(entry) {
  const { client, profileId } = entry

  client.on('update', async (update) => {
    if (update._ !== 'updateAuthorizationState') return
    const state = update.authorization_state?._
    console.log(`[AR-${profileId}] auth state: ${state}`)

    try {
      if (state === 'authorizationStateWaitPhoneNumber') {
        if (entry.phone) {
          entry.status = 'sending_phone'
          await client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: entry.phone })
        } else {
          entry.status = 'phone_needed'
          entry.reportStatus?.('phone_needed')
        }
      } else if (state === 'authorizationStateWaitCode') {
        entry.status = 'code_needed'
        entry.reportStatus?.('code_needed')
      } else if (state === 'authorizationStateWaitPassword') {
        entry.status = 'password_needed'
        entry.reportStatus?.('password_needed')
      } else if (state === 'authorizationStateReady') {
        entry.status = 'ready'
        entry.error = null
        entry.reportStatus?.('ready')
      } else if (state === 'authorizationStateClosed') {
        arClients.delete(profileId)
      }
    } catch (e) {
      entry.status = 'error'
      entry.error = e.message || String(e)
      entry.reportStatus?.('error', entry.error)
    }
  })

  client.on('error', (e) => {
    console.error(`[AR-${profileId}] tdlib error:`, e.message || e)
    entry.error = e.message || String(e)
  })
}

export async function initArAccount(profileId, phone, reportStatus) {
  // Close existing if any
  if (arClients.has(profileId)) {
    await closeArAccount(profileId)
  }
  if (arClients.size >= MAX_AR_CLIENTS) {
    throw new Error(`max ${MAX_AR_CLIENTS} AR accounts`)
  }

  const client = makeClient(profileId)
  const entry = {
    profileId,
    client,
    phone,
    status: 'initializing',
    error: null,
    reportStatus,
  }
  arClients.set(profileId, entry)
  attachAuthHandler(entry)
  return entry
}

export async function submitArCode(profileId, code) {
  const entry = arClients.get(profileId)
  if (!entry) throw new Error('AR client not initialized')
  try {
    await entry.client.invoke({ _: 'checkAuthenticationCode', code })
  } catch (e) {
    entry.status = 'error'
    entry.error = e.message
    entry.reportStatus?.('error', e.message)
    throw e
  }
}

export async function submitArPassword(profileId, password) {
  const entry = arClients.get(profileId)
  if (!entry) throw new Error('AR client not initialized')
  try {
    await entry.client.invoke({ _: 'checkAuthenticationPassword', password })
  } catch (e) {
    entry.status = 'error'
    entry.error = e.message
    entry.reportStatus?.('error', e.message)
    throw e
  }
}

export async function closeArAccount(profileId) {
  const entry = arClients.get(profileId)
  if (!entry) return
  try { await entry.client.invoke({ _: 'logOut' }) } catch {}
  try { await entry.client.close() } catch {}
  arClients.delete(profileId)
  // Delete session files so next init starts fresh
  const { dbDir, filesDir } = clientConfig(profileId)
  try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(filesDir, { recursive: true, force: true }) } catch {}
}

export async function sendDmViaArClient(profileId, recipientUserId, text) {
  const entry = arClients.get(profileId)
  if (!entry) throw new Error(`no AR client for profile ${profileId}`)
  if (entry.status !== 'ready') throw new Error(`AR client not ready (status=${entry.status})`)

  const chat = await entry.client.invoke({
    _: 'createPrivateChat',
    user_id: recipientUserId,
    force: false,
  })
  await entry.client.invoke({
    _: 'sendMessage',
    chat_id: chat.id,
    input_message_content: {
      _: 'inputMessageText',
      text: { _: 'formattedText', text },
    },
  })
  return { ok: true, chat_id: chat.id }
}

// Restore AR clients on runtime startup for profiles that have session files.
// Phone is left empty — the session should already be authorized.
export async function restoreArClients(reportStatus) {
  if (!fs.existsSync(DATA)) return
  const dirs = fs.readdirSync(DATA).filter(n => n.startsWith('tdlib_db_ar_'))
  for (const dir of dirs) {
    const profileId = parseInt(dir.replace('tdlib_db_ar_', ''))
    if (isNaN(profileId)) continue
    console.log(`[AR] Restoring session for profile ${profileId}`)
    try {
      const client = makeClient(profileId)
      const entry = {
        profileId,
        client,
        phone: '', // empty → restore path
        status: 'restoring',
        error: null,
        reportStatus: reportStatus ? (status, error) => reportStatus(profileId, status, error) : null,
      }
      arClients.set(profileId, entry)
      attachAuthHandler(entry)
    } catch (e) {
      console.error(`[AR] Restore failed for profile ${profileId}:`, e.message)
    }
  }
}

export function listArClients() {
  const list = []
  for (const [profileId, entry] of arClients) {
    list.push({ profileId, status: entry.status, error: entry.error })
  }
  return list
}

export function getArClientStatus(profileId) {
  const entry = arClients.get(profileId)
  if (!entry) return { status: 'none', error: null }
  return { status: entry.status, error: entry.error }
}
