const VERSION="0.5.10";
const CACHE="turnisync-v0510";
const CORE=["./","./index.html","./style.css","./app.js?v=0.5.10","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png"];
self.addEventListener("install",event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(CORE);await self.skipWaiting();})()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith("turnisync-")&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})()));
self.addEventListener("message",event=>{if(event.data==="SKIP_WAITING")self.skipWaiting();});
self.addEventListener("fetch",event=>{
 if(event.request.method!=="GET")return;
 const url=new URL(event.request.url);if(url.origin!==location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{
   const response=await fetch(event.request,{cache:"no-store"});
   if(response&&response.ok){
    const key=event.request.mode==="navigate"?"./index.html":event.request;
    await cache.put(key,response.clone());
   }
   return response;
  }catch(error){
   const cached=await caches.match(event.request)||await caches.match("./index.html");
   if(cached)return cached;
   throw error;
  }
 })());
});
