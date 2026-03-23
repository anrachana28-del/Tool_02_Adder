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
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ===== Firebase =====
initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
})
const db = getDatabase()

// ===== Config =====
const ADD_DELAY = Number(process.env.ADD_DELAY || 20000)
const BUFFER = 5000

// ===== Helpers =====
function cleanGroup(g){
  return g.replace("https://t.me/","").replace("@","").replace(/\./g,'_')
}

// ===== Smart Active Filter =====
function isActiveUser(user){
  if(!user.status) return false
  const s = user.status.className

  return (
    s === "UserStatusOnline" ||
    s === "UserStatusRecently"
    // optional:
    // || s === "UserStatusLastWeek"
  )
}

// ===== Accounts =====
const accounts = [], clients = {}
let i = 1

while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(!api_id || !api_hash || !session){ i++; continue }

  accounts.push({
    phone, api_id, api_hash, session,
    id:`TG_ACCOUNT_${i}`,
    status:"pending",
    floodWaitUntil:null
  })
  i++
}

// ===== Client =====
async function getClient(acc){
  if(clients[acc.id]) return clients[acc.id]
  const client = new TelegramClient(
    new StringSession(acc.session),
    acc.api_id,
    acc.api_hash,
    { connectionRetries: 5 }
  )
  await client.connect()
  clients[acc.id] = client
  return client
}

// ===== Flood Parse =====
function parseFlood(err){
  const m = err.message || ""
  const r1 = m.match(/FLOOD_WAIT_(\d+)/)
  const r2 = m.match(/wait of (\d+) seconds/i)
  if(r1) return Number(r1[1])
  if(r2) return Number(r2[1])
  return null
}

// ===== Refresh =====
async function refreshAccount(acc){
  if(acc.floodWaitUntil && acc.floodWaitUntil < Date.now()){
    acc.floodWaitUntil = null
    acc.status = "active"
    await update(ref(db,`accounts/${acc.id}`),{
      status:"active",
      floodWaitUntil:null
    })
  }
}

// ===== Check =====
async function checkTGAccount(acc){
  try{
    await refreshAccount(acc)
    const client = await getClient(acc)
    await client.getMe()

    acc.status = "active"
    acc.floodWaitUntil = null

    await update(ref(db,`accounts/${acc.id}`),{
      status:"active",
      phone:acc.phone,
      lastChecked:Date.now()
    })

  }catch(err){
    const wait = parseFlood(err)
    let status="error", flood=null

    if(wait){
      flood = Date.now() + (wait*1000) + BUFFER
      acc.status = "floodwait"
      acc.floodWaitUntil = flood
      status = "floodwait"
    }

    await update(ref(db,`accounts/${acc.id}`),{
      status,
      floodWaitUntil:flood,
      error:err.message,
      phone:acc.phone,
      lastChecked:Date.now()
    })
  }
}

// ===== Auto Check =====
async function autoCheck(){
  for(const a of accounts){
    await refreshAccount(a)
    await checkTGAccount(a)
    await sleep(2000)
  }
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Rotation =====
let accIndex = 0
function getAvailableAccount(){
  const now = Date.now()

  for(let i=0;i<accounts.length;i++){
    accIndex = (accIndex + 1) % accounts.length
    const acc = accounts[accIndex]

    if(acc.status==="active" && (!acc.floodWaitUntil || acc.floodWaitUntil < now)){
      return acc
    }
  }
  return null
}

// ===== Fast Fetch =====
async function fastGetMembers(client, entity){
  let all = []
  let chunk = 200
  let offsets = []

  for(let i=0;i<5000;i+=chunk){
    offsets.push(i)
  }

  const results = await Promise.all(
    offsets.map(offset =>
      client.getParticipants(entity,{limit:chunk, offset}).catch(()=>[])
    )
  )

  results.forEach(r => all.push(...r))
  return all
}

// ===== Members (SMART FILTER) =====
app.post('/members', async(req,res)=>{
  try{
    const {group} = req.body
    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})

    const client = await getClient(acc)

    // auto join
    try{
      await client.invoke(new Api.channels.JoinChannel({channel: group}))
    }catch{}

    const entity = await client.getEntity(group)
    const all = await fastGetMembers(client, entity)

    const members = all
      .filter(p => !p.bot && isActiveUser(p))
      .map(p => ({
        user_id:p.id,
        username:p.username,
        access_hash:p.access_hash,
        status:p.status?.className || "unknown"
      }))

    res.json(members)

  }catch(err){
    res.json({error:err.message})
  }
})

