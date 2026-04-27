import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, get, push } from 'firebase/database'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}
initializeApp(firebaseConfig)
const db = getDatabase()

// ===== Accounts =====
const accounts = []
const clients = {}
setInterval(async () => {
  for (const id in clients) {
    try {
      const client = clients[id]

      if (!client.connected) {
        console.log(`🧹 Remove ${id}`)
        await client.disconnect()
        delete clients[id]
      }
    } catch {
      delete clients[id]
    }
  }
}, 5 * 60 * 1000)
// ===== Normalize Username =====
function normalizeUsername(input){
  if(!input) return null
  let u = input.trim()
  if(u.includes("t.me/")) u = u.split("/").pop()
  return u.replace("@","").trim()
}

// ===== Normalize Group =====
function normalizeGroup(group){
  if(!group) return group
  let g = group.trim()
  if(g.includes("t.me/")) g = g.split("/").pop()
  return g
}

// ===== Save Account =====
async function saveAccountToFirebase(account){
  try{
    const snap = await get(ref(db,'accounts'))
    const data = snap.val() || {}
    const exists = Object.values(data).some(a => a.phone === account.phone)
    if(exists) return false

    await update(ref(db,`accounts/${account.id}`),{
      phone:account.phone,
      api_id:account.api_id,
      api_hash:account.api_hash,
      session:account.session,
      status:"active",
      floodWaitUntil:null,
      addCount:0,
      lastChecked:null,
      createdAt:Date.now()
    })

    console.log(`✅ Saved ${account.phone}`)
    return true
  }catch(err){
    console.log("❌ Save error:",err.message)
    return false
  }
}

// ===== Load ENV Accounts =====
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(!api_id||!api_hash||!session){i++; continue}

  const account={
    phone, api_id, api_hash, session,
    id:`TG_ACCOUNT_${i}`,
    status:"pending",
    floodWaitUntil:null,
    lastChecked:null,
    addCount:0
  }

  accounts.push(account)
  saveAccountToFirebase(account)
  i++
}

// ===== Telegram Client =====
async function getClient(account){

  // ===== 1. CLEAN DEAD CLIENT =====
  if(clients[account.id]){
    try{
      if(!clients[account.id].connected){
        console.log(`🔄 Reconnecting cached ${account.phone}`)
        await clients[account.id].connect()
      }

      await clients[account.id].getMe()
      return clients[account.id] // ✅ still valid

    }catch(err){
      console.log(`♻️ Removing dead client ${account.phone}`)
      delete clients[account.id]
    }
  }

  // ===== 2. CREATE NEW CLIENT =====
  const client = new TelegramClient(
    new StringSession(account.session),
    account.api_id,
    account.api_hash,
    {
      connectionRetries: 5,
      autoReconnect: true
    }
  )

  try{
    // ===== 3. CONNECT =====
    await client.connect()

    // ===== 4. VERIFY SESSION =====
    await client.getMe()

    // ===== 5. AUTO RECONNECT GUARD =====
    client.addEventHandler(async () => {
      try{
        if(!client.connected){
          console.log(`🔄 Auto reconnect ${account.phone}`)
          await client.connect()
        }
      }catch(e){
        console.log(`⚠️ Reconnect failed ${account.phone}`)
      }
    })

    // ===== 6. SAVE SESSION (AUTO UPDATE) =====
    const newSession = client.session.save()

    if(newSession !== account.session){
      account.session = newSession

      await update(ref(db,`accounts/${account.id}`),{
        session: newSession
      })

      console.log(`🔄 Session updated ${account.phone}`)
    }

    // ===== 7. MARK ACTIVE =====
    account.status = "active"
    account.lastChecked = Date.now()

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      lastChecked:account.lastChecked,
      floodWaitUntil:null
    })

    // ===== 8. SAVE CLIENT =====
    clients[account.id] = client

    return client

  }catch(err){

    console.log(`❌ Client init failed ${account.phone}:`, err.message)

    // ===== 9. HANDLE FLOODWAIT =====
    const wait = parseFlood(err)

    if(wait){
      const until = Date.now() + wait * 1000

      account.status = "floodwait"
      account.floodWaitUntil = until

      await update(ref(db,`accounts/${account.id}`),{
        status:"floodwait",
        floodWaitUntil: until,
        error: err.message
      })

    }else{
      // ===== 10. SESSION INVALID =====
      account.status = "error"

      await update(ref(db,`accounts/${account.id}`),{
        status:"error",
        error: err.message,
        lastChecked: Date.now()
      })
    }

    return null
  }
}

