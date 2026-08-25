/* =====================================================================
   Копилка — сервер push-уведомлений (Cloudflare Worker).
   ВАЖНО: сервер НЕ получает и НЕ хранит финансовые данные.
   Он отправляет пустой «сигнал», а текст уведомления телефон собирает
   сам из локальной базы (см. sw.js).
   Хранится только подписка браузера на push (endpoint + ключи).
   ===================================================================== */

const CORS={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
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
  return Array.from(new Uint8Array(h)).map(x=>x.toString(16).padStart(2,"0")).join("").slice(0,32);
}

/* ---------- VAPID: подписываем JWT (ES256) ---------- */
async function vapidHeaders(endpoint,env){
  const aud=new URL(endpoint).origin;
  const header={typ:"JWT",alg:"ES256"};
  const payload={aud,exp:Math.floor(Date.now()/1000)+12*3600,sub:env.VAPID_SUBJECT||"mailto:admin@example.com"};
  const enc=(o)=>b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data=enc(header)+"."+enc(payload);
  const jwk=JSON.parse(env.VAPID_PRIVATE_JWK);
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new TextEncoder().encode(data));
  const jwt=data+"."+b64url(sig);
  return{
    "Authorization":"vapid t="+jwt+", k="+env.VAPID_PUBLIC_KEY,
    "TTL":"86400",
    "Urgency":"normal",
    "Content-Length":"0"
  };
}

/* ---------- отправка одного пуша (без полезной нагрузки) ---------- */
async function sendPush(sub,env){
  try{
    const headers=await vapidHeaders(sub.endpoint,env);
    const res=await fetch(sub.endpoint,{method:"POST",headers});
    return{ok:res.ok,status:res.status};
  }catch(e){ return{ok:false,status:0,error:String(e&&e.message||e)}; }
}

/* ---------- рассылка всем подписчикам ---------- */
async function broadcast(env){
  let cursor,sent=0,removed=0,failed=0;
  do{
    const list=await env.SUBS.list({prefix:"sub:",cursor});
    cursor=list.list_complete?null:list.cursor;
    for(const k of list.keys){
      const raw=await env.SUBS.get(k.name);
      if(!raw){continue;}
      let sub; try{sub=JSON.parse(raw);}catch(_){await env.SUBS.delete(k.name);removed++;continue;}
      const r=await sendPush(sub,env);
      if(r.ok)sent++;
      else if(r.status===404||r.status===410){await env.SUBS.delete(k.name);removed++;}  /* подписка мертва */
      else failed++;
    }
  }while(cursor);
  return{sent,removed,failed};
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS")return new Response(null,{headers:CORS});
    const url=new URL(request.url);

    if(url.pathname==="/health")
      return json({ok:true,configured:!!(env.VAPID_PRIVATE_JWK&&env.VAPID_PUBLIC_KEY),
        publicKey:env.VAPID_PUBLIC_KEY||null});

    if(url.pathname==="/subscribe"&&request.method==="POST"){
      let body; try{body=await request.json();}catch(_){return json({error:"bad json"},400);}
      const sub=body&&body.subscription;
      if(!sub||!sub.endpoint)return json({error:"нет подписки"},400);
      const id=await sha256hex(sub.endpoint);
      await env.SUBS.put("sub:"+id,JSON.stringify({endpoint:sub.endpoint,keys:sub.keys||null,
        created:Date.now(),tz:(body.tz||"")+""}));
      return json({ok:true,id});
    }

    if(url.pathname==="/unsubscribe"&&request.method==="POST"){
      let body; try{body=await request.json();}catch(_){return json({error:"bad json"},400);}
      const ep=body&&(body.endpoint||(body.subscription&&body.subscription.endpoint));
      if(!ep)return json({error:"нет endpoint"},400);
      await env.SUBS.delete("sub:"+await sha256hex(ep));
      return json({ok:true});
    }

    /* проверочный пуш — приходит сразу, чтобы убедиться, что всё работает */
    if(url.pathname==="/test"&&request.method==="POST"){
      let body; try{body=await request.json();}catch(_){body={};}
      const ep=body&&(body.endpoint||(body.subscription&&body.subscription.endpoint));
      if(!ep)return json({error:"нет endpoint"},400);
      const raw=await env.SUBS.get("sub:"+await sha256hex(ep));
      if(!raw)return json({error:"подписка не найдена — сначала включи уведомления"},404);
      const r=await sendPush(JSON.parse(raw),env);
      return json(r,r.ok?200:502);
    }

    return json({error:"not found"},404);
  },

  /* Cron: воскресенье 15:00 UTC = 20:00 по Астане */
  async scheduled(event,env,ctx){
    ctx.waitUntil(broadcast(env));
  }
};