// ===== Add Member =====
app.post('/add-member', async(req,res)=>{
  try{
    const {username,user_id,access_hash,targetGroup} = req.body
    const clientAcc = getAvailableAccount()

    if(!clientAcc){
      return res.json({
        status:"failed",
        reason:"All accounts FloodWait",
        accountUsed:"none"
      })
    }

    if(!username && (!user_id || !access_hash)){
      return res.json({
        status:"skipped",
        reason:"missing username/access_hash",
        accountUsed:"none",
        silent:true
      })
    }

    const client = await getClient(clientAcc)

    // auto join
    try{
      await client.invoke(new Api.channels.JoinChannel({channel: targetGroup}))
    }catch{}

    const group = await client.getEntity(targetGroup)
    const groupKey = cleanGroup(targetGroup)

    // check existing
    const snap = await get(ref(db,`groups/${groupKey}`))
    const targetMembers = Object.values(snap.val()||{}).map(m=>m.username||m.user_id)

    const id = username || user_id
    if(targetMembers.includes(id)){
      return res.json({
        status:"skipped",
        reason:"already in target group",
        accountUsed:"none",
        silent:true
      })
    }

    // check history
    const histSnap = await get(ref(db,'history'))
    const histList = Object.values(histSnap.val()||{})

    if(histList.some(h=>(h.username===username||h.user_id===user_id)&&h.status==="success")){
      return res.json({
        status:"skipped",
        reason:"already in history",
        accountUsed:"none",
        silent:true
      })
    }

    let status="failed", reason="unknown"

    try{
      let userEntity = username
        ? await client.getEntity(username)
        : new Api.InputUser({
            userId:user_id,
            accessHash:BigInt(access_hash)
          })

      await client.invoke(new Api.channels.InviteToChannel({
        channel:group,
        users:[userEntity]
      }))

      status="success"
      reason="joined"

      await sleep(ADD_DELAY)

    }catch(err){
      const wait = parseFlood(err)

      if(wait){
        const until = Date.now() + (wait*1000) + BUFFER
        clientAcc.status = "floodwait"
        clientAcc.floodWaitUntil = until

        await update(ref(db,`accounts/${clientAcc.id}`),{
          status:"floodwait",
          floodWaitUntil:until
        })

        reason = `FloodWait ${wait}s | Ready ${new Date(until).toLocaleString()}`
      }else{
        reason = err.message
      }
    }

    // save history
    await push(ref(db,'history'),{
      username,
      user_id,
      status,
      reason,
      accountUsed:clientAcc.id,
      phone:clientAcc.phone,
      targetGroup,
      timestamp:Date.now()
    })

    res.json({
      status,
      reason,
      accountUsed:clientAcc.id
    })

  }catch(err){
    res.json({
      status:"failed",
      reason:err.message,
      accountUsed:"unknown"
    })
  }
})

// ===== Account Status =====
app.get('/account-status', async(req,res)=>{
  const snap = await get(ref(db,'accounts'))
  const now = Date.now()
  const data = snap.val()||{}

  for(const id in data){
    const a = data[id]
    if(a.floodWaitUntil){
      const remain = a.floodWaitUntil - now

      if(remain <= 0){
        a.status = "active"
        a.floodWaitUntil = null

        await update(ref(db,`accounts/${id}`),{
          status:"active",
          floodWaitUntil:null
        })
      }else{
        a.remaining = remain
      }
    }
  }

  res.json(data)
})

// ===== History =====
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'))
})

// ===== Start =====
const PORT = process.env.PORT || 3000
app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`))
