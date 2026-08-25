/* =====================================================================
   Копилка — сервер (Cloudflare Worker).
   Два назначения:
     1) /sync/*  — аккаунт и облачная копия данных;
     2) /push/*  — push-уведомления (и старые пути без префикса).

   ПРИВАТНОСТЬ. Сервер НЕ видит финансовые данные: телефон шифрует их
   до отправки (AES-GCM, ключ выводится из пароля и никогда не покидает
   устройство). Здесь хранится только нечитаемый блок байтов.
   Пароль на сервер тоже не попадает — приходит производный ключ, и от
   него хранится ещё один хэш.
   ===================================================================== */

const CORS={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type,Authorization",
  "Access-Control-Max-Age":"86400"
};
const json=(o,status)=>new Response(JSON.stringify(o),
  {status:status||200,headers:Object.assign({"Content-Type":"application/json"},CORS)});

function b64url(buf){
  const b=btoa(String.fromCharCode.apply(null,new Uint8Array(buf)));
  return b.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function sha256hex(str){
  const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(str));
  return Array.from(new Uint8Array(h)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
/* сравнение без утечки времени */
function safeEqual(a,b){
  if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;
  let d=0; for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
}
const normLogin=(s)=>String(s||"").trim().toLowerCase();
const validLogin=(s)=>/^[a-z0-9._-]{3,32}$/.test(s);

/* ---------- сессии ---------- */
async function newToken(env,login){
  const t=b64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.KV.put("tok:"+await sha256hex(t),login,{expirationTtl:60*60*24*90});
  return t;
}
async function loginFromToken(env,request){
  const h=request.headers.get("Authorization")||"";
  const t=h.replace(/^Bearer\s+/i,"").trim();
  if(!t)return null;
  return await env.KV.get("tok:"+await sha256hex(t));
}

/* ---------- push (без изменений по сути) ---------- */
async function vapidHeaders(endpoint,env){
  const aud=new URL(endpoint).origin;
  const enc=(o)=>b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data=enc({typ:"JWT",alg:"ES256"})+"."+enc({aud,
    exp:Math.floor(Date.now()/1000)+12*3600,
    sub:env.VAPID_SUBJECT||"mailto:admin@example.com"});
  const key=await crypto.subtle.importKey("jwk",JSON.parse(env.VAPID_PRIVATE_JWK),
    {name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new TextEncoder().encode(data));
  return{"Authorization":"vapid t="+data+"."+b64url(sig)+", k="+env.VAPID_PUBLIC_KEY,
    "TTL":"86400","Urgency":"normal","Content-Length":"0"};
}
async function sendPush(sub,env){
  try{
    const res=await fetch(sub.endpoint,{method:"POST",headers:await vapidHeaders(sub.endpoint,env)});
    return{ok:res.ok,status:res.status};
  }catch(e){return{ok:false,status:0};}
}
async function broadcast(env){
  let cursor,sent=0,removed=0,failed=0;
  do{
    const list=await env.KV.list({prefix:"sub:",cursor});
    cursor=list.list_complete?null:list.cursor;
    for(const k of list.keys){
      const raw=await env.KV.get(k.name); if(!raw)continue;
      let sub; try{sub=JSON.parse(raw);}catch(_){await env.KV.delete(k.name);removed++;continue;}
      const r=await sendPush(sub,env);
      if(r.ok)sent++;
      else if(r.status===404||r.status===410){await env.KV.delete(k.name);removed++;}
      else failed++;
    }
  }while(cursor);
  return{sent,removed,failed};
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS")return new Response(null,{headers:CORS});
    const url=new URL(request.url);
    const path=url.pathname.replace(/^\/push(?=\/|$)/,"")||"/";

    if(path==="/health"||path==="/")
      return json({ok:true,
        push:!!(env.VAPID_PRIVATE_JWK&&env.VAPID_PUBLIC_KEY),
        sync:!!env.KV, publicKey:env.VAPID_PUBLIC_KEY||null});

    /* ================= АККАУНТ И СИНХРОНИЗАЦИЯ ================= */

    /* регистрация: приходит логин и производный ключ (не пароль!) */
    if(path==="/sync/register"&&request.method==="POST"){
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      const login=normLogin(b.login);
      if(!validLogin(login))return json({error:"Логин: 3–32 символа, латиница, цифры, . _ -"},400);
      if(!b.authKey||String(b.authKey).length<32)return json({error:"нет ключа"},400);
      if(await env.KV.get("user:"+login))return json({error:"Такой логин уже занят"},409);
      await env.KV.put("user:"+login,JSON.stringify({
        authHash:await sha256hex(b.authKey), created:Date.now(),
        blob:null, version:0, updatedAt:0}));
      return json({ok:true,token:await newToken(env,login),version:0});
    }

    /* вход */
    if(path==="/sync/login"&&request.method==="POST"){
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      const login=normLogin(b.login);
      const raw=await env.KV.get("user:"+login);
      /* одинаковый ответ, чтобы нельзя было перебирать существующие логины */
      if(!raw)return json({error:"Неверный логин или пароль"},401);
      const u=JSON.parse(raw);
      if(!safeEqual(u.authHash,await sha256hex(b.authKey||"")))
        return json({error:"Неверный логин или пароль"},401);
      return json({ok:true,token:await newToken(env,login),
        version:u.version||0,updatedAt:u.updatedAt||0,hasData:!!u.blob});
    }

    /* выход */
    if(path==="/sync/logout"&&request.method==="POST"){
      const h=request.headers.get("Authorization")||"";
      const t=h.replace(/^Bearer\s+/i,"").trim();
      if(t)await env.KV.delete("tok:"+await sha256hex(t));
      return json({ok:true});
    }

    /* скачать облачную копию */
    if(path==="/sync/pull"&&request.method==="GET"){
      const login=await loginFromToken(env,request);
      if(!login)return json({error:"нужен вход"},401);
      const raw=await env.KV.get("user:"+login);
      if(!raw)return json({error:"аккаунт не найден"},404);
      const u=JSON.parse(raw);
      return json({ok:true,blob:u.blob||null,version:u.version||0,updatedAt:u.updatedAt||0});
    }

    /* загрузить копию. baseVersion защищает от перезаписи чужих изменений */
    if(path==="/sync/push"&&request.method==="PUT"){
      const login=await loginFromToken(env,request);
      if(!login)return json({error:"нужен вход"},401);
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      if(typeof b.blob!=="string"||!b.blob)return json({error:"нет данных"},400);
      if(b.blob.length>20*1024*1024)return json({error:"слишком большой объём"},413);
      const raw=await env.KV.get("user:"+login);
      if(!raw)return json({error:"аккаунт не найден"},404);
      const u=JSON.parse(raw);
      const cur=u.version||0;
      if(b.baseVersion!==undefined&&b.baseVersion!==null&&b.baseVersion!==cur)
        return json({error:"conflict",serverVersion:cur,blob:u.blob||null,updatedAt:u.updatedAt||0},409);
      u.blob=b.blob; u.version=cur+1; u.updatedAt=Date.now();
      await env.KV.put("user:"+login,JSON.stringify(u));
      return json({ok:true,version:u.version,updatedAt:u.updatedAt});
    }

    /* смена пароля: заново присылаются ключ и перешифрованные данные */
    if(path==="/sync/rekey"&&request.method==="POST"){
      const login=await loginFromToken(env,request);
      if(!login)return json({error:"нужен вход"},401);
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      if(!b.authKey||typeof b.blob!=="string")return json({error:"нет данных"},400);
      const raw=await env.KV.get("user:"+login);
      if(!raw)return json({error:"аккаунт не найден"},404);
      const u=JSON.parse(raw);
      u.authHash=await sha256hex(b.authKey);
      u.blob=b.blob; u.version=(u.version||0)+1; u.updatedAt=Date.now();
      await env.KV.put("user:"+login,JSON.stringify(u));
      return json({ok:true,version:u.version});
    }

    /* ================= PUSH ================= */
    if(path==="/subscribe"&&request.method==="POST"){
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      const sub=b&&b.subscription;
      if(!sub||!sub.endpoint)return json({error:"нет подписки"},400);
      const id=(await sha256hex(sub.endpoint)).slice(0,32);
      await env.KV.put("sub:"+id,JSON.stringify({endpoint:sub.endpoint,keys:sub.keys||null,
        created:Date.now(),tz:(b.tz||"")+""}));
      return json({ok:true,id});
    }
    if(path==="/unsubscribe"&&request.method==="POST"){
      let b; try{b=await request.json();}catch(_){return json({error:"bad json"},400);}
      const ep=b&&(b.endpoint||(b.subscription&&b.subscription.endpoint));
      if(!ep)return json({error:"нет endpoint"},400);
      await env.KV.delete("sub:"+(await sha256hex(ep)).slice(0,32));
      return json({ok:true});
    }
    if(path==="/test"&&request.method==="POST"){
      let b; try{b=await request.json();}catch(_){b={};}
      const ep=b&&(b.endpoint||(b.subscription&&b.subscription.endpoint));
      if(!ep)return json({error:"нет endpoint"},400);
      const raw=await env.KV.get("sub:"+(await sha256hex(ep)).slice(0,32));
      if(!raw)return json({error:"подписка не найдена — сначала включи уведомления"},404);
      const r=await sendPush(JSON.parse(raw),env);
      return json(r,r.ok?200:502);
    }

    return json({error:"not found"},404);
  },

  /* Cron: воскресенье 15:00 UTC = 20:00 по Астане */
  async scheduled(event,env,ctx){ ctx.waitUntil(broadcast(env)); }
};