// ===== Flood Parse =====
function parseFlood(err){
  const msg=err.message||""
  const m1=msg.match(/FLOOD_WAIT_(\d+)/)
  const m2=msg.match(/wait of (\d+) seconds/i)
  if(m1) return Number(m1[1])
  if(m2) return Number(m2[1])
  return null
}

// ===== Refresh Account =====
async function refreshAccountStatus(account){
  const now = Date.now()

  if(account.floodWaitUntil && account.floodWaitUntil < now){
    account.floodWaitUntil = null
    account.status = "active"

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      floodWaitUntil:null
    })

    console.log(`✅ ${account.phone} back to active`)
  }
}

// ===== Check Account =====
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)

    // 👉 reuse client if exists
    const client = await getClient(account)
    if(!client) throw new Error("No client")

    await client.getMe()

    account.status="active"
    account.floodWaitUntil=null
    account.lastChecked=Date.now()

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      lastChecked:account.lastChecked,
      floodWaitUntil:null
    })

  }catch(err){
    const wait=parseFlood(err)
    let status="error", floodUntil=null

    if(wait){
      status="floodwait"
      floodUntil=Date.now()+wait*1000
      account.floodWaitUntil=floodUntil
      account.status="floodwait"
    }

    account.lastChecked=Date.now()

    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:floodUntil,
      error:err.message,
      lastChecked:account.lastChecked
    })
  }
}

// ===== Auto Check =====
let isChecking = false
let index = 0

async function autoCheck() {
  if (isChecking) return
  isChecking = true

  try {
    if (!accounts.length) return

    const acc = accounts[index % accounts.length]
    index++

    if (!acc) return

    // 👉 only check if needed
    if (acc.status === "active" && !acc.floodWaitUntil) {
      await sleep(3000)
      return
    }

    await checkTGAccount(acc)

    await sleep(8000)

  } catch (err) {
    console.log("autoCheck error:", err.message)
  } finally {
    isChecking = false
  }
}

// 👉 slower interval (IMPORTANT)
setInterval(autoCheck, 10 * 60 * 1000)

// ===== Get Available Account =====
let accIndex = 0

function getAvailableAccount(){
  const now = Date.now()

  const available = accounts.filter(acc =>
    acc.status === "active" &&
    (!acc.floodWaitUntil || acc.floodWaitUntil < now)
  )

  if(!available.length) return null

  const acc = available[accIndex % available.length]
  accIndex++

  return acc
}

// ===== Auto Join =====
async function autoJoin(client, group){
  const clean = normalizeGroup(group)

  try{
    await client.getEntity(clean)
  }catch{
    try{
      await client.invoke(
        new Api.messages.ImportChatInvite({hash:clean})
      )
    }catch(e){}
  }
}

// ===== Auto Join All =====
async function autoJoinAllAccounts(group){
  for(const acc of accounts){
    try{
      const client = await getClient(acc)
      await autoJoin(client, group)
      await sleep(1000)
    }catch(e){}
  }
}

// ===== Get Members =====
app.post('/members', async (req, res) => {
  try {
    let { group, offset = 0, limit = 200 } = req.body

    // 🔒 កំណត់ limit អតិបរមា
    limit = Math.min(limit, 200)

    const acc = getAvailableAccount()
    if (!acc) {
      return res.json({ error: "No active account" })
    }

    const client = await getClient(acc)
    if (!client) {
      return res.json({ error: "Client failed" })
    }

    const cleanGroup = normalizeGroup(group)

    // 👉 auto join
    await autoJoin(client, cleanGroup)

    const entity = await client.getEntity(cleanGroup)

    // ⏱️ delay បន្តិច កាត់បន្ថយ flood
    await sleep(1500)

    // 🔁 retry system (ការពារ error)
    let participants = []
    for (let i = 0; i < 3; i++) {
      try {
        participants = await client.getParticipants(entity, {
          offset,
          limit,
          aggressive: true // ⚡ លឿន
        })
        break
      } catch (e) {
        await sleep(2000)
      }
    }

    const members = participants
      .filter(p => !p.bot)
      .map(p => ({
        user_id: p.id,
        username: p.username,
        access_hash: p.access_hash
      }))

    return res.json({
      members,
      nextOffset: offset + participants.length,
      hasMore: participants.length === limit
    })

  } catch (err) {
    return res.json({ error: err.message })
  }
})

