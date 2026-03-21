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

let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(!api_id||!api_hash||!session){ i++; continue }

  accounts.push({
    phone, api_id, api_hash, session,
    id:`TG_ACCOUNT_${i}`,
    status:"pending",
    floodWaitUntil:null
  })
  i++
}

// ===== Telegram Client =====
async function getClient(account){
  if(clients[account.id]) return clients[account.id]
  const client=new TelegramClient(
    new StringSession(account.session),
    account.api_id,
    account.api_hash,
    { connectionRetries:5 }
  )
  await client.connect()
  clients[account.id]=client
  return client
}

// ===== Flood Parser =====
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
  if(account.floodWaitUntil && account.floodWaitUntil < Date.now()){
    account.floodWaitUntil = null
    account.status = "active"
    await update(ref(db, `accounts/${account.id}`), {
      status: "active",
      floodWaitUntil: null
    })
  }
}

// ===== Check Account =====
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)
    const client=await getClient(account)
    await client.getMe()

    account.status="active"
    account.floodWaitUntil=null

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      phone:account.phone,
      lastChecked:Date.now(),
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

    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:floodUntil,
      error:err.message,
      phone:account.phone,
      lastChecked:Date.now()
    })
  }
}

// ===== Auto Check =====
async function autoCheck(){
  for(const acc of accounts){
    await refreshAccountStatus(acc)
    await checkTGAccount(acc)
    await sleep(2000)
  }
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Get Available Account =====
function getAvailableAccount(){
  const now = Date.now()
  return accounts.find(a => a.status === "active" && (!a.floodWaitUntil || a.floodWaitUntil < now))
}

// ===== Members =====
app.post('/members',async(req,res)=>{
  try{
    const {group}=req.body
    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client=await getClient(acc)
    const entity=await client.getEntity(group)

    let offset=0, limit=200, all=[]
    while(true){
      const participants=await client.getParticipants(entity,{limit,offset})
      if(!participants.length) break
      all=all.concat(participants)
      offset+=participants.length
    }

    const members=all.filter(p=>!p.bot).map(p=>({
      user_id:p.id,
      username:p.username,
      access_hash:p.access_hash,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
    }))

    res.json(members)
  }catch(err){
    res.json({error:err.message})
  }
})

// ===== Export Target Members =====
app.post('/export-members', async(req,res)=>{
  try{
    const {targetGroup}=req.body
    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client = await getClient(acc)
    const entity = await client.getEntity(targetGroup)

    let offset=0, limit=200, all=[]
    while(true){
      const participants = await client.getParticipants(entity,{limit,offset})
      if(!participants.length) break
      all.push(...participants)
      offset+=participants.length
    }

    const members = all.filter(p=>!p.bot).map(p=>({
      user_id:p.id,
      username:p.username,
      access_hash:p.access_hash,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
    }))

    res.json({count:members.length, members})
  }catch(err){
    res.json({error:err.message})
  }
})

// ===== Add Members (Batch + History + Target Skip) =====
app.post('/add-member', async (req, res) => {
  try {
    const { users, targetGroup } = req.body // users = [{username, user_id, access_hash}, ...]

    if(!users || !users.length) return res.json({status:"failed", reason:"No users"})

    const acc = getAvailableAccount()
    if(!acc) return res.json({status:"failed", reason:"All accounts FloodWait", accountUsed:"none"})

    const client = await getClient(acc)
    const group = await client.getEntity(targetGroup)

    // ===== Preload target members =====
    const snap = await get(ref(db, `groups/${targetGroup.replace(/\./g,'_')}`))
    const targetMembers = Object.values(snap.val()||{}).map(m=>m.username || m.user_id)

    // ===== Preload history =====
    const histSnap = await get(ref(db, 'history'))
    const histList = Object.values(histSnap.val() || {})

    const results = []

    for(const m of users){
      const id = m.username || m.user_id

      if(targetMembers.includes(id)){
        results.push({id,status:"skipped",reason:"already in target",accountUsed:"none"})
        continue
      }

      if(histList.some(h => (h.username===m.username || h.user_id===m.user_id) && h.status==="success")){
        results.push({id,status:"skipped",reason:"already in history",accountUsed:"none"})
        continue
      }

      let status="failed", reason="unknown"

      try{
        let userEntity
        if(m.username) userEntity = await client.getEntity(m.username)
        else userEntity = new Api.InputUser({ userId:m.user_id, accessHash:BigInt(m.access_hash) })

        await client.invoke(new Api.channels.InviteToChannel({ channel:group, users:[userEntity] }))

        status="success"; reason="joined"
        await sleep(15000 + Math.floor(Math.random()*5000)) // faster batch delay

      }catch(err){
        const wait=parseFlood(err)
        if(wait){
          const until=Date.now()+wait*1000
          acc.floodWaitUntil=until
          acc.status="floodwait"
          await update(ref(db,`accounts/${acc.id}`),{ status:"floodwait", floodWaitUntil:until })
          const ready=new Date(until).toLocaleString()
          reason=`FloodWait ${wait}s | Ready ${ready}`
        } else reason=err.message
      }

      await push(ref(db,'history'),{ username:m.username, user_id:m.user_id, status, reason, accountUsed:acc.id, timestamp:Date.now() })
      results.push({id,status,reason,accountUsed:acc.id})
    }

    res.json({results})

  }catch(err){
    res.json({status:"failed",reason:err.message,accountUsed:"unknown"})
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
      const remain = a.floodWaitUntil-now
      if(remain<=0){
        a.status="active"
        a.floodWaitUntil=null
        await update(ref(db,`accounts/${id}`),{ status:"active", floodWaitUntil:null })
      } else a.remaining = remain
    }
  }
  res.json(data)
})

// ===== History =====
app.get('/history', async(req,res)=>{
  const snap=await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
