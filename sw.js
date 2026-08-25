/* Копилка — service worker.
   Задачи:
   1) push-уведомления (текст собирается ЛОКАЛЬНО из IndexedDB — данные не уходят на сервер);
   2) офлайн-доступ (network-first, чтобы обновления применялись сразу). */
const CACHE="kopilka-v1";
const ASSETS=["./","./index.html","./manifest.webmanifest","./icon.svg","./apple-touch-icon.png"];

self.addEventListener("install",(e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",(e)=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
/* network-first: всегда свежая версия, офлайн — из кэша */
self.addEventListener("fetch",(e)=>{
  const r=e.request;
  if(r.method!=="GET"||!r.url.startsWith(self.location.origin))return;
  e.respondWith(
    fetch(r).then(resp=>{
      const copy=resp.clone();
      caches.open(CACHE).then(c=>c.put(r,copy)).catch(()=>{});
      return resp;
    }).catch(()=>caches.match(r).then(m=>m||caches.match("./index.html")))
  );
});

/* ---------- локальная сводка из IndexedDB ---------- */
function idbGet(key){
  return new Promise((res)=>{
    let done=false;
    const to=setTimeout(()=>{if(!done){done=true;res(null);}},1500);
    try{
      const req=indexedDB.open("kopilka",1);
      req.onupgradeneeded=()=>{try{req.result.createObjectStore("meta");}catch(e){}};
      req.onerror=()=>{if(!done){done=true;clearTimeout(to);res(null);}};
      req.onsuccess=()=>{
        try{
          const db=req.result;
          if(!db.objectStoreNames.contains("meta")){done=true;clearTimeout(to);return res(null);}
          const g=db.transaction("meta","readonly").objectStore("meta").get(key);
          g.onsuccess=()=>{if(!done){done=true;clearTimeout(to);res(g.result||null);}};
          g.onerror=()=>{if(!done){done=true;clearTimeout(to);res(null);}};
        }catch(e){if(!done){done=true;clearTimeout(to);res(null);}}
      };
    }catch(e){if(!done){done=true;clearTimeout(to);res(null);}}
  });
}
function fmt(n){
  n=Math.round(Number(n)||0);
  const neg=n<0; n=Math.abs(n);
  return (neg?"−":"")+n.toLocaleString("ru-RU");
}
/* Текст уведомления собирается здесь, на устройстве. */
async function buildMessage(kind){
  const s=await idbGet("summary");
  if(kind==="statement"){
    const d=s&&s.statementDays;
    return{title:"📄 Пора обновить аналитику",
      body:d?`Последняя выписка была ${d} дн. назад. Загрузи свежую.`:"Загрузи свежую банковскую выписку."};
  }
  if(!s)return{title:"📊 Финансовый отчёт за неделю",body:"Открой Копилку, чтобы посмотреть итоги недели."};
  const parts=[];
  if(s.weekInc!=null)parts.push("Доход "+fmt(s.weekInc)+" ₸");
  if(s.weekExp!=null)parts.push("Траты "+fmt(s.weekExp)+" ₸");
  if(s.weekSaved!=null)parts.push("Отложено "+fmt(s.weekSaved)+" ₸");
  const body=parts.length?parts.join(" · "):"Открой Копилку, чтобы посмотреть итоги недели.";
  return{title:"📊 Твоя неделя",body};
}
self.addEventListener("push",(e)=>{
  /* Сервер шлёт только сигнал без данных: что показать — решаем здесь, по локальным данным. */
  let kind="";
  try{ if(e.data){const t=e.data.text(); if(t&&t.length<40)kind=t.trim();} }catch(_){}
  e.waitUntil((async()=>{
    if(!kind){
      const s=await idbGet("summary");
      kind=(s&&s.statementDays>=7)?"statement":"weekly";
    }
    const m=await buildMessage(kind);
    await self.registration.showNotification(m.title,{
      body:m.body, icon:"./apple-touch-icon.png", badge:"./apple-touch-icon.png",
      tag:"kopilka-"+kind, renotify:true, data:{kind}
    });
  })());
});
self.addEventListener("notificationclick",(e)=>{
  e.notification.close();
  const kind=(e.notification.data&&e.notification.data.kind)||"weekly";
  const url=new URL("./",self.location.href).href+(kind==="statement"?"#import":"#report");
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const c of list){ if(c.url.startsWith(new URL("./",self.location.href).href)&&"focus" in c){
      c.navigate&&c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
