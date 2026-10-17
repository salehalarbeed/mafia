/* مافيا — service worker: يخلي اللعبة تفتح أسرع وتنثبت كتطبيق */
const CACHE='mafia-v1';
const SHELL=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png','./privacy.html','./terms.html'];
const LIBS=/^https:\/\/(www\.gstatic\.com\/firebasejs|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==CACHE).map(n=>caches.delete(n)))).then(()=>self.clients.claim()));});

self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  // pages of the game: always try the network first so updates arrive, fall back to the saved copy
  if(url.origin===location.origin){
    e.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return res;})
      .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||caches.match('./index.html'))));
    return;
  }
  // libraries and fonts: serve the saved copy instantly, refresh it in the background
  if(LIBS.test(req.url)){
    e.respondWith(caches.open(CACHE).then(async c=>{const hit=await c.match(req);
      const net=fetch(req).then(res=>{if(res&&(res.ok||res.type==='opaque'))c.put(req,res.clone());return res;}).catch(()=>hit);
      return hit||net;}));
  }
  // everything else (Firebase data) goes straight to the network
});
