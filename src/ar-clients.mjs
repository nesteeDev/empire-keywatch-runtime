// Per-profile Telegram accounts for sending autoresponse DMs.
// Each linked account is a separate TDLib client with its own session dir,
// isolated from the main user client.
//
// Lifecycle:
//   initArAccount(accountId, phone, onStatusChange)
//     → TDLib asks for phone (auto-sent), then code, then maybe password
//     → onStatusChange('code_needed' | 'password_needed' | 'ready' | 'error')
//   submitArCode(accountId, code)
//   submitArPassword(accountId, password)
//   sendDmViaArClient(accountId, recipientUserId, text)
//   closeArAccount(accountId)  — logs out, deletes session files
//
// restoreArClients() is called on runtime startup to re-init clients for
// profiles that have a session dir on disk (survived process restart).

import tdl from 'tdl'
import fs from 'fs'
import path from 'path'

const DATA = process.env.DATA_DIR || './data'
const MAX_AR_CLIENTS = 10

// Map<accountId, entry>
const arClients = new Map()

function clientConfig(accountId) {
  const dbDir = path.join(DATA, `tdlib_db_ar_${accountId}`)
  const filesDir = path.join(DATA, `tdlib_files_ar_${accountId}`)
  return { dbDir, filesDir }
}

function makeClient(accountId) {
  const { dbDir, filesDir } = clientConfig(accountId)
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
  const { client, accountId } = entry

  client.on('update', async (update) => {
    if (update._ !== 'updateAuthorizationState') return
    const state = update.authorization_state?._
    console.log(`[AR-${accountId}] auth state: ${state}`)

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
        arClients.delete(accountId)
      }
    } catch (e) {
      entry.status = 'error'
      entry.error = e.message || String(e)
      entry.reportStatus?.('error', entry.error)
    }
  })

  client.on('error', (e) => {
    console.error(`[AR-${accountId}] tdlib error:`, e.message || e)
    entry.error = e.message || String(e)
  })
}

export async function initArAccount(accountId, phone, reportStatus) {
  // Close existing if any
  if (arClients.has(accountId)) {
    await closeArAccount(accountId)
  }
  if (arClients.size >= MAX_AR_CLIENTS) {
    throw new Error(`max ${MAX_AR_CLIENTS} AR accounts`)
  }

  const client = makeClient(accountId)
  const entry = {
    accountId,
    client,
    phone,
    status: 'initializing',
    error: null,
    reportStatus,
  }
  arClients.set(accountId, entry)
  attachAuthHandler(entry)
  return entry
}

export async function submitArCode(accountId, code) {
  const entry = arClients.get(accountId)
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

export async function submitArPassword(accountId, password) {
  const entry = arClients.get(accountId)
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

export async function closeArAccount(accountId) {
  const entry = arClients.get(accountId)
  if (!entry) return
  try { await entry.client.invoke({ _: 'logOut' }) } catch {}
  try { await entry.client.close() } catch {}
  arClients.delete(accountId)
  // Delete session files so next init starts fresh
  const { dbDir, filesDir } = clientConfig(accountId)
  try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(filesDir, { recursive: true, force: true }) } catch {}
}

export async function sendDmViaArClient(accountId, recipientUserId, text) {
  const entry = arClients.get(accountId)
  if (!entry) throw new Error(`no AR client for profile ${accountId}`)
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
    const accountId = parseInt(dir.replace('tdlib_db_ar_', ''))
    if (isNaN(accountId)) continue
    console.log(`[AR] Restoring session for profile ${accountId}`)
    try {
      const client = makeClient(accountId)
      const entry = {
        accountId,
        client,
        phone: '', // empty → restore path
        status: 'restoring',
        error: null,
        reportStatus: reportStatus ? (status, error) => reportStatus(accountId, status, error) : null,
      }
      arClients.set(accountId, entry)
      attachAuthHandler(entry)
    } catch (e) {
      console.error(`[AR] Restore failed for profile ${accountId}:`, e.message)
    }
  }
}

export function listArClients() {
  const list = []
  for (const [accountId, entry] of arClients) {
    list.push({ accountId, status: entry.status, error: entry.error })
  }
  return list
}

export function getArClientStatus(accountId) {
  const entry = arClients.get(accountId)
  if (!entry) return { status: 'none', error: null }
  return { status: entry.status, error: entry.error }
}
