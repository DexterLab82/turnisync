const $ = (id) => document.getElementById(id);
const state = { image:null, people:[], selected:new Set(), shifts:[], preferred:localStorage.getItem("ts_preferred")||"", settings:JSON.parse(localStorage.getItem("ts_settings")||"null")||{codes:{1:{name:"Mattina",start:"06:00",end:"14:00"},2:{name:"Pomeriggio",start:"14:00",end:"22:00"},3:{name:"Notte",start:"22:00",end:"06:00"}},duplicates:true} };

document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>showTab(b.dataset.tab)));
function showTab(id){document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===id));document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("active",s.id===id));if(id==="people")renderPeople();if(id==="preview")renderShifts();}
$("imageInput").addEventListener("change",e=>{const f=e.target.files?.[0];if(!f)return;state.image=f;const url=URL.createObjectURL(f);$("imagePreview").src=url;$("imagePreviewWrap").classList.remove("hidden");$("analyzeBtn").disabled=false;$("homeMessage").textContent="Immagine caricata. Premi Analizza turni.";});
$("clearImage").onclick=()=>{state.image=null;$("imageInput").value="";$("imagePreviewWrap").classList.add("hidden");$("analyzeBtn").disabled=true;};
$("analyzeBtn").onclick=analyze;
function setProgress(p,msg){$("ocrProgress").classList.remove("hidden");$("progressBar").style.width=(p*100)+"%";$("progressText").textContent=msg;}
async function analyze(){
 if(!state.image)return;
 if(!window.Tesseract){$("homeMessage").textContent="Libreria OCR non disponibile. Controlla la connessione e ricarica la pagina.";return;}
 $("analyzeBtn").disabled=true;
 try{
  setProgress(.03,"Avvio motore OCR…");
  const worker=await Tesseract.createWorker("ita+eng",1,{logger:m=>{if(m.status==="recognizing text")setProgress(m.progress,`Riconoscimento testo: ${Math.round(m.progress*100)}%`);}});
  const result=await worker.recognize(state.image);
  await worker.terminate();
  setProgress(1,"Analisi completata.");
  const parsed=parseOCR(result.data);
  state.people=parsed.people;state.shifts=parsed.shifts;
  const preferred=state.preferred.toLocaleLowerCase("it");
  state.selected=new Set(state.people.filter(p=>p.toLocaleLowerCase("it")===preferred));
  $("homeMessage").textContent=`OCR completato. ${parsed.people.length} persone individuate, ${parsed.shifts.length} turni candidati. ${parsed.warnings.length?parsed.warnings.length+" elementi richiedono controllo.":""}`;
  if(!parsed.shifts.length)$("homeMessage").textContent+=" Non ho ricostruito turni con sufficiente certezza: puoi comunque verificare il testo OCR e riprovare con uno screenshot più nitido.";
  renderPeople();renderShifts();
 }catch(err){$("homeMessage").textContent="Errore durante OCR: "+err.message;}
 finally{$("analyzeBtn").disabled=false;}
}
function norm(s){return s.toLocaleLowerCase("it").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[^\p{L}\p{N}/:\- ]/gu," ").trim();}
function dateFromText(s,year){let m=s.match(/(?:lun|mar|mer|gio|ven|sab|dom)?\s*(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/i);if(!m)return null;let y=m[3]?Number(m[3]):year;if(y<100)y+=2000;let d=new Date(y,Number(m[2])-1,Number(m[1]),12);return d.getFullYear()===y&&d.getMonth()===Number(m[2])-1&&d.getDate()===Number(m[1])?d:null;}
function parseOCR(data){
 const words=(data.words||[]).filter(w=>w.text&&w.confidence>15).map(w=>({text:w.text.trim(),x:(w.bbox.x0+w.bbox.x1)/2,y:(w.bbox.y0+w.bbox.y1)/2,b:w.bbox,conf:w.confidence/100}));
 // cluster tokens into visual rows using center Y; tesseract coordinates origin top-left
 words.sort((a,b)=>a.y-b.y||a.x-b.x);const rows=[];
 for(const w of words){let r=rows.find(r=>Math.abs(r.cy-w.y)<Math.max(12,(w.b.y1-w.b.y0)*.7));if(!r){r={cy:w.y,items:[]};rows.push(r);}r.items.push(w);r.cy=r.items.reduce((s,v)=>s+v.y,0)/r.items.length;}
 rows.forEach(r=>r.items.sort((a,b)=>a.x-b.x));
 const year=new Date().getFullYear();let headers=[];
 // Date tokens often OCR'd as one token; also handle weekday + numeric date adjacent by testing token itself.
 for(const w of rows.slice(0,4).flatMap(r=>r.items)){const d=dateFromText(w.text,year);if(d)headers.push({x:w.x,date:d,label:w.text});}
 // If the header is split (e.g. weekday and number), join nearby tokens.
 if(headers.length<2){for(const r of rows.slice(0,3)){for(let i=0;i<r.items.length-1;i++){const combo=r.items[i].text+" "+r.items[i+1].text;const d=dateFromText(combo,year);if(d)headers.push({x:(r.items[i].x+r.items[i+1].x)/2,date:d,label:combo});}}}
 headers=headers.sort((a,b)=>a.x-b.x).filter((h,i,a)=>i===0||Math.abs(h.x-a[i-1].x)>8);
 const leftBoundary=headers.length?headers[0].x:Math.max(...words.map(w=>w.x))*.22;
 const people=[],shifts=[],warnings=[];
 // identify row labels at left of date columns; assume a name is a mostly alphabetic token/string
 for(const r of rows){
  const left=r.items.filter(w=>w.x<leftBoundary-5);
  if(!left.length)continue;
  const name=left.map(w=>w.text).join(" ").replace(/[0-9]/g,"").trim();
  if(name.length<2||!/[a-zà-ÿ]/i.test(name)||/^(lun|mar|mer|gio|ven|sab|dom)$/i.test(name))continue;
  if(!people.some(p=>norm(p)===norm(name)))people.push(name);
  if(!headers.length)continue;
  for(const w of r.items.filter(w=>w.x>=leftBoundary-5)){
    const h=headers.reduce((best,v)=>Math.abs(v.x-w.x)<Math.abs(best.x-w.x)?v:best,headers[0]);
    const distances=headers.map(v=>Math.abs(v.x-w.x)).sort((a,b)=>a-b);
    if(distances[0]>(headers.length>1?(headers[1].x-headers[0].x)*.48:45))continue;
    const codeMatch=w.text.match(/^[1-3]$/);
    if(!codeMatch){if(/\d/.test(w.text)&&w.conf<.75)warnings.push(`${name}: testo "${w.text}" da verificare`);continue;}
    const code=Number(codeMatch[0]),cfg=state.settings.codes[code];if(!cfg)continue;
    const start=combineDateTime(h.date,cfg.start),end=combineDateTime(h.date,cfg.end);
    if(end<=start)end.setDate(end.getDate()+1);
    shifts.push({id:crypto.randomUUID?crypto.randomUUID():String(Math.random()),person:name,date:isoDate(h.date),code,start:isoLocal(start),end:isoLocal(end),confidence:w.conf,review:w.conf<.65});
  }
 }
 return {people,shifts,warnings};
}
function combineDateTime(date,time){const [h,m]=time.split(":").map(Number);return new Date(date.getFullYear(),date.getMonth(),date.getDate(),h,m,0);}
function isoDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function isoLocal(d){return `${isoDate(d)}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;}
function displayDate(s){const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d,12).toLocaleDateString("it-IT",{weekday:"short",day:"numeric",month:"short"});}
function renderPeople(){
 const el=$("peopleList");if(!state.people.length){el.className="panel empty";el.textContent="Prima carica e analizza uno screenshot.";return;}
 el.className="panel";el.innerHTML="";
 state.people.forEach(p=>{const row=document.createElement("div");row.className="person-row";const cb=document.createElement("input");cb.type="checkbox";cb.checked=state.selected.has(p);cb.onchange=()=>{cb.checked?state.selected.add(p):state.selected.delete(p);renderShifts();};const label=document.createElement("label");label.textContent=p;const small=document.createElement("small");small.textContent=state.shifts.filter(s=>norm(s.person)===norm(p)).length+" turni";row.append(cb,label,small);el.append(row);});
 $("savePreferred").disabled=!state.selected.size;
}
$("savePreferred").onclick=()=>{const first=[...state.selected][0]||"";state.preferred=first;$("preferredName").value=first;localStorage.setItem("ts_preferred",first);$("homeMessage").textContent=first?`Preferito salvato: ${first}`:"Preferenza rimossa.";};
function renderShifts(){
 const list=$("shiftList");const chosen=state.shifts.filter(s=>state.selected.has(s.person));$("countTotal").textContent=chosen.length;$("countReview").textContent=chosen.filter(s=>s.review).length;$("countPeople").textContent=state.selected.size;
 $("exportBtn").disabled=!chosen.length;
 if(!chosen.length){list.innerHTML='<div class="panel empty">Nessun turno per le persone selezionate.</div>';return;}
 list.innerHTML="";
 chosen.forEach(s=>{
  const card=document.createElement("article");card.className="shift-card";
  const title=document.createElement("div");title.className="shift-top";
  const strong=document.createElement("div");strong.className="shift-title";strong.textContent=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[s.code]||"Turno";
  title.append(strong);if(s.review){const tag=document.createElement("span");tag.className="tag";tag.textContent="Verifica OCR";title.append(tag);}
  const meta=document.createElement("div");meta.className="shift-meta";meta.textContent=`${s.person} · ${displayDate(s.date)} · Codice ${s.code}`;
  const edit=document.createElement("div");edit.className="shift-edit";
  const code=document.createElement("select");[1,2,3].forEach(n=>{const o=document.createElement("option");o.value=n;o.textContent=`${n} · ${state.settings.codes[n].name}`;code.append(o)});code.value=s.code;
  const start=document.createElement("input");start.type="datetime-local";start.value=s.start;
  const end=document.createElement("input");end.type="datetime-local";end.value=s.end;
  const person=document.createElement("input");person.value=s.person;person.placeholder="Persona";
  edit.append(code,start,end,person);
  const actions=document.createElement("div");actions.className="shift-actions";
  const remove=document.createElement("button");remove.textContent="Rimuovi";remove.onclick=()=>{state.shifts=state.shifts.filter(x=>x.id!==s.id);renderShifts();};
  const save=document.createElement("button");save.textContent="Salva modifica";save.onclick=()=>{s.code=Number(code.value);s.start=start.value;s.end=end.value;s.person=person.value.trim()||s.person;s.review=false;renderShifts();};
  actions.append(remove,save);card.append(title,meta,edit,actions);list.append(card);
 });
}
function escapeICS(s){return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");}
function icsDateUTC(s){return new Date(s).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/," ").replace(" ","");}
$("exportBtn").onclick=()=>{
 const chosen=state.shifts.filter(s=>state.selected.has(s.person));
 if(!chosen.length)return;
 const seen=new Set(),events=[];
 for(const s of chosen){const title=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[s.code];const key=[s.start,s.end,title].join("|");if(state.settings.duplicates&&seen.has(key))continue;seen.add(key);
  const start=new Date(s.start),end=new Date(s.end);
  events.push(["BEGIN:VEVENT",`UID:${s.id}@turnisync.local`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"")}`,`DTSTART:${icsDateUTC(s.start)}`,`DTEND:${icsDateUTC(s.end)}`,`SUMMARY:${escapeICS(title)}`,`DESCRIPTION:${escapeICS("Persona: "+s.person+"\\nCodice turno: "+s.code)}`,"END:VEVENT"].join("\r\n"));
 }
 const calendar=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//TurniSync//IT","CALSCALE:GREGORIAN",...events,"END:VCALENDAR"].join("\r\n");
 const blob=new Blob([calendar],{type:"text/calendar;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="TurniSync-turni.ics";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
 $("exportMessage").classList.remove("hidden");$("exportMessage").textContent=`File calendario creato con ${events.length} eventi. Aprilo da File/Download e scegli di aggiungerlo al Calendario.`;
};
function loadSettings(){
 $("preferredName").value=state.preferred;$("duplicateCheck").checked=state.settings.duplicates;
 for(let i=1;i<=3;i++){$("s"+i+"start").value=state.settings.codes[i].start;$("s"+i+"end").value=state.settings.codes[i].end;}
}
$("saveSettings").onclick=()=>{
 state.preferred=$("preferredName").value.trim();state.settings.duplicates=$("duplicateCheck").checked;
 for(let i=1;i<=3;i++){state.settings.codes[i].start=$("s"+i+"start").value;state.settings.codes[i].end=$("s"+i+"end").value;}
 localStorage.setItem("ts_preferred",state.preferred);localStorage.setItem("ts_settings",JSON.stringify(state.settings));$("homeMessage").textContent="Impostazioni salvate sul dispositivo.";
};
$("resetBtn").onclick=()=>{if(!confirm("Cancellare persone e turni della sessione?"))return;state.people=[];state.selected.clear();state.shifts=[];state.image=null;$("imagePreviewWrap").classList.add("hidden");$("imageInput").value="";$("analyzeBtn").disabled=true;renderPeople();renderShifts();};
loadSettings();
if("serviceWorker" in navigator && location.protocol.startsWith("http"))window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
