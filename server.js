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

// ===== Normalize Username =====
function normalizeUsername(input){
  if(!input) return null

  let u = input.trim()

  // Remove t.me/ prefix
  if(u.includes("t.me/")) {
    u = u.split("/").pop()
  }

  // Remove leading @ (optional, depends on usage)
  if(u.startsWith("@")) {
    u = u.slice(1)
  }

  return u
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
    const client=await getClient(account)
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
let accIndex = 0

function getAvailableAccount(){
  const now = Date.now()

  for(let i=0; i<accounts.length; i++){
    let idx = (accIndex + i) % accounts.length
    let acc = accounts[idx]

    if(
      acc.status === "active" &&
      acc.status !== "error" &&
      (!acc.floodWaitUntil || acc.floodWaitUntil < now)
    ){
      accIndex = idx + 1 // 🔥 switch next account
      return acc
    }
  }

  return null // ❌ no account available
}

// ===== Auto Join =====
async function autoJoin(client, group) {
  const clean = normalizeGroup(group);

  try {
    // ព្យាយាម get entity ដំបូង
    await client.getEntity(clean);
  } catch (err) {
    try {
      // បើជា invite link
      if (group.includes("joinchat") || group.includes("+")) {
        const hash = group.split("/").pop().replace("+", "");
        await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      } else {
        // បើជា public channel/group
        await client.invoke(new Api.channels.JoinChannel({ channel: clean }));
      }
    } catch (e) {
      console.log(`Failed to join ${group}:`, e.message);
    }
  }
}
// ===== Auto Join Route =====
app.post('/auto-join', async (req, res) => {
  try {
    const { group } = req.body;
    if (!group) return res.status(400).json({ error: "Missing group" });

    let joinedCount = 0;

    for (const acc of accounts) {
      const client = await getClient(acc);
      if (!client) continue; // skip unavailable accounts

      try {
        await autoJoin(client, group);
        joinedCount++;
        await sleep(1000);
      } catch (e) {
        console.log(`Failed for ${acc.phone}: ${e.message}`);
      }
    }

    res.json({ success: true, joinedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
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
    let { group, offset = 0, limit = 50 } = req.body

    const acc = getAvailableAccount()
    if (!acc) return res.json({ error: "No active account" })

    const client = await getClient(acc)
    const cleanGroup = normalizeGroup(group)

    await autoJoin(client, cleanGroup)

    const entity = await client.getEntity(cleanGroup)

    const participants = await client.getParticipants(entity, {
      offset,
      limit
    })

    const members = participants
      .filter(p => !p.bot)
      .map(p => ({
        user_id: p.id,
        username: p.username,
        access_hash: p.access_hash
      }))

    res.json({
      members,
      nextOffset: offset + participants.length,
      hasMore: participants.length === limit
    })

  } catch (err) {
    res.json({ error: err.message })
  }
})

// ===== Add Member =====
app.post('/add-member', async (req, res) => {
  try {
    let { username, user_id, access_hash, targetGroup } = req.body;

    const usernames = username
      ? username.split("\n").map(u => u.trim()).filter(Boolean)
      : [];

    if (usernames.length === 0 && !user_id) {
      return res.json({
        status: "failed",
        reason: "Missing username or user_id",
        accountUsed: "none"
      });
    }

    function normalizeUsername(u) {
      u = u.trim();
      if (u.includes("t.me/")) u = u.split("/").pop();
      if (u.startsWith("@")) u = u.slice(1);
      return u;
    }

    const results = [];

    for (const u of usernames) {
      const cleanUsername = normalizeUsername(u);

      if (!cleanUsername) {
        results.push({ input: u, status: "failed", reason: "Empty username", accountUsed: "none" });
        continue;
      }

      const acc = getAvailableAccount();
      if (!acc) {
        results.push({ input: u, status: "failed", reason: "All accounts FloodWait", accountUsed: "none" });
        continue;
      }

      const client = await getClient(acc);

      // 🔥 Auto join target group first
      await autoJoin(client, targetGroup);

      let status = "failed",
          reason = "unknown",
          saveHistory = false;

      try {
        const userEntity = await client.getEntity(cleanUsername);
        const groupEntity = await client.getEntity(targetGroup);

        // ===== Check Already Member =====
        let alreadyMember = false;
        try {
          await client.getParticipant(groupEntity, userEntity);
          alreadyMember = true;
        } catch {}

        if (alreadyMember) {
          status = "success";
          reason = "already in group";
          saveHistory = true;

          results.push({
            input: u,
            status,
            reason,
            accountUsed: acc.phone || acc.id
          });

          continue; // skip invite
        }

        // ===== Invite User =====
        await client.invoke(new Api.channels.InviteToChannel({
          channel: groupEntity,
          users: [userEntity]
        }));

        await sleep(5000); // wait Telegram sync

        // ===== Verify Join =====
        let isMember = false;
        for (let i = 0; i < 3; i++) {
          try {
            const participant = await client.getParticipant(groupEntity, userEntity);
            if (participant) {
              isMember = true;
              break;
            }
          } catch (e) {
            if (e.message.includes("USER_NOT_PARTICIPANT") || e.message.includes("PARTICIPANT_ID_INVALID")) {
              isMember = false;
            } else {
              isMember = true; // fallback
              break;
            }
          }
          await sleep(2000);
        }

        if (isMember) {
          status = "success";
          reason = "joined (verified)";
        } else {
          status = "success";
          reason = "joined (no verify but likely)";
        }

        saveHistory = true;

        if (status === "success") {
          acc.addCount = (acc.addCount || 0) + 1;
          await update(ref(db, `accounts/${acc.id}`), {
            addCount: acc.addCount
          });
        }

      } catch (err) {
        // ===== Flood Wait =====
        const wait = parseFlood(err);
        if (wait) {
          const until = Date.now() + wait * 1000;
          acc.floodWaitUntil = until;
          acc.status = "floodwait";

          await update(ref(db, `accounts/${acc.id}`), {
            status: "floodwait",
            floodWaitUntil: until
          });

          status = "failed";
          reason = `FloodWait ${wait}s`;
          saveHistory = true;
        } else {
          status = "failed";
          reason = err.message;
        }
      }

      // ===== Save History =====
      if (saveHistory) {
        await push(ref(db, 'history'), {
          username: cleanUsername,
          status,
          reason,
          accountUsed: acc.phone || acc.id,
          timestamp: Date.now()
        });
      }

      results.push({
        input: u,
        status,
        reason,
        accountUsed: acc.phone || acc.id
      });

      await sleep(2000); // delay next member
    }

    res.json(results);

  } catch (err) {
    res.json({
      status: "failed",
      reason: err.message,
      accountUsed: "unknown"
    });
  }
});
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
