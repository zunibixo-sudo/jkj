require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ========== CONFIG - ALL FROM .env - REPLACE BEFORE START ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL;
const API_KEY = process.env.API_KEY;
const SUPPORT_LINK = process.env.SUPPORT_LINK || "https://t.me/support";
const ADMIN_IDS = (process.env.ADMIN_IDS || "7481724731,7710967611").split(',').map(v=>Number(v.trim())).filter(Boolean);

// Your 3 groups as you gave
const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID ? Number(process.env.ORDER_GROUP_ID) : -1004455897015;
const DEPOSIT_GROUP_ID = process.env.DEPOSIT_GROUP_ID ? Number(process.env.DEPOSIT_GROUP_ID) : -5090894763;
const SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : -5361354377;
const FORCE_JOIN_LINKS = (process.env.FORCE_JOIN_LINKS || "https://t.me/+Ig9neK566pw0Mzk1,https://t.me/+hvrNUdPa-tczNzFl,https://t.me/+hoKwsX8zLnQxZjFl").split(',').map(s=>s.trim()).filter(Boolean);
const GROUP_IDS = [ORDER_GROUP_ID, DEPOSIT_GROUP_ID, SUPPORT_GROUP_ID].filter(Boolean);

const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://bot.totocompamy.com";
const PORT = process.env.PORT || 3000;

const NAGRIKPAY_KEY = process.env.NAGRIKPAY_API_KEY;
const NAGRIKPAY_BASE = process.env.NAGRIKPAY_BASE_URL || "https://secure-pay.nagorikpay.com/api/payment/create";
const NAGRIKPAY_VERIFY = process.env.NAGRIKPAY_VERIFY_URL || "https://secure-pay.nagorikpay.com/api/payment/verify";

const GROUP_NOTIFY = (process.env.GROUP_NOTIFY_ENABLED || 'true') === 'true';
const MASK_IDS = (process.env.MASK_IDS_IN_GROUPS || 'true') === 'true';
const CURRENCY_DISPLAY = process.env.CURRENCY_DISPLAY || 'only_selected';
const FORCE_JOIN_ENABLED = (process.env.FORCE_JOIN_ENABLED || 'true') === 'true';
const NEW_USER_NOTIFY = (process.env.NEW_USER_NOTIFY || 'true') === 'true';

if(!BOT_TOKEN || !API_URL || !API_KEY){
  console.error("❌ Missing BOT_TOKEN / API_URL / API_KEY - Edit .env file in cPanel File Manager > Show Hidden Files");
  process.exit(1);
}

// ========== JSON DB - NO NATIVE MODULES - 100% CPANEL WITHOUT TERMINAL ==========
const DB_PATH = './database.json';
let dbData = {
  users: [],
  orders: [],
  transactions: [],
  settings: {
    inr_to_bdt: parseFloat(process.env.INR_TO_BDT || 1.35),
    inr_to_usd: parseFloat(process.env.INR_TO_USD || 0.012),
    enabled_categories: null,
    disabled_services: [],
    new_user_notify: true,
    api_url: API_URL,
    api_key: API_KEY
  },
  custom_prices: [], // {id, service_id, user_id, custom_rate, discount_percent, active}
  offers: [], // {id, title, discount_percent, valid_until, target_user_id, service_id, active}
  support_map: [],
  manual_services: [] // {id, name, category, rate_inr, min, max, description}
};
if(fs.existsSync(DB_PATH)){
  try{ dbData = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }catch(e){ console.log("DB corrupted, fresh"); }
}
function saveDB(){ fs.writeFileSync(DB_PATH, JSON.stringify(dbData, null, 2)); }

// Helpers
function getUser(id){ return dbData.users.find(u=>u.id===id); }
function ensureUser(msg){
  const id=msg.from.id;
  let u=getUser(id);
  let isNew=false;
  if(!u){
    isNew=true;
    u={
      id, username:msg.from.username||'', first_name:msg.from.first_name||'',
      lang:null, currency:null,
      balance_bdt:0, balance_usd:0,
      total_spent_bdt:0, total_spent_usd:0,
      discount:0, banned:false,
      created_at:new Date().toISOString()
    };
    dbData.users.push(u);
    saveDB();
  }
  return isNew;
}
function isAdmin(id){ return ADMIN_IDS.includes(id); }
function getSetting(k, def=null){ return dbData.settings[k]!==undefined ? dbData.settings[k] : def; }
function setSetting(k,v){ dbData.settings[k]=v; saveDB(); }
function getConversionRates(){
  return {
    BDT: parseFloat(getSetting('inr_to_bdt', parseFloat(process.env.INR_TO_BDT || 1.35))),
    USD: parseFloat(getSetting('inr_to_usd', parseFloat(process.env.INR_TO_USD || 0.012)))
  };
}
function formatMoney(amount, currency){
  const c=(currency||'BDT').toUpperCase();
  return c==='USD' ? `$${amount.toFixed(2)}` : `৳${amount.toFixed(2)}`;
}
function maskId(id){
  const s=String(id);
  if(!MASK_IDS) return s;
  if(s.length<=2) return "***";
  if(s.length<=4) return s[0]+"***"+s[s.length-1];
  return s.substring(0,2)+"***"+s.substring(s.length-2);
}
function getUserBalanceInfo(user){
  const curr=user.currency||'BDT';
  if(curr==='USD') return {amount:user.balance_usd||0, code:'USD', symbol:'$'};
  return {amount:user.balance_bdt||0, code:'BDT', symbol:'৳'};
}
function addBalance(userId, amount, currency){
  const u=getUser(userId); if(!u) return;
  const c=(currency||'BDT').toUpperCase();
  if(c==='USD') u.balance_usd=(u.balance_usd||0)+amount;
  else u.balance_bdt=(u.balance_bdt||0)+amount;
  saveDB();
}
function deductBalance(userId, amount, currency){
  const u=getUser(userId); if(!u) return;
  const c=(currency||'BDT').toUpperCase();
  if(c==='USD'){ u.balance_usd=(u.balance_usd||0)-amount; u.total_spent_usd=(u.total_spent_usd||0)+amount; }
  else { u.balance_bdt=(u.balance_bdt||0)-amount; u.total_spent_bdt=(u.total_spent_bdt||0)+amount; }
  saveDB();
}

// Cancel helper
const CANCEL_TEXTS=["❌ Cancel","🚫 Cancel","❌ বাতিল","/cancel","Cancel","cancel"];
function isCancel(t){ if(!t) return false; return CANCEL_TEXTS.includes(t.trim()) || t.trim().toLowerCase()==='cancel' || t.trim().toLowerCase()==='/cancel'; }
function cancelKb(lang){ return {keyboard:[[{text: lang==='bn' ? "❌ বাতিল" : "❌ Cancel"}]], resize_keyboard:true}; }