// ===== Add Member =====
app.post('/add-member', async (req, res) => {
  try {
    let { username, user_id, access_hash, targetGroup } = req.body

    // ================= VALIDATION =================
    if (!username && !user_id) {
      return res.json({
        status: "failed",
        reason: "Missing username or user_id",
        accountUsed: "none"
      })
    }

    const acc = getAvailableAccount()
    if (!acc) {
      return res.json({
        status: "failed",
        reason: "No available account (FloodWait)",
        accountUsed: "none"
      })
    }

    const client = await getClient(acc)

    // ================= GROUP RESOLVE =================
    let groupEntity
    try {
      groupEntity = await client.getEntity(targetGroup)
    } catch {
      return res.json({
        status: "failed",
        reason: "Invalid target group",
        accountUsed: acc.phone
      })
    }

    // ================= USER RESOLVE =================
    const cleanUsername = normalizeUsername(username)

    let userEntity
    try {
      if (cleanUsername) {
        userEntity = await client.getEntity(cleanUsername)
      } else {
        userEntity = new Api.InputUser({
          userId: user_id,
          accessHash: BigInt(access_hash)
        })
      }
    } catch {
      return res.json({
        status: "skipped",
        reason: "User not found / private",
        accountUsed: acc.phone
      })
    }

    // ================= CHECK EXISTING =================
    try {
      await client.getParticipant(groupEntity, userEntity)

      return res.json({
        status: "skipped",
        reason: "Already in group",
        accountUsed: acc.phone
      })
    } catch {}

    // ================= INVITE =================
    try {
      await client.invoke(new Api.channels.InviteToChannel({
        channel: groupEntity,
        users: [userEntity]
      }))
    } catch (err) {
      const wait = parseFlood(err)

      if (wait) {
        const until = Date.now() + wait * 1000

        acc.status = "floodwait"
        acc.floodWaitUntil = until

        await update(ref(db, `accounts/${acc.id}`), {
          status: "floodwait",
          floodWaitUntil: until
        })

        return res.json({
          status: "floodwait",
          reason: `FloodWait ${wait}s`,
          accountUsed: acc.phone
        })
      }

      return res.json({
        status: "failed",
        reason: err.message,
        accountUsed: acc.phone
      })
    }

    // ================= PRO VERIFY ENGINE =================
    await sleep(7000)

    let joined = false

    // 1. PRIMARY CHECK
    try {
      await client.getParticipant(groupEntity, userEntity)
      joined = true
    } catch {}

    // 2. RETRY CHECK
    if (!joined) {
      for (let i = 0; i < 3; i++) {
        await sleep(3000)

        try {
          await client.getParticipant(groupEntity, userEntity)
          joined = true
          break
        } catch {}
      }
    }

    // 3. BACKUP CHECK
    if (!joined && user_id) {
      try {
        const list = await client.getParticipants(groupEntity, {
          limit: 200
        })

        joined = list.some(p => p.id == user_id)
      } catch {}
    }

    // ================= RESULT =================
    if (joined) {
      acc.addCount = (acc.addCount || 0) + 1

      await update(ref(db, `accounts/${acc.id}`), {
        addCount: acc.addCount
      })

      await push(ref(db, 'history'), {
        username: cleanUsername || username,
        user_id,
        status: "success",
        reason: "joined (verified)",
        accountUsed: acc.phone,
        timestamp: Date.now()
      })

      await sleep(20000 + Math.floor(Math.random() * 10000))

      return res.json({
        status: "success",
        reason: "joined (verified)",
        accountUsed: acc.phone
      })
    }

    return res.json({
      status: "failed",
      reason: "invite sent but not confirmed",
      accountUsed: acc.phone
    })

  } catch (err) {
    return res.json({
      status: "failed",
      reason: err.message,
      accountUsed: "unknown"
    })
  }
})
app.post('/auto-join', async (req, res) => {
  try {
    const { group, account } = req.body

    const acc = accounts.find(a => a.id === account)
    if (!acc) {
      return res.status(404).json({ error: "Account not found" })
    }

    const client = await getClient(acc)

    const clean = normalizeGroup(group)

    try {
      await client.getEntity(clean)
    } catch {
      await client.invoke(
        new Api.messages.ImportChatInvite({ hash: clean })
      )
    }

    return res.json({
      status: "joined",
      account: acc.phone
    })

  } catch (err) {
    return res.status(500).json({
      error: err.message
    })
  }
})
// ===== Status APIs =====
app.get('/account-status', async(req,res)=>{
  const snap=await get(ref(db,'accounts'))
  res.json(snap.val()||{})
})

app.get('/history', async(req,res)=>{
  const snap=await get(ref(db,'history'))
  res.json(snap.val()||{})
})
// ===== Admin Login =====
app.post('/api/login', (req,res)=>{
  const { username, password } = req.body
  if(username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD){
    return res.json({ success:true })
  }
  res.status(401).json({ success:false, error:"Invalid credentials" })
})
// ===== Frontend =====
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)

app.use(express.static(__dirname))
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
