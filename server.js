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
const sleep = ms => new Promise(r=>setTimeout(r,ms))

// ===== Firebase =====
initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
})
const db = getDatabase()

// ===== Accounts =====
const accounts=[], clients={}
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]
  if(!api_id||!api_hash||!session){i++;continue}
  accounts.push({phone,api_id,api_hash,session,id:`TG_ACCOUNT_${i}`,status:"pending",floodWaitUntil:null})
  i++
}

// ===== Client =====
async function getClient(acc){
  if(clients[acc.id]) return clients[acc.id]
  const client=new TelegramClient(new StringSession(acc.session),acc.api_id,acc.api_hash,{connectionRetries:5})
  await client.connect()
  clients[acc.id]=client
  return client
}

// ===== Flood Parse =====
function parseFlood(err){
  const m = err.message||""
  const r1 = m.match(/FLOOD_WAIT_(\d+)/)
  const r2 = m.match(/wait of (\d+) seconds/i)
  if(r1) return Number(r1[1])
  if(r2) return Number(r2[1])
  return null
}

// ===== Refresh Flood =====
async function refreshAccount(acc){
  if(acc.floodWaitUntil && acc.floodWaitUntil < Date.now()){
    acc.floodWaitUntil=null
    acc.status="active"
    await update(ref(db,`accounts/${acc.id}`),{status:"active",floodWaitUntil:null})
  }
}

// ===== Check Account =====
async function checkTGAccount(acc){
  try{
    await refreshAccount(acc)
    const client = await getClient(acc)
    await client.getMe()
    acc.status="active"; acc.floodWaitUntil=null
    await update(ref(db,`accounts/${acc.id}`),{status:"active",phone:acc.phone,lastChecked:Date.now()})
  }catch(err){
    const wait = parseFlood(err)
    let status="error", flood=null
    if(wait){
      status="floodwait"; flood=Date.now()+wait*1000; acc.floodWaitUntil=flood; acc.status="floodwait"
    }
    await update(ref(db,`accounts/${acc.id}`),{status,floodWaitUntil:flood,error:err.message,phone:acc.phone,lastChecked:Date.now()})
  }
}

// ===== Auto Check =====
async function autoCheck(){
  for(const a of accounts){await refreshAccount(a); await checkTGAccount(a); await sleep(2000)}
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Available Accounts (multi) =====
function getAvailableAccounts(){
  const now=Date.now()
  return accounts.filter(a=>a.status==="active" && (!a.floodWaitUntil || a.floodWaitUntil<now))
}

// ===== Members =====
app.post('/members',async(req,res)=>{
  try{
    const {group}=req.body
    const accs = getAvailableAccounts()
    if(accs.length===0) return res.json({error:"No active account"})
    const client = await getClient(accs[0])
    const entity = await client.getEntity(group)
    let offset=0,limit=200,all=[]
    while(true){
      const participants = await client.getParticipants(entity,{limit,offset})
      if(!participants.length) break
      all.push(...participants)
      offset+=participants.length
    }
    const members = all.filter(p=>!p.bot).map(p=>({user_id:p.id,username:p.username,access_hash:p.access_hash}))
    res.json(members)
  }catch(err){res.json({error:err.message})}
})

// ===== Add Member Ultra =====
app.post('/add-member',async(req,res)=>{
  try{
    const {username,user_id,access_hash,targetGroup}=req.body
    const accs = getAvailableAccounts()
    if(accs.length===0) return res.json({status:"failed",reason:"All accounts FloodWait",accountUsed:"none"})
    if(!username && (!user_id || !access_hash)) return res.json({status:"skipped",reason:"missing username/access_hash",accountUsed:"none",silent:true})

    const clientAcc = accs.shift() // use first available account
    const client = await getClient(clientAcc)
    const group = await client.getEntity(targetGroup)

    const snap = await get(ref(db,`groups/${targetGroup.replace(/\./g,'_')}`))
    const targetMembers = Object.values(snap.val()||{}).map(m=>m.username||m.user_id)
    const id=username||user_id
    if(targetMembers.includes(id)) return res.json({status:"skipped",reason:"already in target group",accountUsed:"none",silent:true})

    const histSnap = await get(ref(db,'history'))
    const histList = Object.values(histSnap.val()||{})
    if(histList.some(h=>(h.username===username||h.user_id===user_id)&&h.status==="success")) return res.json({status:"skipped",reason:"already in history",accountUsed:"none",silent:true})

    let status="failed", reason="unknown"
    try{
      let userEntity=username?await client.getEntity(username):new Api.InputUser({userId:user_id,accessHash:BigInt(access_hash)})
      await client.invoke(new Api.channels.InviteToChannel({channel:group,users:[userEntity]}))
      status="success"; reason="joined"
      await sleep(5000) // ultra speed delay 5s
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        const until=Date.now()+wait*1000
        clientAcc.floodWaitUntil=until; clientAcc.status="floodwait"
        await update(ref(db,`accounts/${clientAcc.id}`),{status:"floodwait",floodWaitUntil:until})
        reason=`FloodWait ${wait}s | Ready ${new Date(until).toLocaleString()}`
      }else reason=err.message
    }

    await push(ref(db,'history'),{username,user_id,status,reason,accountUsed:clientAcc.id,timestamp:Date.now()})
    res.json({status,reason,accountUsed:clientAcc.id})
  }catch(err){res.json({status:"failed",reason:err.message,accountUsed:"unknown"})}
})

// ===== Account Status =====
app.get('/account-status',async(req,res)=>{
  const snap=await get(ref(db,'accounts'))
  const now=Date.now()
  const data=snap.val()||{}
  for(const id in data){
    const a=data[id]
    if(a.floodWaitUntil){const remain=a.floodWaitUntil-now;if(remain<=0){a.status="active";a.floodWaitUntil=null;await update(ref(db,`accounts/${id}`),{status:"active",floodWaitUntil:null})}else a.remaining=remain}
  }
  res.json(data)
})

// ===== History =====
app.get('/history',async(req,res)=>{
  const snap=await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`Ultra Speed Server running on port ${PORT}`))