// Translations - Currency only selected, no exchange rate shown to users (your requirement)
const T={
en:{
  select_lang:"🌐 Select language:",
  select_currency:"💱 Select Currency:\nChoose BDT (৳) or USD ($)\n\nPrices will be shown in your selected currency only.",
  currency_set:"✅ Currency set to $CURR$",
  must_join:"🔐 To use this bot, you must join our 3 channels/groups first, then click Verify.\n\nAll groups are public but only admin can send messages, you can only view. Bot is admin.",
  join_verify:"✅ Verify Joined",
  not_joined:"❌ You have not joined all groups yet. Please join all 3 and then click Verify.\n\nNot joined: $MISSING$\n\nJoin links below:",
  joined_ok:"✅ Thanks for joining! Now you can use bot.",
  welcome:"👋 Welcome to 100% Free Lifetime SMM Panel Bot!\n\n💰 Balance: $BALANCE$ | ID: $ID$\n\nChoose an option:",
  new_order:"🛒 New Order", track_order:"📦 Track Order", add_funds:"💰 Add Funds", profile:"👤 Profile", support:"🎧 Support", language:"🌐 Language", currency:"💱 Currency", cancel:"❌ Cancel",
  ask_cat:"📂 Step 1️⃣/5️⃣ - Select Category\nYour currency: $CURR$ only\n\nTap category or type Service ID",
  ask_service:"🛠 Step 2️⃣/5️⃣ - Service in $CAT$\nPrice: $PRICE$ $CURR$/1k\nMin $MIN$ Max $MAX$",
  ask_link:"🔗 Step 3️⃣/5️⃣ - Send Link\nExample: https://instagram.com/username\n\nCancel to abort",
  ask_qty:"🔢 Step 4️⃣/5️⃣ - Send Quantity\nMin $MIN$ Max $MAX$\nPrice $PRICE$ $CURR$/1k\n\nCancel to abort",
  invalid_link:"❌ Invalid link. Must start with http/https or Cancel",
  invalid_qty:"❌ Quantity must be $MIN$-$MAX$",
  invalid_sid:"❌ Service ID $ID$ not found! May be disabled by admin or removed by provider. Try another ID or use manual service or Cancel.\n\nAdmin can Test API in /admin.",
  insufficient:"❌ Low balance Need $NEED$ Have $HAVE$ ($CURR$)",
  confirm:"📋 Step 5️⃣/5️⃣ *Confirm Order*\n\n🛠 $NAME$ [ID:$ID$]\n📂 $CAT$\n🔗 $LINK$\n🔢 $QTY$\n💰 Total: $TOTAL$ $CURR$\nManual: $MANUAL$",
  order_ok:"✅ Order #$OID$ Placed!\n💰 $CHARGE_USER$ $CURR$\nStatus: Pending",
  order_ok_manual:"✅ Manual Order #$OID$ Created!\n💰 $CHARGE_USER$ $CURR$\nAdmin will process manually.",
  no_orders:"No orders yet", your_orders:"📦 Your last 10 orders:",
  profile_msg:"👤 *Profile*\nID: $ID$\nName: $NAME$ (@$USERNAME$)\nLang: $LANG$ | Curr: $CURR$\n\nBDT: ৳$BDT$ | USD: $$USD$\nSpent BDT: ৳$SPENT_BDT$ | USD: $$SPENT_USD$\nOrders: $TOTAL_ORDERS$ Discount: $DISC$%",
  balance_msg:"💰 BDT: ৳$BDT$ | USD: $$USD$\nCurrent: $CURR_WALLET$ ($CURR$)\n\nSend amount in $CURR$ to add (NagrikPay only):",
  ask_gateway:"💳 Pay $AMT$ $CURR$ via NagrikPay (bKash/Nagad/Rocket/Card) - Only gateway for BDT",
  payment_created:"💳 Payment $AMT$ created:\n$URL$\nAfter pay click Verify - Auto adds",
  payment_verified:"✅ Verified! $AMT$ added. New $BAL$",
  support_ask:"✍️ Support message (or Cancel):\nWill be forwarded to support group", support_sent:"✅ Sent to admin support group", support_fwd:"📩 Support from $ID$ (@$USER$) $CURR$ $LANG$\n\n$MSG$",
  admin_panel:"👑 *Admin Final - cPanel Only*\nUsers $U$ Orders $O$ Pending $P$\nTBDT ৳$TBDT$ TUSD $$TUSD$\nAPI: $API_URL$\nGroups: Order $ORDER_G$ Deposit $DEPOSIT_G$ Support $SUPPORT_G$\nRates hidden from users (only admin sees)",
  search_user_prompt:"🔍 Send user ID to search (or Cancel):",
  user_not_found:"❌ User $ID$ not found",
  user_found:"👤 *User $ID$*\nName: $NAME$ (@$USERNAME$)\nLang: $LANG$ | Curr: $CURR$\nBDT: ৳$BDT$ | USD: $$USD$\nSpent: ৳$SPENT_BDT$/$$SPENT_USD$\nJoined: $JOINED$\nBanned: $BANNED$\nOrders: $ORDERS$",
  api_test_ok:"✅ SMM API OK! Services: $SVC_COUNT$ Balance: $BAL$ $CURR$\nURL: $URL$",
  api_test_fail:"❌ SMM API Fail! $ERR$\nURL: $URL$\nFix: Check .env API_URL/API_KEY or use Manual Services",
  offer_created:"✅ Offer $TITLE$ $DISC$% Days $DAYS$ Target $TARGET$ Service $SERVICE$ created",
  cancelled:"❌ Cancelled, back to menu",
},
bn:{
  select_lang:"🌐 ভাষা নির্বাচন করুন:", select_currency:"💱 মুদ্রা নির্বাচন করুন:\nBDT (৳) বা USD ($) বেছে নিন\n\nদাম শুধু আপনার মুদ্রায় দেখানো হবে।",
  currency_set:"✅ মুদ্রা $CURR$ সেট", welcome:"👋 স্বাগতম 100% ফ্রি লাইফটাইম SMM বট!\n\n💰 $BALANCE$ | ID $ID$\nবেছে নিন:",
  new_order:"🛒 নতুন অর্ডার", track_order:"📦 ট্র্যাক অর্ডার", add_funds:"💰 ফান্ড যোগ", profile:"👤 প্রোফাইল", support:"🎧 সাপোর্ট", language:"🌐 ভাষা", currency:"💱 মুদ্রা", cancel:"❌ বাতিল",
  must_join:"🔐 বট ব্যবহার করতে আপনাকে প্রথমে আমাদের ৩টি চ্যানেল/গ্রুপে জয়েন করতে হবে, তারপর Verify ক্লিক করুন।\n\nগ্রুপগুলো পাবলিক কিন্তু শুধু অ্যাডমিন মেসেজ পাঠাতে পারে, আপনি শুধু দেখতে পারবেন। বট অ্যাডমিন।",
  join_verify:"✅ Verify Joined", not_joined:"❌ আপনি এখনো সব গ্রুপে জয়েন করেননি। সবগুলোতে জয়েন করে Verify ক্লিক করুন।\n\nজয়েন করেননি: $MISSING$",
  joined_ok:"✅ জয়েন করার জন্য ধন্যবাদ! এখন বট ব্যবহার করতে পারবেন।",
  ask_cat:"📂 ধাপ 1️⃣/5️⃣ - ক্যাটাগরি বেছে নিন\nআপনার মুদ্রা: $CURR$ শুধু\n\nট্যাপ করুন বা Service ID লিখুন",
  ask_service:"🛠 ধাপ 2️⃣/5️⃣ - $CAT$ সার্ভিস\nদাম: $PRICE$ $CURR$/1k\nMin $MIN$ Max $MAX$",
  ask_link:"🔗 ধাপ 3️⃣/5️⃣ - লিংক পাঠান\nউদা: https://instagram.com/username\n\nবাতিল করতে Cancel",
  ask_qty:"🔢 ধাপ 4️⃣/5️⃣ - পরিমাণ\nMin $MIN$ Max $MAX$\nদাম $PRICE$ $CURR$/1k\n\nবাতিল করতে Cancel",
  invalid_link:"❌ ভুল লিংক", invalid_qty:"❌ পরিমাণ $MIN$-$MAX$", invalid_sid:"❌ Service ID $ID$ পাওয়া যায়নি! অ্যাডমিন বন্ধ করেছে বা প্রোভাইডার সরিয়েছে। অন্য ID চেষ্টা করুন বা ম্যানুয়াল সার্ভিস ব্যবহার করুন বা বাতিল।\n\nঅ্যাডমিন হলে /admin -> Test API করুন।",
  insufficient:"❌ ব্যালেন্স কম Need $NEED$ Have $HAVE$ ($CURR$)",
  confirm:"📋 ধাপ 5️⃣/5️⃣ *নিশ্চিত করুন*\n$NAME$ [ID:$ID$]\n📂 $CAT$\n🔗 $LINK$\n🔢 $QTY$\n💰 মোট: $TOTAL$ $CURR$\nManual: $MANUAL$",
  order_ok:"✅ অর্ডার #$OID$ সফল! $CHARGE_USER$ $CURR$", order_ok_manual:"✅ ম্যানুয়াল অর্ডার #$OID$ তৈরি! $CHARGE_USER$ $CURR$\nঅ্যাডমিন ম্যানুয়ালি প্রসেস করবে।",
  no_orders:"কোন অর্ডার নেই", your_orders:"📦 শেষ ১০টি অর্ডার:",
  profile_msg:"👤 *প্রোফাইল*\nID: $ID$\nনাম: $NAME$ (@$USERNAME$)\nভাষা: $LANG$ মুদ্রা: $CURR$\nBDT: ৳$BDT$ USD: $$USD$\nখরচ BDT: ৳$SPENT_BDT$ USD: $$SPENT_USD$\nঅর্ডার: $TOTAL_ORDERS$ ডিসকাউন্ট: $DISC$%",
  balance_msg:"💰 BDT: ৳$BDT$ USD: $$USD$ বর্তমান: $CURR_WALLET$ ($CURR$)\n$CURR$ এ পরিমাণ লিখুন (NagrikPay only):",
  ask_gateway:"💳 $AMT$ $CURR$ এর জন্য NagrikPay (bKash/Nagad) - BDT তে শুধু এটাই",
  payment_created:"💳 $AMT$ পেমেন্ট তৈরি: $URL$\nপে করে Verify করুন",
  payment_verified:"✅ যাচাই হয়েছে $AMT$ যোগ $BAL$",
  support_ask:"✍️ সাপোর্ট মেসেজ (বা বাতিল):\nসাপোর্ট গ্রুপে যাবে", support_sent:"✅ সাপোর্ট গ্রুপে পাঠানো হয়েছে", support_fwd:"📩 Support from $ID$ (@$USER$) $CURR$ $LANG$\n$MSG$",
  admin_panel:"👑 *Admin Final*\nUsers $U$ Orders $O$ Pending $P$\nTBDT ৳$TBDT$ TUSD $$TUSD$\nAPI: $API_URL$",
  search_user_prompt:"🔍 ইউজার ID পাঠান (বা বাতিল):", user_not_found:"❌ User $ID$ নেই",
  user_found:"👤 *User $ID$*\nName: $NAME$ (@$USERNAME$)\nLang: $LANG$ Curr: $CURR$\nBDT: ৳$BDT$ USD: $$USD$\nSpent: ৳$SPENT_BDT$/$$SPENT_USD$\nJoined: $JOINED$\nOrders: $ORDERS$",
  api_test_ok:"✅ API OK! Services: $SVC_COUNT$ Balance: $BAL$", api_test_fail:"❌ API Fail! $ERR$\nURL: $URL$",
  offer_created:"✅ অফার $TITLE$ $DISC$% $DAYS$ দিন Target $TARGET$ Service $SERVICE$",
  cancelled:"❌ বাতিল, মেনুতে ফিরলাম",
}
};

function tr(uid,k,vars={}){
  const u=getUser(uid); const lang=u?.lang||'en';
  let t=(T[lang]&&T[lang][k])||T.en[k]||k;
  for(let key in vars) t=t.replaceAll(`$${key}$`, vars[key]);
  return t;
}
function mainKb(uid){
  const u=getUser(uid); const d=T[u?.lang||'en']||T.en;
  return [[d.new_order, d.track_order],[d.add_funds, d.profile],[d.support, d.currency],[d.language]];
}
function askCurrency(uid){
  const rates=getConversionRates();
  bot.sendMessage(uid, tr(uid,'select_currency',{BDT_RATE:rates.BDT, USD_RATE:rates.USD}), {
    reply_markup:{inline_keyboard:[[{text:"🇧🇩 BDT (৳)", callback_data:"curr_BDT"}, {text:"🇺🇸 USD ($)", callback_data:"curr_USD"}]]}
  });
}
function maskIdPublic(id){ return maskId(id); }

// Force Join Check
async function checkUserJoinedAll(uid){
  if(!FORCE_JOIN_ENABLED) return {joined:true, missing:[]};
  let missing=[];
  for(let gid of GROUP_IDS){
    try{
      const member=await bot.getChatMember(gid, uid);
      const status=member.status;
      if(['left','kicked','banned'].includes(status)) missing.push(gid);
    }catch(e){
      // If bot not admin or ID invalid, skip check but log
      console.log(`Check join fail for ${gid} user ${uid}: ${e.message}`);
      // Don't treat as missing if bot can't check (to avoid blocking)
    }
  }
  return {joined:missing.length===0, missing};
}
async function sendForceJoinMessage(uid){
  const u=getUser(uid);
  const lang=u?.lang||'en';
  const tMust=T[lang]?.must_join||T.en.must_join;
  const tVerify=T[lang]?.join_verify||T.en.join_verify;
  // Build join buttons from links
  let kb=[];
  FORCE_JOIN_LINKS.forEach((link, idx)=>{
    let name=`Join Group ${idx+1}`;
    if(idx===0) name=`📢 Join Order Group`;
    if(idx===1) name=`💰 Join Deposit Group`;
    if(idx===2) name=`🎧 Join Support Group`;
    kb.push([{text:name, url:link}]);
  });
  kb.push([{text:tVerify, callback_data:"verify_join"}]);
  kb.push([{text:T[lang]?.cancel||"❌ Cancel", callback_data:"cancel_action"}]);
  bot.sendMessage(uid, tMust, {reply_markup:{inline_keyboard:kb}});
}

