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
  if(!api_id||!api_hash||!session){i++; continue}
  accounts.push({
    phone, api_id, api_hash, session,
    id:`TG_ACCOUNT_${i}`,
    status:"pending",
    floodWaitUntil:null,
    lastUsed:0
  })
  i++
}
console.log(`Loaded ${accounts.length} Telegram accounts.`)

// ===== Client =====
async function getClient(account){
  if(clients[account.id]) return clients[account.id]
  const client=new TelegramClient(new StringSession(account.session), account.api_id, account.api_hash,{connectionRetries:5})
  await client.connect()
  clients[account.id]=client
  return client
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

// ===== Auto Check =====
async function autoCheck(){
  const now = Date.now()
  await Promise.all(accounts.map(async (acc) => {
    try{
      if(acc.floodWaitUntil && acc.floodWaitUntil < now){
        acc.status="active"
        acc.floodWaitUntil=null
        await update(ref(db, `accounts/${acc.id}`), {status:"active",floodWaitUntil:null})
      }
      if(acc.status !== "active") return
      const client = await getClient(acc)
      await client.getMe()
      acc.status="active"; acc.floodWaitUntil=null
      await update(ref(db, `accounts/${acc.id}`), {status:"active", lastChecked:now, floodWaitUntil:null})
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        acc.status="floodwait"; acc.floodWaitUntil=now+wait*1000
        await update(ref(db, `accounts/${acc.id}`), {status:"floodwait",floodWaitUntil:acc.floodWaitUntil})
      } else {
        acc.status="error"
        await update(ref(db, `accounts/${acc.id}`), {status:"error",error:err.message})
      }
    }
  }))
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Smart Account =====
function getAvailableAccount(){
  const now = Date.now()
  const readyAccounts = accounts.filter(a => a.status==="active" && (!a.floodWaitUntil || a.floodWaitUntil < now))
  if(!readyAccounts.length) return null
  readyAccounts.sort((a,b)=> (a.lastUsed||0)-(b.lastUsed||0))
  const acc = readyAccounts[0]
  acc.lastUsed=now
  return acc
}

// ===== Export + Check Members =====
app.post('/export-check-members', async (req,res)=>{
  try{
    const { sourceGroup, targetGroup } = req.body
    if(!sourceGroup || !targetGroup) return res.json({error:"Missing sourceGroup or targetGroup"})
    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client = await getClient(acc)
    const srcEntity = await client.getEntity(sourceGroup)
    const tgtEntity = await client.getEntity(targetGroup)

    let allSrc=[], offset=0, limit=200
    while(true){
      const participants = await client.getParticipants(srcEntity,{limit,offset})
      if(!participants.length) break
      allSrc.push(...participants)
      offset += participants.length
    }

    offset=0
    let allTgt=[]
    while(true){
      const participants = await client.getParticipants(tgtEntity,{limit,offset})
      if(!participants.length) break
      allTgt.push(...participants)
      offset += participants.length
    }

    const targetSet = new Set(allTgt.map(p=>p.username||p.id))
    const members = allSrc.filter(p=>!p.bot).map(p=>({
      user_id: p.id,
      username: p.username,
      access_hash: p.access_hash,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`,
      alreadyInTarget: targetSet.has(p.username||p.id)
    }))
    res.json({count:members.length, members})
  }catch(err){res.json({error:err.message})}
})

// ===== Add Member =====
app.post('/add-member', async (req,res)=>{
  try{
    const { username, user_id, access_hash, targetGroup } = req.body
    const clientAcc = getAvailableAccount()
    if (!clientAcc) return res.json({ status:"failed", reason:"All accounts FloodWait", accountUsed:"none" })
    if (!username && (!user_id || !access_hash)) return res.json({status:"skipped",reason:"missing username/access_hash",accountUsed:"none",silent:true})

    const client = await getClient(clientAcc)
    const group = await client.getEntity(targetGroup)

    let status="failed", reason="unknown"
    try{
      const userEntity = username ? await client.getEntity(username)
                                 : new Api.InputUser({ userId:user_id, accessHash:BigInt(access_hash) })
      await client.invoke(new Api.channels.InviteToChannel({ channel:group, users:[userEntity] }))
      status="success"; reason="joined"
      await sleep(3000 + Math.floor(Math.random()*2000))
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        const until=Date.now()+wait*1000
        clientAcc.floodWaitUntil=until
        clientAcc.status="floodwait"
        await update(ref(db,`accounts/${clientAcc.id}`),{ status:"floodwait", floodWaitUntil:until })
        const ready=new Date(until).toLocaleString()
        reason=`FloodWait ${wait}s | Ready ${ready}`
      } else reason=err.message
    }

    await push(ref(db,'history'),{ username, user_id, status, reason, accountUsed:clientAcc.id, timestamp:Date.now() })
    res.json({ status, reason, accountUsed:clientAcc.id })
  }catch(err){res.json({ status:"failed", reason:err.message, accountUsed:"unknown" })}
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
      if(remain<=0){ a.status="active"; a.floodWaitUntil=null; await update(ref(db,`accounts/${id}`),{status:"active",floodWaitUntil:null}) }
      else a.remaining=remain
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
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