// Group Notifications
async function notifyOrderGroup(order, user){
  if(!GROUP_NOTIFY || !ORDER_GROUP_ID) return;
  const maskedOrder=maskIdPublic(order.order_id);
  const maskedUser=maskIdPublic(user.id);
  const msg=`🛒 *New Order Placed!*\n\n👤 User: ${user.first_name} (@${user.username||'none'}) ID: ${maskedUser}\n🛠 Service: ${order.service_name}\n📂 ${order.category} ${order.manual?'(MANUAL)':''}\n🔢 Qty: ${order.quantity}\n💰 Charge: ${formatMoney(order.charge_user, order.charge_currency)}\n🆔 Order ID: ${maskedOrder} ${MASK_IDS?'(first 2 + *** + last 2)':''}\n📅 ${new Date().toLocaleString()}\n\n#order`;
  try{ await bot.sendMessage(ORDER_GROUP_ID, msg, {parse_mode:"Markdown"}); }catch(e){ console.log("Order group fail", e.message); }
}
async function notifyDepositGroup(txn, user){
  if(!GROUP_NOTIFY || !DEPOSIT_GROUP_ID) return;
  const maskedTxn=maskIdPublic(txn.txn_id);
  const maskedUser=maskIdPublic(user.id);
  const msg=`💰 *Deposit Successful!*\n\n👤 User: ${user.first_name} (@${user.username||'none'}) ID: ${maskedUser}\n💵 Amount: ${formatMoney(txn.amount, txn.currency)}\n🏦 Gateway: ${txn.gateway} (NagrikPay)\n🆔 Txn ID: ${maskedTxn}\n📅 ${new Date().toLocaleString()}\n\n#deposit`;
  try{ await bot.sendMessage(DEPOSIT_GROUP_ID, msg, {parse_mode:"Markdown"}); }catch(e){ console.log("Deposit group fail", e.message); }
}
async function notifySupportGroupNewUser(newUser){
  if(!GROUP_NOTIFY || !SUPPORT_GROUP_ID) return;
  const msg=`🔔 *New User Joined Bot!*\n\n👤 Name: ${newUser.first_name}\n🆔 ID: ${maskIdPublic(newUser.id)} (Full: ${newUser.id})\n📛 Username: @${newUser.username||'none'}\n🌐 Lang: ${newUser.lang||'?'}\n💱 Curr: ${newUser.currency||'?'}\n📅 ${new Date().toLocaleString()}\n👥 Total Users: ${dbData.users.length}\n\n#newuser`;
  try{ await bot.sendMessage(SUPPORT_GROUP_ID, msg, {parse_mode:"Markdown"}); }catch(e){ console.log("Support group new user fail", e.message); }
}
function notifyNewUserToAdmins(newUser){
  if(!getSetting('new_user_notify', true)) return;
  for(let aid of ADMIN_IDS){
    try{ bot.sendMessage(aid, `🔔 *New User!*\nID: ${newUser.id}\nName: ${newUser.first_name}\n@${newUser.username||'none'}\nLang: ${newUser.lang||'?'}\nCurr: ${newUser.currency||'?'}\nTotal: ${dbData.users.length}`, {parse_mode:"Markdown"}); }catch(e){}
  }
  notifySupportGroupNewUser(newUser);
}

// SMM API
let svcCache={data:null, ts:0, error:null};
async function smmPost(p){
  try{
    const apiUrl=getSetting('api_url', API_URL);
    const apiKey=getSetting('api_key', API_KEY);
    const body=new URLSearchParams({key:apiKey, ...p});
    const {data}=await axios.post(apiUrl, body.toString(), {headers:{'Content-Type':'application/x-www-form-urlencoded'}, timeout:15000});
    if(data && data.error) throw new Error(data.error);
    return data;
  }catch(e){
    const msg=e.response?.data ? JSON.stringify(e.response.data).slice(0,300) : e.message;
    throw new Error(`API ${p.action} Error: ${msg} | URL: ${getSetting('api_url', API_URL)}`);
  }
}
async function getServices(force=false){
  if(!force && svcCache.data && Date.now()-svcCache.ts<5*60*1000) return svcCache.data;
  try{
    const data=await smmPost({action:'services'});
    if(!Array.isArray(data)) throw new Error("Services API not array: "+JSON.stringify(data).slice(0,500));
    svcCache={data, ts:Date.now(), error:null};
    const oldCount=getSetting('last_service_count', 0);
    if(data.length>oldCount && oldCount>0){
      const diff=data.length-oldCount;
      if(SUPPORT_GROUP_ID && GROUP_NOTIFY){
        try{ await bot.sendMessage(SUPPORT_GROUP_ID, `🆕 *New Services Added!* Provider added ${diff} new services. Total ${data.length}.`, {parse_mode:"Markdown"}); }catch(e){}
      }
    }
    setSetting('last_service_count', data.length);
    return data;
  }catch(e){ svcCache.error=e.message; throw e; }
}
function getCategories(svcs){
  const cats=[...new Set(svcs.map(s=>s.category))];
  const manualCats=[...new Set(dbData.manual_services.map(s=>s.category))];
  manualCats.forEach(c=>{ if(!cats.includes(c)) cats.push(c); });
  return cats;
}
function isCatEnabled(cat){ const en=getSetting('enabled_categories', null); if(!en) return true; return en.includes(cat); }
function isSvcEnabled(sid){ const dis=getSetting('disabled_services', []); return !dis.includes(String(sid)); }
function getEffectiveRate(svc, userId){
  const user=getUser(userId);
  let rateINR=parseFloat(svc.rate);
  const cpUser=dbData.custom_prices.find(cp=>String(cp.service_id)===String(svc.service) && cp.user_id===userId && cp.active);
  if(cpUser) rateINR=parseFloat(cpUser.custom_rate);
  else{ const cpGlobal=dbData.custom_prices.find(cp=>String(cp.service_id)===String(svc.service) && !cp.user_id && cp.active); if(cpGlobal) rateINR=parseFloat(cpGlobal.custom_rate); }
  let discount=user?.discount||0;
  // Check offers that match service or all services
  const offers=dbData.offers.filter(o=>o.active && (!o.target_user_id || o.target_user_id===userId) && (!o.service_id || String(o.service_id)===String(svc.service)) && (!o.valid_until || new Date(o.valid_until)>new Date()));
  offers.forEach(o=>{ if(o.discount_percent>discount) discount=o.discount_percent; });
  // discount can be negative = price increase
  rateINR=rateINR*(1-discount/100);
  const rates=getConversionRates(); const userCurr=user?.currency||'BDT'; const convRate=rates[userCurr]||rates.BDT;
  return {rateINR, rateUser:rateINR*convRate, discount, convRate, currency:userCurr};
}

// NagrikPay Payments - ONLY GATEWAY FOR BDT AS PER YOUR REQUIREMENT
async function createNagrikPayPayment(amount, currency, userId){
  if(!NAGRIKPAY_KEY) throw new Error("NagrikPay Brand Key missing - Set NAGRIKPAY_API_KEY in .env from https://nagorikpay.com -> Brands -> API-KEY");
  const rates=getConversionRates();
  let bdtAmount=amount;
  if((currency||'BDT').toUpperCase()==='USD'){
    bdtAmount=amount*rates.BDT/rates.USD;
  }
  const payload={
    cus_name: `User ${userId}`,
    cus_email: `user${userId}@example.com`,
    amount: bdtAmount.toFixed(2),
    success_url: WEBHOOK_URL ? `${WEBHOOK_URL}/payment/success?uid=${userId}` : `https://t.me/${(await bot.getMe()).username}`,
    cancel_url: WEBHOOK_URL ? `${WEBHOOK_URL}/payment/cancel` : `https://t.me/${(await bot.getMe()).username}`,
    webhook_url: WEBHOOK_URL ? `${WEBHOOK_URL}/webhook/nagrikpay` : undefined,
    metadata: {user_id:userId, original_amount:amount, original_currency:currency, phone:"01xxxxxxxxx"},
    meta_data: {user_id:userId, original_amount:amount, original_currency:currency}
  };
  const res=await axios.post(NAGRIKPAY_BASE, payload, {headers:{'API-KEY':NAGRIKPAY_KEY, 'Content-Type':'application/json'}});
  if(!res.data.payment_url && !res.data.paymentUrl){
    throw new Error("NagrikPay no payment_url: "+JSON.stringify(res.data).slice(0,500));
  }
  const url=res.data.payment_url || res.data.paymentUrl;
  const txnId=res.data.transaction_id || res.data.tran_id || res.data.invoice_id || `NAGRIK${Date.now()}${userId}`;
  return {url, txnId, bdtAmount};
}
async function verifyNagrikPayPayment(transactionId){
  const res=await axios.post(NAGRIKPAY_VERIFY, {transaction_id:transactionId}, {headers:{'API-KEY':NAGRIKPAY_KEY, 'Content-Type':'application/json'}});
  return res.data;
}

// Express Webhooks
const app=express();
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.get('/', (req,res)=>res.send(`SMM Bot Final Running | Users ${dbData.users.length} | Admins ${ADMIN_IDS.join(',')} | Rates Hidden From Users | Groups: Order ${ORDER_GROUP_ID} Deposit ${DEPOSIT_GROUP_ID} Support ${SUPPORT_GROUP_ID}`));
app.get('/payment/success', (req,res)=>res.send('<h2>Payment Success! Return to Telegram Bot - Balance will auto add</h2>'));
app.get('/payment/cancel', (req,res)=>res.send('<h2>Payment Cancelled. Return to bot</h2>'));
app.post('/webhook/nagrikpay', async (req,res)=>{
  console.log("NagrikPay webhook", req.body, req.query);
  const transactionId=req.body.transaction_id || req.query.transactionId || req.query.transaction_id || req.body.transactionId;
  const status=req.body.status || req.query.status;
  if(!transactionId) return res.send('no transaction_id');
  try{
    const verify=await verifyNagrikPayPayment(transactionId);
    console.log("NagrikPay verify", verify);
    if(verify.status===true || verify.status==='COMPLETED' || status==='success' || verify.payment_status==='completed'){
      const txn=dbData.transactions.find(t=>t.txn_id===transactionId || t.txn_id===String(req.body.transaction_id));
      if(txn && txn.status!=='completed'){
        txn.status='completed'; saveDB();
        addBalance(txn.user_id, txn.amount, txn.currency);
        const user=getUser(txn.user_id);
        try{ await bot.sendMessage(txn.user_id, `✅ NagrikPay Verified! ${formatMoney(txn.amount, txn.currency)} added. New ${formatMoney(getUserBalanceInfo(user).amount, txn.currency)}`); }catch(e){}
        if(user) notifyDepositGroup(txn, user);
      }
    }
    res.send('ok');
  }catch(e){ console.error("NagrikPay webhook err", e.message); res.status(500).send('error'); }
});
app.listen(PORT, ()=>console.log(`🌐 Webhook server ${PORT} | Groups: ${ORDER_GROUP_ID}, ${DEPOSIT_GROUP_ID}, ${SUPPORT_GROUP_ID}`));

// Bot
const bot=new TelegramBot(BOT_TOKEN, {polling:true});
const state=new Map();

bot.onText(/\/start/, async (msg)=>{
  if(getUser(msg.from.id)?.banned) return bot.sendMessage(msg.from.id, "❌ You are banned");
  const isNew=ensureUser(msg);
  const uid=msg.from.id;
  const u=getUser(uid);
  if(isNew){ notifyNewUserToAdmins(u); }
  if(!u.lang){
    return bot.sendMessage(uid, T.en.select_lang, {reply_markup:{inline_keyboard:[[{text:"🇧🇩 Bangla", callback_data:"lang_bn"}, {text:"🇬🇧 English", callback_data:"lang_en"}]]}});
  }
  if(!u.currency){
    const rates=getConversionRates();
    return bot.sendMessage(uid, tr(uid,'select_currency',{BDT_RATE:rates.BDT, USD_RATE:rates.USD}), {reply_markup:{inline_keyboard:[[{text:"🇧🇩 BDT (৳)", callback_data:"curr_BDT"}, {text:"🇺🇸 USD ($)", callback_data:"curr_USD"}]]}});
  }
  // Force join check
  if(FORCE_JOIN_ENABLED){
    const check=await checkUserJoinedAll(uid);
    if(!check.joined){
      return sendForceJoinMessage(uid);
    }
  }
  const bal=getUserBalanceInfo(u);
  bot.sendMessage(uid, tr(uid,'welcome',{BALANCE:formatMoney(bal.amount, bal.code), LANG:u.lang, CURR:bal.code, ID:uid}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
});

async function checkUserJoinedAll(uid){
  if(!FORCE_JOIN_ENABLED) return {joined:true, missing:[]};
  let missing=[];
  for(let gid of GROUP_IDS){
    if(!gid) continue;
    try{
      const member=await bot.getChatMember(gid, uid);
      const status=member.status;
      if(['left','kicked','banned'].includes(status)) missing.push(gid);
    }catch(e){
      console.log(`Join check fail ${gid} user ${uid}: ${e.message}`);
      // If bot can't check (not admin), skip to avoid blocking users - but log
    }
  }
  return {joined:missing.length===0, missing};
}
async function sendForceJoinMessage(uid){
  const u=getUser(uid);
  const lang=u?.lang||'en';
  const tMust=T[lang]?.must_join||T.en.must_join;
  const tVerify=T[lang]?.join_verify||T.en.join_verify;
  const check=await checkUserJoinedAll(uid);
  const missingText=check.missing.length>0 ? check.missing.join(', ') : 'All 3 groups';
  let kb=[];
  FORCE_JOIN_LINKS.forEach((link, idx)=>{
    let name=`Join Group ${idx+1}`;
    if(idx===0) name=`📢 Join Order Group`;
    if(idx===1) name=`💰 Join Deposit Group`;
    if(idx===2) name=`🎧 Join Support Group`;
    kb.push([{text:name, url:link}]);
  });
  kb.push([{text:tVerify, callback_data:"verify_join"}]);
  kb.push([{text:T[lang]?.cancel||"❌ Cancel", callback_data:"cancel_action"}]);
  bot.sendMessage(uid, `${tMust}\n\n${tr(uid,'not_joined',{MISSING:missingText})}`, {reply_markup:{inline_keyboard:kb}});
}

bot.onText(/\/admin/, (msg)=>{
  const uid=msg.from.id; if(!isAdmin(uid)) return; // silent hidden
  const uCount=dbData.users.length;
  const oCount=dbData.orders.length;
  const pCount=dbData.orders.filter(o=>!['Completed','Canceled','Refunded','Partial','Manual Completed'].includes(o.status)).length;
  const tbdt=dbData.users.reduce((s,u)=>s+(u.balance_bdt||0),0);
  const tusd=dbData.users.reduce((s,u)=>s+(u.balance_usd||0),0);
  const apiUrl=getSetting('api_url', API_URL);
  bot.sendMessage(uid, tr(uid,'admin_panel',{U:uCount, O:oCount, P:pCount, BDT:getConversionRates().BDT, USD:getConversionRates().USD, TBDT:tbdt.toFixed(2), TUSD:tusd.toFixed(2), API_URL:apiUrl, ORDER_G:ORDER_GROUP_ID, DEPOSIT_G:DEPOSIT_GROUP_ID, SUPPORT_G:SUPPORT_GROUP_ID}), {
    parse_mode:"Markdown",
    reply_markup:{inline_keyboard:[
      [{text:"📂 Categories", callback_data:"adm_cats"}, {text:"🔍 Search User", callback_data:"adm_search"}],
      [{text:"🛠 Add Manual Service", callback_data:"adm_add_manual"}, {text:"📋 List Manual", callback_data:"adm_list_manual"}],
      [{text:"📦 Manual Orders", callback_data:"adm_manual_orders"}, {text:"💱 Set Rates (Hidden)", callback_data:"adm_rates"}],
      [{text:"🔧 Manage API", callback_data:"adm_manage_api"}, {text:"🎁 Offers (Service ID)", callback_data:"adm_offers"}],
      [{text:"💰 Add Balance", callback_data:"adm_addbal"}, {text:"📊 API Bal", callback_data:"adm_apibal"}],
      [{text:"🧪 Test API", callback_data:"adm_test_api"}, {text:"📢 Broadcast", callback_data:"adm_bcast"}],
      [{text:"💳 Txns", callback_data:"adm_txns"}, {text:"🔔 Toggle Notify", callback_data:"adm_toggle_notify"}]
    ]}
  });
});

bot.on('callback_query', async (cq)=>{
  const uid=cq.from.id; const data=cq.data; await bot.answerCallbackQuery(cq.id).catch(()=>{}); ensureUser(cq.message);
  if(getUser(uid)?.banned) return;

  if(data==='lang_en' || data==='lang_bn'){
    const lang=data==='lang_en'?'en':'bn'; const u=getUser(uid); u.lang=lang; saveDB();
    if(!u.currency) return askCurrency(uid);
    if(FORCE_JOIN_ENABLED){
      const chk=await checkUserJoinedAll(uid);
      if(!chk.joined) return sendForceJoinMessage(uid);
    }
    const bal=getUserBalanceInfo(u);
    bot.sendMessage(uid, tr(uid,'welcome',{BALANCE:formatMoney(bal.amount, bal.code), LANG:lang, CURR:bal.code, ID:uid}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    return;
  }
  if(data==='curr_BDT' || data==='curr_USD'){
    const curr=data==='curr_BDT'?'BDT':'USD'; const u=getUser(uid); u.currency=curr; saveDB();
    if(FORCE_JOIN_ENABLED){
      const chk=await checkUserJoinedAll(uid);
      if(!chk.joined) return sendForceJoinMessage(uid);
    }
    const bal=getUserBalanceInfo(u);
    bot.sendMessage(uid, tr(uid,'currency_set',{CURR:curr}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    bot.sendMessage(uid, tr(uid,'welcome',{BALANCE:formatMoney(bal.amount, bal.code), LANG:u.lang, CURR:curr, ID:uid}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    return;
  }
  if(data==='verify_join'){
    const chk=await checkUserJoinedAll(uid);
    if(!chk.joined){
      return bot.sendMessage(uid, tr(uid,'not_joined',{MISSING:chk.missing.join(', ')}), {reply_markup:{inline_keyboard:[[{text:"✅ Verify Again", callback_data:"verify_join"}],[{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
    }
    bot.sendMessage(uid, tr(uid,'joined_ok'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    const u=getUser(uid); const bal=getUserBalanceInfo(u);
    bot.sendMessage(uid, tr(uid,'welcome',{BALANCE:formatMoney(bal.amount, bal.code), LANG:u.lang, CURR:bal.code, ID:uid}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    return;
  }
  if(data==='cancel_action'){
    state.delete(uid);
    bot.sendMessage(uid, tr(uid,'cancelled'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    return;
  }

  // Category
  if(data.startsWith('cat_')){
    const idx=parseInt(data.split('_')[1]);
    try{
      const services=await getServices();
      const cats=getCategories(services).filter(isCatEnabled);
      const cat=cats[idx];
      const apiList=services.filter(s=>s.category===cat && isSvcEnabled(s.service));
      const manualList=dbData.manual_services.filter(s=>s.category===cat);
      const combined=[...apiList.map(s=>({...s, manual:false})), ...manualList.map(s=>({service:s.id, name:s.name, category:s.category, rate:s.rate_inr, min:s.min, max:s.max, manual:true, description:s.description}))].slice(0,25);
      if(combined.length===0) return bot.sendMessage(uid, "No services in this category", {reply_markup:{inline_keyboard:[[{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
      let kb=combined.map(s=>{ const eff=getEffectiveRate(s, uid); return [{text:`${s.manual?'🛠 MANUAL ':' '}${s.service} - ${s.name.slice(0,25)} ${formatMoney(eff.rateUser, eff.currency)}/1k`, callback_data:`svc_${s.service}_${s.manual?'m':'a'}`}]; });
      kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
      bot.sendMessage(uid, tr(uid,'ask_service',{CAT:cat, PRICE:getEffectiveRate(combined[0], uid).rateUser.toFixed(2), MIN:combined[0].min, MAX:combined[0].max, CURR:getUser(uid).currency||'BDT'}), {reply_markup:{inline_keyboard:kb}});
    }catch(e){
      bot.sendMessage(uid, `❌ API Error: ${e.message}\n\nService not found? Use manual service or Test API in /admin`, {reply_markup:{inline_keyboard:[[{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
    }
    return;
  }
  if(data==='back_cats'){
    try{
      const services=await getServices();
      const cats=getCategories(services).filter(isCatEnabled);
      const u=getUser(uid);
      let kb=[]; for(let i=0;i<cats.length;i++) kb.push([{text:cats[i], callback_data:`cat_${i}`}]);
      kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
      bot.sendMessage(uid, tr(uid,'ask_cat',{CURR:u.currency}), {reply_markup:{inline_keyboard:kb}});
    }catch(e){ bot.sendMessage(uid, `❌ API Error: ${e.message}`); }
    return;
  }
  if(data.startsWith('svc_')){
    const parts=data.split('_'); const sid=parts[1]; const type=parts[2];
    try{
      let svc=null;
      if(type==='m'){
        const manual=dbData.manual_services.find(s=>String(s.id)===String(sid));
        if(!manual) throw new Error("Manual service ID "+sid+" not found");
        svc={service:manual.id, name:manual.name, category:manual.category, rate:manual.rate_inr, min:manual.min, max:manual.max, manual:true, description:manual.description};
      } else {
        const services=await getServices();
        const found=services.find(s=>String(s.service)===String(sid));
        if(!found) throw new Error("Service ID "+sid+" not found on provider - may be deleted or disabled");
        svc={...found, manual:false};
      }
      state.set(uid, {step:'await_link', service:svc});
      bot.sendMessage(uid, `🛠 *${svc.name}* ${svc.manual?'(MANUAL)':''}\nPrice: ${formatMoney(getEffectiveRate(svc, uid).rateUser, getUser(uid).currency||'BDT')}/1k\nMin ${svc.min} Max ${svc.max}\n\n${tr(uid,'ask_link')}`, {parse_mode:"Markdown", reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
    }catch(e){
      bot.sendMessage(uid, `❌ ${tr(uid,'invalid_sid',{ID:sid})}\nError: ${e.message}`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    }
    return;
  }
  if(data==='confirm_yes'){
    const st=state.get(uid); if(!st) return;
    const svc=st.service; const eff=getEffectiveRate(svc, uid);
    const chargeINR=eff.rateINR*st.quantity/1000; const chargeUser=eff.rateUser*st.quantity/1000;
    const u=getUser(uid); const balInfo=getUserBalanceInfo(u);
    if(balInfo.amount < chargeUser){ state.delete(uid); return bot.sendMessage(uid, tr(uid,'insufficient',{NEED:formatMoney(chargeUser, balInfo.code), HAVE:formatMoney(balInfo.amount, balInfo.code), CURR:balInfo.code}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
    deductBalance(uid, chargeUser, balInfo.code);
    try{
      let apiOrderId;
      let isManual=svc.manual;
      if(isManual){
        apiOrderId=`MANUAL${Date.now()}${uid}`;
      } else {
        const res=await smmPost({action:'add', service:svc.service, link:st.link, quantity:st.quantity});
        if(res.error){ addBalance(uid, chargeUser, balInfo.code); state.delete(uid); return bot.sendMessage(uid, `❌ SMM API Error: ${res.error}\nRefunded ${formatMoney(chargeUser, balInfo.code)}`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
        apiOrderId=res.order;
      }
      const orderObj={
        id:dbData.orders.length+1, order_id:apiOrderId, user_id:uid, service_id:svc.service, service_name:svc.name, category:svc.category, link:st.link, quantity:st.quantity,
        charge_inr:chargeINR, charge_user:chargeUser, charge_currency:balInfo.code, conversion_rate:eff.convRate, status:isManual?'Manual Pending':'Pending', refunded:0, manual:isManual, created_at:new Date().toISOString()
      };
      dbData.orders.push(orderObj); saveDB(); state.delete(uid);
      const msgKey=isManual?'order_ok_manual':'order_ok';
      bot.sendMessage(uid, tr(uid,msgKey,{OID:apiOrderId, CHARGE_USER:formatMoney(chargeUser, balInfo.code), CHARGE_INR:chargeINR.toFixed(2), CURR:balInfo.code, RATE:eff.convRate}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
      if(isManual){
        const manualMsg=`🛠 *MANUAL ORDER*\nUser: ${u.first_name} (@${u.username||'none'}) ID ${maskIdPublic(u.id)}\nService: ${svc.name} (${svc.service}) ${svc.category}\nQty: ${st.quantity}\nLink: ${st.link}\nCharge: ${formatMoney(chargeUser, balInfo.code)}\nOrderID: ${maskIdPublic(apiOrderId)}\n#manualorder`;
        if(ORDER_GROUP_ID) try{ await bot.sendMessage(ORDER_GROUP_ID, manualMsg, {parse_mode:"Markdown"}); }catch(e){}
        for(let aid of ADMIN_IDS){ try{ await bot.sendMessage(aid, `🛠 MANUAL ORDER NEED ACTION\n${manualMsg}\nFull ID: ${apiOrderId}\nUser: ${uid}`); }catch(e){} }
      } else {
        notifyOrderGroup(orderObj, u);
      }
    }catch(e){
      addBalance(uid, chargeUser, balInfo.code);
      bot.sendMessage(uid, `❌ Order Failed: ${e.message}\nRefunded ${formatMoney(chargeUser, balInfo.code)}\n\nIf SMM API says not found, try manual service or /admin -> Test API`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    }
    return;
  }
  if(data==='confirm_no'){ state.delete(uid); bot.sendMessage(uid, tr(uid,'cancelled'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); return; }

  if(data.startsWith('check_')){
    const oid=data.split('_')[1];
    const row=dbData.orders.find(o=>String(o.order_id)===String(oid) && o.user_id===uid);
    if(!row) return bot.sendMessage(uid, "Order not found");
    if(row.manual) return bot.sendMessage(uid, `📦 Manual Order #${maskIdPublic(oid)}\nStatus: ${row.status}\nAdmin will update.`);
    bot.sendMessage(uid, `⏳ Checking #${maskIdPublic(oid)}...`);
    try{
      const res=await smmPost({action:'status', order:oid});
      const status=res.status||'Unknown'; row.status=status; saveDB();
      if(['Canceled','Refunded'].includes(status) && !row.refunded){ addBalance(uid, row.charge_user, row.charge_currency); row.refunded=1; saveDB(); bot.sendMessage(uid, `💸 #${maskIdPublic(oid)} ${status}. Refunded ${formatMoney(row.charge_user, row.charge_currency)}`); }
      else if(status==='Partial'){ const remains=parseInt(res.remains||0); if(remains>0 && !row.refunded){ const refundUser=row.charge_user*remains/row.quantity; addBalance(uid, refundUser, row.charge_currency); row.refunded=1; saveDB(); bot.sendMessage(uid, `⚠️ #${maskIdPublic(oid)} Partial Remains ${remains} Refunded ${formatMoney(refundUser, row.charge_currency)}`); } }
      else if(status==='Completed') bot.sendMessage(uid, `✅ #${maskIdPublic(oid)} Completed!`);
      else bot.sendMessage(uid, `📦 #${maskIdPublic(oid)} Status: ${status}`);
    }catch(e){ bot.sendMessage(uid, `❌ API Error: ${e.message}`); }
    return;
  }

  if(data.startsWith('paygw_')){
    const gw=data.split('_')[1];
    const st=state.get(uid);
    if(!st || st.step!=='await_gateway') return bot.sendMessage(uid, tr(uid,'cancelled'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    const amount=st.amount; const user=getUser(uid); const currency=user.currency||'BDT';
    try{
      if(gw==='nagrikpay'){
        const pay=await createNagrikPayPayment(amount, currency, uid);
        const newId=dbData.transactions.length+1;
        dbData.transactions.push({id:newId, user_id:uid, amount, currency, gateway:'nagrikpay', txn_id:pay.txnId, status:'pending', created_at:new Date().toISOString()}); saveDB();
        state.delete(uid);
        return bot.sendMessage(uid, tr(uid,'payment_created',{AMT:formatMoney(amount,currency), URL:pay.url})+`\nBDT: ৳${pay.bdtAmount.toFixed(2)}`, {reply_markup:{inline_keyboard:[[{text:`💳 Pay ${formatMoney(amount,currency)} via NagrikPay`, url:pay.url}],[{text:"✅ I Paid - Verify", callback_data:`verify_nagrik_${newId}`},{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
      }
    }catch(e){ state.delete(uid); return bot.sendMessage(uid, `❌ Payment failed ${gw}: ${e.message}\nCheck NAGRIKPAY_API_KEY in .env`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
    return;
  }

  if(data.startsWith('verify_')){
    const idPart=data.replace('verify_','');
    if(idPart.startsWith('nagrik_')){
      const id=parseInt(idPart.split('_')[1]); const txn=dbData.transactions.find(t=>t.id===id); if(!txn) return;
      try{
        const v=await verifyNagrikPayPayment(txn.txn_id);
        if(v.status===true || v.status==='COMPLETED' || v.payment_status==='completed'){
          if(txn.status!=='completed'){ txn.status='completed'; saveDB(); addBalance(uid, txn.amount, txn.currency); const user=getUser(uid); bot.sendMessage(uid, tr(uid,'payment_verified',{AMT:formatMoney(txn.amount, txn.currency), BAL:formatMoney(getUserBalanceInfo(user).amount, txn.currency)}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); notifyDepositGroup(txn, user); }
        } else bot.sendMessage(uid, `NagrikPay status: ${JSON.stringify(v).slice(0,300)}`);
      }catch(e){ bot.sendMessage(uid, "Verify err: "+e.message); }
      return;
    }
    return;
  }

  // Admin
  if(!isAdmin(uid)) return;
  if(data==='adm_apibal'){ try{ const r=await smmPost({action:'balance'}); bot.sendMessage(uid, `API Bal: ${r.balance} ${r.currency||'INR'}`);}catch(e){ bot.sendMessage(uid, `❌ API Fail: ${e.message}`); } }
  if(data==='adm_addbal'){ state.set(uid,{step:'admin_addbal'}); bot.sendMessage(uid, "Send: `userId amount currency`\nEx: 7481724731 100 BDT", {parse_mode:"Markdown", reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_search'){ state.set(uid,{step:'admin_search_user'}); bot.sendMessage(uid, tr(uid,'search_user_prompt'), {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_rates'){ const rates=getConversionRates(); state.set(uid,{step:'admin_set_rates'}); bot.sendMessage(uid, `Current (Hidden from users):\n1 INR=${rates.BDT} BDT / ${rates.USD} USD\n\nSend new rates as: BDT_rate USD_rate\nEx: 1.35 0.012\n\nUsers will NOT see this, only selected currency price.`, {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_cats'){
    try{
      const services=await getServices(true);
      const cats=getCategories(services); const en=getSetting('enabled_categories', null);
      let kb=cats.map((c,i)=>{ const on=!en||en.includes(c); return [{text:`${on?'✅':'❌'} ${c}`, callback_data:`toggle_cat_${i}`}]; });
      kb.push([{text:"Enable All", callback_data:"enable_all_cats"}]); kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
      bot.sendMessage(uid, "Toggle categories:", {reply_markup:{inline_keyboard:kb}});
    }catch(e){ bot.sendMessage(uid, `❌ API Fail: ${e.message}`); }
  }
  if(data.startsWith('toggle_cat_')){ const idx=parseInt(data.split('_')[2]); const services=await getServices(); const cats=getCategories(services); const cat=cats[idx]; let en=getSetting('enabled_categories', null); if(!en) en=[...cats]; if(en.includes(cat)) en=en.filter(x=>x!==cat); else en.push(cat); setSetting('enabled_categories', en); bot.sendMessage(uid, `${cat} now ${en.includes(cat)?'Enabled':'Disabled'}`); }
  if(data==='enable_all_cats'){ setSetting('enabled_categories', null); bot.sendMessage(uid,"All categories enabled"); }
  if(data==='adm_add_manual'){ state.set(uid,{step:'admin_add_manual_cat'}); bot.sendMessage(uid, "🛠 Add Manual Service - Step 1/5\nSend Category name:\nEx: Instagram", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_list_manual'){
    let txt="🛠 Manual Services:\n"; dbData.manual_services.forEach(s=>{ txt+=`ID:${s.id} ${s.category} - ${s.name} Rate ${s.rate_inr} INR Min ${s.min} Max ${s.max}\n`; });
    if(dbData.manual_services.length===0) txt+="No manual services";
    bot.sendMessage(uid, txt, {reply_markup:{inline_keyboard:[[{text:"🗑 Delete Manual", callback_data:"adm_del_manual"}, {text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
  }
  if(data==='adm_del_manual'){ state.set(uid,{step:'admin_del_manual'}); bot.sendMessage(uid, "Send Manual Service ID to delete:", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_manual_orders'){
    const pending=dbData.orders.filter(o=>o.manual && o.status==='Manual Pending');
    if(pending.length===0) return bot.sendMessage(uid, "No manual pending orders");
    let txt=`📦 Manual Pending: ${pending.length}\n`; let kb=[];
    pending.slice(-10).forEach(o=>{ txt+=`ID:${o.order_id} User:${o.user_id} ${o.service_name} Qty:${o.quantity} Link:${o.link}\n`; kb.push([{text:`✅ Complete ${o.order_id}`, callback_data:`manual_complete_${o.order_id}`}, {text:`❌ Cancel ${o.order_id}`, callback_data:`manual_cancel_${o.order_id}`}]); });
    kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
    bot.sendMessage(uid, txt, {reply_markup:{inline_keyboard:kb}});
  }
  if(data.startsWith('manual_complete_')){ const oid=data.replace('manual_complete_',''); const order=dbData.orders.find(o=>String(o.order_id)===oid); if(!order) return bot.sendMessage(uid, "Not found"); order.status='Manual Completed'; saveDB(); try{ await bot.sendMessage(order.user_id, `✅ Manual order #${maskIdPublic(oid)} completed by admin!`); }catch(e){} bot.sendMessage(uid, `✅ Manual ${oid} completed`); }
  if(data.startsWith('manual_cancel_')){ const oid=data.replace('manual_cancel_',''); const order=dbData.orders.find(o=>String(o.order_id)===oid); if(!order) return bot.sendMessage(uid, "Not found"); order.status='Canceled'; if(!order.refunded){ addBalance(order.user_id, order.charge_user, order.charge_currency); order.refunded=1; } saveDB(); try{ await bot.sendMessage(order.user_id, `❌ Manual order #${maskIdPublic(oid)} canceled. Refunded ${formatMoney(order.charge_user, order.charge_currency)}`); }catch(e){} bot.sendMessage(uid, `❌ Manual ${oid} canceled`); }
  if(data==='adm_manage_api'){
    const apiUrl=getSetting('api_url', API_URL); const apiKey=getSetting('api_key', API_KEY);
    const maskedKey=apiKey ? apiKey.substring(0,4)+"***"+apiKey.substring(apiKey.length-4) : "Not set";
    bot.sendMessage(uid, `🔧 *Manage API*\n\nCurrent URL: ${apiUrl}\nCurrent Key: ${maskedKey}\n\nChoose:`, {parse_mode:"Markdown", reply_markup:{inline_keyboard:[[{text:"Change API URL", callback_data:"adm_set_api_url"}, {text:"Change API Key", callback_data:"adm_set_api_key"}], [{text:"🧪 Test API", callback_data:"adm_test_api"}, {text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
  }
  if(data==='adm_set_api_url'){ state.set(uid,{step:'admin_set_api_url'}); bot.sendMessage(uid, "Send new API URL:\nEx: https://yourpanel.com/api/v2", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_set_api_key'){ state.set(uid,{step:'admin_set_api_key'}); bot.sendMessage(uid, "Send new API Key:", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_test_api'){
    bot.sendMessage(uid, "🧪 Testing SMM API...");
    try{ const services=await smmPost({action:'services'}); const bal=await smmPost({action:'balance'}); bot.sendMessage(uid, `✅ API OK! Services: ${Array.isArray(services)?services.length:'?'} Balance: ${bal.balance||'?'} ${bal.currency||'INR'}\nURL: ${getSetting('api_url', API_URL)}`); }
    catch(e){ bot.sendMessage(uid, `❌ API Fail! ${e.message}\nURL: ${getSetting('api_url', API_URL)}\nCheck .env API_URL/API_KEY or use Manual Services`); }
  }
  if(data==='adm_offers'){
    let txt="🎁 Offers (Service-specific + Global):\n"; dbData.offers.forEach(o=>{ txt+=`#${o.id} ${o.title} ${o.discount_percent}% valid ${o.valid_until} target ${o.target_user_id||'all'} service ${o.service_id||'all'} active ${o.active}\n`; });
    if(dbData.offers.length===0) txt+="No offers";
    bot.sendMessage(uid, txt, {reply_markup:{inline_keyboard:[[{text:"➕ Create Offer", callback_data:"adm_create_offer"}, {text:"🗑 Delete Offer", callback_data:"adm_delete_offer"}], [{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
  }
  if(data==='adm_create_offer'){ state.set(uid,{step:'admin_offer_title'}); bot.sendMessage(uid, "🎁 Offer Title (e.g., Eid 10% Off or Service 123 20% off):", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_delete_offer'){ state.set(uid,{step:'admin_delete_offer'}); bot.sendMessage(uid, "Send Offer ID to delete:", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_bcast'){ state.set(uid,{step:'admin_bcast'}); bot.sendMessage(uid, "📢 Broadcast message (or Cancel):", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
  if(data==='adm_pending'){ checkPending(true, uid); }
  if(data==='adm_txns'){ let msg="💳 Last 15 Txns:\n"; dbData.transactions.slice(-15).reverse().forEach(t=>{ msg+=`#${t.id} U:${t.user_id} ${formatMoney(t.amount,t.currency)} ${t.gateway} ${t.status} Txn:${maskIdPublic(t.txn_id)}\n`; }); bot.sendMessage(uid, msg); }
  if(data==='adm_toggle_notify'){ const cur=getSetting('new_user_notify', true); setSetting('new_user_notify', !cur); bot.sendMessage(uid, `New user notify now ${!cur?'Enabled':'Disabled'}`); }
  if(data.startsWith('admin_view_orders_')){ const tid=parseInt(data.split('_')[3]); const orders=dbData.orders.filter(o=>o.user_id===tid).slice(-10); let txt=`📦 Orders for ${tid} (last 10):\n`; orders.forEach(o=>txt+=`#${o.order_id} ${o.service_name.slice(0,20)} ${o.status} ${formatMoney(o.charge_user, o.charge_currency)}\n`); bot.sendMessage(uid, txt||"No orders"); }
  if(data.startsWith('admin_addbal_user_')){ const tid=parseInt(data.split('_')[3]); state.set(uid,{step:'admin_addbal_specific', target_id:tid}); bot.sendMessage(uid, `Send amount and currency for user ${tid}:\nEx: 100 BDT or 5 USD`, {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
});

bot.on('message', async (msg)=>{
  if(!msg.text) return;
  if(msg.text.startsWith('/start') || msg.text.startsWith('/admin')) return;
  const uid=msg.from.id; ensureUser(msg);
  const text=msg.text.trim();
  const st=state.get(uid);

  if(isCancel(text)){
    state.delete(uid);
    const u=getUser(uid);
    return bot.sendMessage(uid, tr(uid,'cancelled'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
  }

  if(st && st.step==='support_chat'){
    for(let aid of ADMIN_IDS){
      try{ const sent=await bot.sendMessage(aid, tr(aid,'support_fwd',{ID:uid, USER:msg.from.username||'no', CURR:getUser(uid).currency||'BDT', LANG:getUser(uid).lang||'en', MSG:text})); dbData.support_map.push({admin_msg_id:sent.message_id, user_id:uid}); saveDB(); }catch(e){}
    }
    // Also forward to support group
    if(SUPPORT_GROUP_ID && GROUP_NOTIFY){
      try{ await bot.sendMessage(SUPPORT_GROUP_ID, `📩 Support from ${getUser(uid).first_name} (@${msg.from.username||'none'}) ID ${maskIdPublic(uid)}\n\n${text}`); }catch(e){}
    }
    state.delete(uid);
    return bot.sendMessage(uid, tr(uid,'support_sent'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
  }
  if(isAdmin(uid) && msg.reply_to_message){
    const map=dbData.support_map.find(m=>m.admin_msg_id===msg.reply_to_message.message_id);
    if(map){ try{ await bot.sendMessage(map.user_id, `🎧 *Support Reply:*\n\n${text}`, {parse_mode:"Markdown"}); bot.sendMessage(uid,`✅ Replied to ${map.user_id}`);}catch(e){ bot.sendMessage(uid,"Failed"); } return; }
  }

  if(isAdmin(uid) && st){
    if(st.step==='admin_search_user'){
      const targetId=parseInt(text); if(isNaN(targetId)) return bot.sendMessage(uid, "Invalid ID, send numeric ID or Cancel", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}});
      const target=getUser(targetId);
      if(!target){ state.delete(uid); return bot.sendMessage(uid, tr(uid,'user_not_found',{ID:targetId}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
      const orders=dbData.orders.filter(o=>o.user_id===targetId).length;
      state.delete(uid);
      const info=tr(uid,'user_found',{ID:target.id, NAME:target.first_name, USERNAME:target.username||'none', LANG:target.lang||'?', CURR:target.currency||'?', BDT:(target.balance_bdt||0).toFixed(2), USD:(target.balance_usd||0).toFixed(2), SPENT_BDT:(target.total_spent_bdt||0).toFixed(2), SPENT_USD:(target.total_spent_usd||0).toFixed(2), JOINED:new Date(target.created_at).toLocaleString(), BANNED:target.banned?'Yes':'No', ORDERS:orders});
      return bot.sendMessage(uid, info, {parse_mode:"Markdown", reply_markup:{inline_keyboard:[[{text:"💰 Add Balance", callback_data:`admin_addbal_user_${targetId}`}, {text:"📦 View Orders", callback_data:`admin_view_orders_${targetId}`}], [{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
    }
    if(st.step==='admin_addbal'){
      const parts=text.split(/\s+/); const tid=parseInt(parts[0]); const amt=parseFloat(parts[1]); const curr=(parts[2]||'BDT').toUpperCase();
      if(!isNaN(tid)&&!isNaN(amt)){ addBalance(tid, amt, curr); state.delete(uid); const u=getUser(tid); bot.sendMessage(uid, `✅ Added ${formatMoney(amt,curr)} to ${tid}. BDT:${u?.balance_bdt||0} USD:${u?.balance_usd||0}`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); try{ bot.sendMessage(tid, `💰 Admin added ${formatMoney(amt,curr)}`);}catch(e){} return; }
    }
    if(st.step==='admin_addbal_specific'){
      const parts=text.split(/\s+/); const amt=parseFloat(parts[0]); const curr=(parts[1]||'BDT').toUpperCase();
      if(!isNaN(amt)){ addBalance(st.target_id, amt, curr); state.delete(uid); return bot.sendMessage(uid, `✅ Added ${formatMoney(amt,curr)} to ${st.target_id}`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
    }
    if(st.step==='admin_set_rates'){
      const parts=text.split(/\s+/); const bdt=parseFloat(parts[0]); const usd=parseFloat(parts[1]);
      if(!isNaN(bdt)&&!isNaN(usd)){ setSetting('inr_to_bdt', bdt); setSetting('inr_to_usd', usd); state.delete(uid); return bot.sendMessage(uid, `✅ Rates updated (Hidden from users): 1 INR=${bdt} BDT / ${usd} USD`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
      else return bot.sendMessage(uid,"Invalid Ex: 1.35 0.012", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}});
    }
    if(st.step==='admin_set_api_url'){ setSetting('api_url', text); state.delete(uid); return bot.sendMessage(uid, `✅ API URL updated to: ${text}\nTest with /admin -> Test API`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
    if(st.step==='admin_set_api_key'){ setSetting('api_key', text); state.delete(uid); return bot.sendMessage(uid, `✅ API Key updated (hidden): ${text.substring(0,4)}***${text.substring(text.length-4)}\nTest with /admin -> Test API`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
    if(st.step==='admin_add_manual_cat'){ st.category=text; st.step='admin_add_manual_name'; state.set(uid,st); return bot.sendMessage(uid, "Step 2/5 - Service Name:\nEx: Instagram Followers 1k", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_add_manual_name'){ st.name=text; st.step='admin_add_manual_rate'; state.set(uid,st); return bot.sendMessage(uid, "Step 3/5 - Rate in INR per 1k:\nEx: 100", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_add_manual_rate'){ st.rate_inr=parseFloat(text); if(isNaN(st.rate_inr)) return bot.sendMessage(uid, "Invalid rate"); st.step='admin_add_manual_minmax'; state.set(uid,st); return bot.sendMessage(uid, "Step 4/5 - Min and Max:\nEx: 100 10000", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_add_manual_minmax'){
      const parts=text.split(/\s+/); const min=parseInt(parts[0]); const max=parseInt(parts[1]);
      if(isNaN(min)||isNaN(max)) return bot.sendMessage(uid, "Invalid, send min max e.g. 100 10000");
      st.min=min; st.max=max; st.step='admin_add_manual_desc'; state.set(uid,st);
      return bot.sendMessage(uid, "Step 5/5 - Description or skip:", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}});
    }
    if(st.step==='admin_add_manual_desc'){
      const desc=text.toLowerCase()==='skip'?'':text;
      const newId=dbData.manual_services.length>0? Math.max(...dbData.manual_services.map(s=>s.id))+1 : 90001;
      dbData.manual_services.push({id:newId, name:st.name, category:st.category, rate_inr:st.rate_inr, min:st.min, max:st.max, description:desc});
      saveDB(); state.delete(uid);
      return bot.sendMessage(uid, `✅ Manual Service Added ID ${newId}\nCategory ${st.category}\nName ${st.name}\nRate ${st.rate_inr} INR`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    }
    if(st.step==='admin_del_manual'){
      const id=parseInt(text); const idx=dbData.manual_services.findIndex(s=>s.id===id);
      if(idx!==-1){ dbData.manual_services.splice(idx,1); saveDB(); state.delete(uid); return bot.sendMessage(uid, `✅ Manual ${id} deleted`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
      else return bot.sendMessage(uid, "ID not found");
    }
    if(st.step==='admin_offer_title'){ st.title=text; st.step='admin_offer_discount'; state.set(uid,st); return bot.sendMessage(uid,"Discount % (use negative for price increase, e.g., -10 for +10%):\nEx: 10 for 10% discount, -20 for 20% price increase", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_offer_discount'){ st.discount=parseFloat(text); st.step='admin_offer_days'; state.set(uid,st); return bot.sendMessage(uid,"Valid days (e.g., 7):", {reply_markup:{keyboard:[[{text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_offer_days'){ st.days=parseInt(text); st.step='admin_offer_target'; state.set(uid,st); return bot.sendMessage(uid,"Target: Send 'all' for all users or specific User ID (e.g., 7481724731):", {reply_markup:{keyboard:[[{text:"all"}, {text:"❌ Cancel"}]], resize_keyboard:true}}); }
    if(st.step==='admin_offer_target'){
      const target=text.trim(); let targetId=null;
      if(target.toLowerCase()!=='all'){ const tid=parseInt(target); if(isNaN(tid)) return bot.sendMessage(uid,"Invalid, send 'all' or ID", {reply_markup:{keyboard:[[{text:"all"}, {text:"❌ Cancel"}]], resize_keyboard:true}}); targetId=tid; }
      st.target_user_id=targetId; st.step='admin_offer_service'; state.set(uid,st);
      return bot.sendMessage(uid,"Service ID: Send 'all' for all services or specific Service ID (e.g., 123) to apply discount only to that service:", {reply_markup:{keyboard:[[{text:"all"}, {text:"❌ Cancel"}]], resize_keyboard:true}});
    }
    if(st.step==='admin_offer_service'){
      const svc=text.trim(); let serviceId=null;
      if(svc.toLowerCase()!=='all'){ const sid=parseInt(svc); if(isNaN(sid)) return bot.sendMessage(uid,"Invalid, send 'all' or Service ID", {reply_markup:{keyboard:[[{text:"all"}, {text:"❌ Cancel"}]], resize_keyboard:true}}); serviceId=sid; }
      const valid=new Date(Date.now()+st.days*24*60*60*1000).toISOString();
      dbData.offers.push({id:dbData.offers.length+1, title:st.title, discount_percent:st.discount, valid_until:valid, target_user_id:st.target_user_id, service_id:serviceId, active:1});
      saveDB(); state.delete(uid);
      return bot.sendMessage(uid, tr(uid,'offer_created',{TITLE:st.title, DISC:st.discount, DAYS:st.days, TARGET:st.target_user_id||'all', SERVICE:serviceId||'all'}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    }
    if(st.step==='admin_delete_offer'){ const id=parseInt(text); const idx=dbData.offers.findIndex(o=>o.id===id); if(idx!==-1){ dbData.offers.splice(idx,1); saveDB(); state.delete(uid); return bot.sendMessage(uid, `✅ Offer #${id} deleted`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); } else return bot.sendMessage(uid, "ID not found"); }
    if(st.step==='admin_bcast'){
      let c=0; for(let u of dbData.users){ try{ await bot.sendMessage(u.id, `📢 *Broadcast:*\n\n${text}`, {parse_mode:"Markdown"}); c++; await new Promise(r=>setTimeout(r,80)); }catch(e){} }
      state.delete(uid); return bot.sendMessage(uid, `✅ Broadcast to ${c}`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    }
  }

  // User order flow
  if(st){
    if(st.step==='await_link'){
      if(!text.startsWith('http')) return bot.sendMessage(uid, tr(uid,'invalid_link'), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
      st.link=text; st.step='await_qty'; state.set(uid,st);
      const eff=getEffectiveRate(st.service, uid);
      const qtyKb={keyboard:[[{text:"100"}, {text:"1000"}, {text:"5000"}], [{text:tr(uid,'cancel')}]], resize_keyboard:true};
      if(CURRENCY_DISPLAY==='only_selected'){
        return bot.sendMessage(uid, `🔢 Step 4️⃣/5️⃣ Qty Min ${st.service.min} Max ${st.service.max} Price ${formatMoney(eff.rateUser, eff.currency)}/1k`, {reply_markup:qtyKb});
      } else {
        return bot.sendMessage(uid, tr(uid,'ask_qty',{MIN:st.service.min, MAX:st.service.max, INR_RATE:eff.rateINR.toFixed(4), USER_RATE:eff.rateUser.toFixed(4)}), {reply_markup:qtyKb});
      }
    }
    if(st.step==='await_qty'){
      const qty=parseInt(text); if(isNaN(qty) || qty < parseInt(st.service.min) || qty > parseInt(st.service.max)) return bot.sendMessage(uid, tr(uid,'invalid_qty',{MIN:st.service.min, MAX:st.service.max}), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
      st.quantity=qty; const eff=getEffectiveRate(st.service, uid);
      const chargeINR=eff.rateINR*qty/1000; const chargeUser=eff.rateUser*qty/1000;
      state.set(uid,st);
      return bot.sendMessage(uid, tr(uid,'confirm',{NAME:st.service.name, ID:st.service.service, CAT:st.service.category, LINK:st.link, QTY:qty, INR_RATE:eff.rateINR.toFixed(4), USER_RATE:eff.rateUser.toFixed(4), CONV:eff.convRate, CURR:eff.currency, TOTAL:formatMoney(chargeUser, eff.currency), INR_TOTAL:chargeINR.toFixed(2), MANUAL:st.service.manual?'Yes':'No'}), {parse_mode:"Markdown", reply_markup:{inline_keyboard:[[{text:"✅ Confirm", callback_data:"confirm_yes"}, {text:"❌ Cancel", callback_data:"cancel_action"}]]}});
    }
    if(st.step==='await_service_manual'){
      try{
        const services=await getServices(); const svc=services.find(s=>String(s.service)===text);
        const manual=dbData.manual_services.find(s=>String(s.id)===text);
        const finalSvc=svc ? {...svc, manual:false} : (manual ? {service:manual.id, name:manual.name, category:manual.category, rate:manual.rate_inr, min:manual.min, max:manual.max, manual:true} : null);
        if(!finalSvc) return bot.sendMessage(uid, tr(uid,'invalid_sid',{ID:text}), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
        if(!isSvcEnabled(finalSvc.service) || !isCatEnabled(finalSvc.category)) return bot.sendMessage(uid, "Disabled by admin", {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
        state.set(uid,{step:'await_link', service:finalSvc}); return bot.sendMessage(uid, tr(uid,'ask_link'), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
      }catch(e){ return bot.sendMessage(uid, `❌ API Error: ${e.message}`, {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}}); }
    }
    if(st.step==='await_funds_amount'){
      const amt=parseFloat(text); if(isNaN(amt)||amt<1) return bot.sendMessage(uid, "Min 1", {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
      const u=getUser(uid); const curr=u.currency||'BDT';
      state.set(uid,{step:'await_gateway', amount:amt});
      return bot.sendMessage(uid, tr(uid,'ask_gateway',{AMT:formatMoney(amt,curr), CURR:curr}), {reply_markup:{inline_keyboard:[[{text:`📱 NagrikPay ${formatMoney(amt,curr)} - Only Gateway for BDT`, callback_data:`paygw_nagrikpay`}],[{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});
    }
  }

  const lang=getUser(uid).lang||'en';
  const tNew=T[lang]?.new_order||T.en.new_order;
  const tTrack=T[lang]?.track_order||T.en.track_order;
  const tAdd=T[lang]?.add_funds||T.en.add_funds;
  const tProf=T[lang]?.profile||T.en.profile;
  const tSup=T[lang]?.support||T.en.support;
  const tCurr=T[lang]?.currency||T.en.currency;
  const tLang=T[lang]?.language||T.en.language;

  if(text===tNew || text.includes("New Order") || text.includes("নতুন অর্ডার")){
    const chk=await checkUserJoinedAll(uid); if(FORCE_JOIN_ENABLED && !chk.joined){ return sendForceJoinMessage(uid); }
    try{
      const services=await getServices();
      const cats=getCategories(services).filter(isCatEnabled);
      const u=getUser(uid);
      let kb=[]; for(let i=0;i<cats.length;i++) kb.push([{text:cats[i], callback_data:`cat_${i}`}]);
      kb.push([{text:"🔢 Service ID", callback_data:"manual_service_trigger"}]);
      kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
      return bot.sendMessage(uid, tr(uid,'ask_cat',{CURR:u.currency}), {reply_markup:{inline_keyboard:kb}});
    }catch(e){ return bot.sendMessage(uid, `❌ SMM API Error: ${e.message}\n\n${T.en.invalid_sid||''}\nAdmin: /admin -> Test API or Add Manual Service`, {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}}); }
  }
  if(text==="🔢 Service ID" || text.includes("Service ID")){ state.set(uid,{step:'await_service_manual'}); return bot.sendMessage(uid, "Send Service ID:", {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}}); }
  if(text===tTrack || text.includes("Track Order") || text.includes("ট্র্যাক")){
    const rows=dbData.orders.filter(o=>o.user_id===uid).slice(-10).reverse();
    if(rows.length===0) return bot.sendMessage(uid, tr(uid,'no_orders'), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
    let txt=tr(uid,'your_orders')+"\n\n"; let kb=[];
    rows.forEach(r=>{ txt+=`#${maskIdPublic(r.order_id)} ${r.service_name.slice(0,18)} ${r.status} ${formatMoney(r.charge_user, r.charge_currency)}\n`; kb.push([{text:`Check #${maskIdPublic(r.order_id)}`, callback_data:`check_${r.order_id}`}]); });
    kb.push([{text:tr(uid,'cancel'), callback_data:"cancel_action"}]);
    return bot.sendMessage(uid, txt, {reply_markup:{inline_keyboard:kb}});
  }
  if(text===tAdd || text.includes("Add Funds") || text.includes("ফান্ড")){
    const chk=await checkUserJoinedAll(uid); if(FORCE_JOIN_ENABLED && !chk.joined){ return sendForceJoinMessage(uid); }
    const u=getUser(uid); const balBDT=u.balance_bdt||0; const balUSD=u.balance_usd||0; const currBal=u.currency==='USD'?balUSD:balBDT;
    state.set(uid,{step:'await_funds_amount'});
    return bot.sendMessage(uid, tr(uid,'balance_msg',{BDT:balBDT.toFixed(2), USD:balUSD.toFixed(2), CURR_WALLET:formatMoney(currBal, u.currency), CURR:u.currency}), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}});
  }
  if(text===tProf || text.includes("Profile") || text.includes("প্রোফাইল")){
    const u=getUser(uid); const totalOrders=dbData.orders.filter(o=>o.user_id===uid).length;
    return bot.sendMessage(uid, tr(uid,'profile_msg',{ID:uid, NAME:u.first_name, USERNAME:u.username||'none', LANG:u.lang, CURR:u.currency||'BDT', BDT:(u.balance_bdt||0).toFixed(2), USD:(u.balance_usd||0).toFixed(2), SPENT_BDT:(u.total_spent_bdt||0).toFixed(2), SPENT_USD:(u.total_spent_usd||0).toFixed(2), TOTAL_ORDERS:totalOrders}), {parse_mode:"Markdown", reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
  }
  if(text===tSup || text.includes("Support") || text.includes("সাপোর্ট")){ state.set(uid,{step:'support_chat'}); return bot.sendMessage(uid, tr(uid,'support_ask'), {reply_markup:{keyboard:[[{text:tr(uid,'cancel')}]], resize_keyboard:true}}); }
  if(text===tCurr || text.includes("Currency") || text.includes("মুদ্রা")) return askCurrency(uid);
  if(text===tLang || text.includes("Language") || text.includes("ভাষা")) return bot.sendMessage(uid, T.en.select_lang, {reply_markup:{inline_keyboard:[[{text:"🇧🇩 Bangla", callback_data:"lang_bn"}, {text:"🇬🇧 English", callback_data:"lang_en"}], [{text:tr(uid,'cancel'), callback_data:"cancel_action"}]]}});

  if(!st){
    const chk=await checkUserJoinedAll(uid); if(FORCE_JOIN_ENABLED && !chk.joined){ return sendForceJoinMessage(uid); }
    const u=getUser(uid); const bal=getUserBalanceInfo(u);
    bot.sendMessage(uid, tr(uid,'welcome',{BALANCE:formatMoney(bal.amount, bal.code), LANG:u.lang, CURR:bal.code, ID:uid}), {reply_markup:{keyboard: mainKb(uid), resize_keyboard:true}});
  }
});

async function checkPending(manual=false, adminId=null){
  const pend=dbData.orders.filter(o=>!['Completed','Canceled','Refunded','Partial','Manual Completed'].includes(o.status) && !o.manual);
  if(manual && adminId) bot.sendMessage(adminId, `⏳ Checking ${pend.length} pending API orders...`);
  for(let o of pend){
    try{
      const res=await smmPost({action:'status', order:o.order_id});
      const status=res.status; if(!status) continue;
      if(status!==o.status){
        o.status=status; saveDB();
        if(status==='Completed'){ try{ await bot.sendMessage(o.user_id, `✅ Order #${maskIdPublic(o.order_id)} Completed! ${o.service_name}`); }catch(e){} }
        else if(['Canceled','Refunded'].includes(status) && !o.refunded){ addBalance(o.user_id, o.charge_user, o.charge_currency); o.refunded=1; saveDB(); try{ await bot.sendMessage(o.user_id, `💸 #${maskIdPublic(o.order_id)} ${status}. Refunded ${formatMoney(o.charge_user, o.charge_currency)}`); }catch(e){} }
        else if(status==='Partial'){ const remains=parseInt(res.remains||0); if(remains>0 && !o.refunded){ const refundUser=o.charge_user*remains/o.quantity; addBalance(o.user_id, refundUser, o.charge_currency); o.refunded=1; saveDB(); try{ await bot.sendMessage(o.user_id, `⚠️ #${maskIdPublic(o.order_id)} Partial Remains ${remains} Refunded ${formatMoney(refundUser, o.charge_currency)}`); }catch(e){} } }
      }
      await new Promise(r=>setTimeout(r,1000));
    }catch(e){ console.log("cron", e.message); }
  }
  if(manual && adminId) bot.sendMessage(adminId, `✅ Checked ${pend.length}`);
}
setInterval(()=>checkPending(false), 3*60*1000);

console.log("✅ FINAL SMM Bot 100% Free Lifetime | cPanel No Terminal | Telebothost Not Used");
console.log("Admins:", ADMIN_IDS);
console.log("Groups: Order", ORDER_GROUP_ID, "Deposit", DEPOSIT_GROUP_ID, "Support", SUPPORT_GROUP_ID);
console.log("NagrikPay Only Gateway:", NAGRIKPAY_KEY ? "Key Set" : "NOT SET - Set NAGRIKPAY_API_KEY");
console.log(`Webhook: ${WEBHOOK_URL}/webhook/nagrikpay`);
console.log("Rates hidden from users, only admin can see");
