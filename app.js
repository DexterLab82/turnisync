const $ = (id) => document.getElementById(id);
const state = {
  image: null, people: [], selected: new Set(), shifts: [], debugReport: null,
  preferred: localStorage.getItem("ts_preferred") || "",
  settings: JSON.parse(localStorage.getItem("ts_settings") || "null") || {
    codes: {
      1: { name: "Mattina", start: "06:00", end: "14:00" },
      2: { name: "Pomeriggio", start: "14:00", end: "22:00" },
      3: { name: "Notte", start: "22:00", end: "06:00" }
    },
    duplicates: true
  }
};

document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(id) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
  if (id === "people") renderPeople();
  if (id === "preview") renderShifts();
}
$("imageInput").addEventListener("change", e => {
  const f = e.target.files?.[0]; if (!f) return;
  state.image = f;
  $("imagePreview").src = URL.createObjectURL(f);
  $("imagePreviewWrap").classList.remove("hidden");
  $("analyzeBtn").disabled = false;
  $("homeMessage").textContent = "Screenshot caricato. Rilevamento tabella: nomi a sinistra, giorni in alto.";
});
$("clearImage").onclick = () => {
  state.image = null; $("imageInput").value = ""; $("imagePreviewWrap").classList.add("hidden");
  $("analyzeBtn").disabled = true;
};
$("analyzeBtn").onclick = analyze;

function setProgress(p, msg) {
  $("ocrProgress").classList.remove("hidden");
  $("progressBar").style.width = (p * 100) + "%";
  $("progressText").textContent = msg;
}
async function analyze() {
  if (!state.image) return;
  if (!window.Tesseract) {
    $("homeMessage").textContent = "Motore OCR non disponibile. Controlla la connessione e ricarica la pagina.";
    return;
  }
  $("analyzeBtn").disabled = true;
  try {
    setProgress(.02, "Avvio riconoscimento locale…");
    const worker = await Tesseract.createWorker("ita+eng", 1, {
      logger: m => {
        if (m.status === "recognizing text")
          setProgress(m.progress, `Lettura tabella: ${Math.round(m.progress * 100)}%`);
      }
    });
    const prepared = await prepareOCRImage(state.image);
    const result = await worker.recognize(prepared.canvas);
    setProgress(.72, "Separazione delle celle e verifica dei nominativi…");
    const parsed = await parseShiftTable(result.data, prepared.width, prepared.height, prepared.canvas, worker, setProgress);
    await worker.terminate();
    state.people = parsed.people;
    state.shifts = parsed.shifts;
    state.debugReport = buildDebugReport(result.data, parsed, prepared.width, prepared.height);
    renderDebug();
    state.selected = new Set(state.people.filter(p => normalize(p) === normalize(state.preferred)));
    renderPeople(); renderShifts();
    $("homeMessage").textContent =
      `Tabella analizzata (${parsed.period}). ${parsed.people.length} persone, ${parsed.shifts.length} turni riconosciuti. ` +
      (parsed.warnings.length ? parsed.warnings.slice(0, 5).join(" · ") : "Controlla comunque tutte le righe prima dell'esportazione.");
    if (!parsed.shifts.length) $("homeMessage").textContent += " Non sono stati trovati codici 1/2/3 affidabili.";
  } catch (err) {
    $("homeMessage").textContent = "Errore OCR: " + err.message;
  } finally {
    $("analyzeBtn").disabled = false;
  }
}


async function prepareOCRImage(file) {
  const image = new Image(), url = URL.createObjectURL(file);
  try {
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    const scale=Math.min(3,Math.max(2,1800/image.naturalWidth));
    const canvas=document.createElement("canvas");
    canvas.width=Math.round(image.naturalWidth*scale);
    canvas.height=Math.round(image.naturalHeight*scale);
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),d=pixels.data;
    for(let i=0;i<d.length;i+=4){
      const gray=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      const contrast=Math.max(0,Math.min(255,(gray-128)*1.32+128));
      d[i]=d[i+1]=d[i+2]=contrast;
    }
    ctx.putImageData(pixels,0,0);
    return {canvas,width:canvas.width,height:canvas.height};
  } finally {URL.revokeObjectURL(url);}
}
function buildDebugReport(data,parsed,width,height){
  const words=(data.words||[]).map(w=>({text:w.text,confidence:Number((w.confidence||0).toFixed(1)),
    x0:w.bbox?.x0,y0:w.bbox?.y0,x1:w.bbox?.x1,y1:w.bbox?.y1}));
  const lines=(data.lines||[]).map((l,i)=>({line:i+1,text:l.text,confidence:Number((l.confidence||0).toFixed(1)),box:l.bbox}));
  return {appVersion:"0.4.0",generatedAt:new Date().toISOString(),
    image:{width,height,originalName:state.image?.name||"immagine"},
    ocr:{text:data.text||"",wordCount:words.length,lineCount:lines.length,words,lines},
    table:{period:parsed.period,people:parsed.people,shiftCount:parsed.shifts.length,
      shifts:parsed.shifts.map(s=>({person:s.person,date:s.date,code:s.code,start:s.start,end:s.end,confidence:s.confidence,review:s.review})),
      warnings:parsed.warnings,parser:parsed.debug||{}}};
}
function renderDebug(){
  if(!state.debugReport)return;
  $("debugPanel").classList.remove("hidden");
  const d=state.debugReport;
  const wordDump=d.ocr.words.map(w=>`${w.text} [${w.confidence}%] x:${w.x0}-${w.x1} y:${w.y0}-${w.y1}`).join("\\n");
  $("debugText").textContent=`TURNISYNC DEBUG ${d.appVersion}
IMMAGINE: ${d.image.width}x${d.image.height} · ${d.image.originalName}
OCR: ${d.ocr.wordCount} parole · ${d.ocr.lineCount} righe

TESTO OCR GREZZO
${d.ocr.text}

RISULTATO PARSER
Periodo: ${d.table.period}
Persone: ${d.table.people.join(", ")||"(nessuna)"}
Turni: ${d.table.shiftCount}
Avvisi: ${d.table.warnings.join(" | ")||"(nessuno)"}

RIGHE OCR
${d.ocr.lines.map(l=>`${l.line}. ${l.text} [${l.confidence}%]`).join("\\n")}

PAROLE E COORDINATE
${wordDump}`;
}
$("copyDebug")?.addEventListener("click",async()=>{
  if(!state.debugReport)return;
  try{await navigator.clipboard.writeText(JSON.stringify(state.debugReport,null,2));$("copyDebug").textContent="Copiato ✓";}
  catch{$("debugText").textContent=JSON.stringify(state.debugReport,null,2);}
});
$("downloadDebug")?.addEventListener("click",()=>{
  if(!state.debugReport)return;
  const blob=new Blob([JSON.stringify(state.debugReport,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="turnisync-debug.json";document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
});

function normalize(s) {
  return String(s || "").toLocaleLowerCase("it").normalize("NFD")
    .replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
}
const MONTHS = {
  GENNAIO:1, GEN:1, FEBBRAIO:2, FEB:2, MARZO:3, MAR:3, APRILE:4, APR:4,
  MAGGIO:5, MAG:5, GIUGNO:6, GIU:6, LUGLIO:7, LUG:7, AGOSTO:8, AGO:8,
  SETTEMBRE:9, SET:9, OTTOBRE:10, OTT:10, NOVEMBRE:11, NOV:11,
  DICEMBRE:12, DIC:12
};
function monthFromWords(words) {
  // Cerca il mese esclusivamente nella colonna descrittiva: MAR della settimana è martedì, non marzo.
  for (const w of words.filter(w => w.cx < 180 && w.cy < 150)) {
    const key=normalize(w.text).toLocaleUpperCase("it").replace(/[^A-Z]/g,"");
    for (const [name,num] of Object.entries(MONTHS)) {
      const candidate=normalize(name).toLocaleUpperCase("it");
      if(key===candidate||(candidate.length>3&&key.startsWith(candidate.slice(0,3))))return num;
    }
  }
  return null;
}
function weekdayNumber(text) {
  const s=normalize(text).toLocaleUpperCase("it");
  if(s.startsWith("LUN"))return 1;if(s.startsWith("MAR"))return 2;
  if(s.startsWith("MER"))return 3;if(s.startsWith("GIO"))return 4;
  if(s.startsWith("VEN"))return 5;if(s.startsWith("SAB"))return 6;
  if(s.startsWith("DOM"))return 0;return null;
}
function inferMonthFromWeekdays(rows,headerRow,fit,year,imageH) {
  const observations=[];
  for(const row of rows.filter(r=>r.cy>headerRow.cy&&r.cy<headerRow.cy+imageH*.17)){
    for(const w of row.words){const wd=weekdayNumber(w.text);if(wd===null)continue;
      const day=Math.round((w.cx-fit.intercept)/fit.slope);if(day>=1&&day<=31)observations.push({day,wd});}
  }
  let best={month:null,score:0,matches:0};
  for(let m=0;m<12;m++){const valid=observations.filter(o=>o.day<=new Date(year,m+1,0).getDate());
    const matches=valid.filter(o=>new Date(year,m,o.day,12).getDay()===o.wd).length;
    const score=valid.length?matches/valid.length:0;
    if(matches>best.matches||(matches===best.matches&&score>best.score))best={month:m+1,score,matches};}
  return {...best,observations};
}
function groupRows(words, imageHeight) {
  const tolerance = Math.max(6, imageHeight * 0.028);
  const rows = [];
  for (const w of [...words].sort((a,b) => a.cy - b.cy || a.cx - b.cx)) {
    let row = rows.find(r => Math.abs(r.cy - w.cy) <= tolerance);
    if (!row) { row = { cy: w.cy, words: [] }; rows.push(row); }
    row.words.push(w);
    row.cy = row.words.reduce((sum, item) => sum + item.cy, 0) / row.words.length;
  }
  rows.forEach(r => r.words.sort((a,b) => a.cx - b.cx));
  return rows.sort((a,b) => a.cy - b.cy);
}
function linearFit(points) {
  const n = points.length;
  const sx = points.reduce((s,p)=>s+p.day,0), sy = points.reduce((s,p)=>s+p.x,0);
  const sxx = points.reduce((s,p)=>s+p.day*p.day,0), sxy = points.reduce((s,p)=>s+p.day*p.x,0);
  const den = n*sxx - sx*sx;
  if (!n || !den) return null;
  const slope = (n*sxy - sx*sy)/den;
  return { slope, intercept: (sy - slope*sx)/n };
}
async function parseShiftTable(data,imageW,imageH,sourceCanvas,worker,progress) {
  const words=(data.words||[]).filter(w=>w.text&&w.bbox).map(w=>({
    text:w.text.trim(),cx:(w.bbox.x0+w.bbox.x1)/2,cy:(w.bbox.y0+w.bbox.y1)/2,
    width:w.bbox.x1-w.bbox.x0,height:w.bbox.y1-w.bbox.y0,confidence:(w.confidence||0)/100
  }));
  const rows=groupRows(words.filter(w=>w.confidence>.08),imageH),warnings=[];
  const yearWord=words.find(w=>w.cy<imageH*.28&&/^20\d{2}$/.test(w.text)&&Number(w.text)<=2100);
  const year=yearWord?Number(yearWord.text):null;
  const dayRows=rows.map(row=>({row,candidates:row.words.filter(w=>w.cx>imageW*.10&&/^\d{1,2}$/.test(w.text)&&Number(w.text)>=1&&Number(w.text)<=31)})).filter(x=>x.candidates.length>=5);
  const header=dayRows.sort((a,b)=>b.candidates.length-a.candidates.length)[0];
  if(!header)return {people:[],shifts:[],warnings:["Non riconosco la riga dei giorni."],period:"non riconosciuto",debug:{rows:rows.length}};
  const fit=linearFit(header.candidates.map(w=>({day:Number(w.text),x:w.cx})));
  if(!fit||fit.slope<=0)return {people:[],shifts:[],warnings:["Spaziatura delle colonne non riconosciuta."],period:"non riconosciuto",debug:{headerTokens:header.candidates.map(w=>w.text)}};
  const columnWidth=fit.slope,leftBoundary=fit.intercept+columnWidth*.5;
  const personRows=rows.filter(r=>r.cy>header.row.cy+imageH*.055);
  const centers=personRows.map(r=>r.cy).sort((a,b)=>a-b);
  const gaps=centers.slice(1).map((v,i)=>v-centers[i]).filter(v=>v>imageH*.035&&v<imageH*.2).sort((a,b)=>a-b);
  const rowGap=gaps.length?gaps[Math.floor(gaps.length/2)]:imageH*.091;
  const cropHeight=Math.max(24,Math.round(rowGap*.78));
  const crop=(x,y,w,h)=>{
    const c=document.createElement("canvas");c.width=Math.max(1,Math.round(w));c.height=Math.max(1,Math.round(h));
    const sx=Math.max(0,Math.round(x)),sy=Math.max(0,Math.round(y));
    const sw=Math.max(1,Math.min(sourceCanvas.width-sx,Math.round(w))),sh=Math.max(1,Math.min(sourceCanvas.height-sy,Math.round(h)));
    c.getContext("2d").drawImage(sourceCanvas,sx,sy,sw,sh,0,0,c.width,c.height);return c;
  };
  let month=monthFromWords(words.filter(w=>w.cx<leftBoundary&&w.cy<imageH*.24));
  const weekdayInference=year?inferMonthFromWeekdays(rows,header.row,fit,year,imageH):{month:null,score:0,observations:[]};
  if(!month&&weekdayInference.month&&weekdayInference.score>=.75)month=weekdayInference.month;
  if(!year)warnings.push("Anno non riconosciuto nell'intestazione.");
  if(!month)warnings.push("Mese non riconosciuto con certezza: gli eventi non saranno esportabili.");
  const daysInMonth=month&&year?new Date(year,month,0).getDate():31;
  const people=[],shifts=[],cellDiagnostics=[];
  const candidates=personRows.filter(r=>r.words.some(w=>w.cx<leftBoundary&&/[A-Za-zÀ-ÿ]/.test(w.text)));
  let rowIndex=0;
  for(const row of candidates){
    rowIndex++;
    await worker.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÈÉÌÒÙàèéìòù' -"});
    const nr=await worker.recognize(crop(0,row.cy-cropHeight/2,Math.max(80,leftBoundary-8),cropHeight));
    let name=(nr.data.text||"").replace(/[|_\[\]{}]/g," ").replace(/\s+/g," ").trim();
    if(name.length<3||!/[A-Za-zÀ-ÿ]/.test(name))name=row.words.filter(w=>w.cx<leftBoundary&&/[A-Za-zÀ-ÿ]/.test(w.text)).map(w=>w.text).join(" ").trim();
    if(name.length<3)continue;
    if(people.some(p=>normalize(p)===normalize(name)))name+=` (${rowIndex})`;
    people.push(name);
    await worker.setParameters({tessedit_pageseg_mode:"10",tessedit_char_whitelist:"123RF"});
    for(let day=1;day<=daysInMonth;day++){
      const x=fit.intercept+day*columnWidth;
      const cr=await worker.recognize(crop(x-columnWidth*.39,row.cy-cropHeight*.43,columnWidth*.78,cropHeight*.86));
      const raw=(cr.data.text||"").toUpperCase().replace(/[^123RF]/g,"");
      const confidence=(cr.data.confidence||0)/100,match=raw.match(/[123]/),leave=/[RF]/.test(raw);
      if(match&&month&&year){
        const date=new Date(year,month-1,day,12),code=Number(match[0]),cfg=state.settings.codes[code];
        const start=dateAt(date,cfg.start),end=dateAt(date,cfg.end);if(end<=start)end.setDate(end.getDate()+1);
        shifts.push({id:crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random(),person:name,date:isoDate(date),code,start:isoLocal(start),end:isoLocal(end),confidence,review:confidence<.62||raw.length>1});
      }else if(!leave&&raw.length)warnings.push(`${name}, giorno ${day}: cella ambigua (${raw})`);
      cellDiagnostics.push({person:name,day,raw,confidence,kind:match?"shift":leave?"leave":raw?"ambiguous":"empty"});
    }
    if(progress)progress(.72+.25*(rowIndex/candidates.length),`Lettura celle: persona ${rowIndex}/${candidates.length}`);
  }
  const monthName=month?Object.keys(MONTHS).find(k=>MONTHS[k]===month&&k.length>3):null;
  if(!month||!year)warnings.push("Turni non esportabili finché mese e anno non sono confermati.");
  return {people:people.sort((a,b)=>a.localeCompare(b,"it")),shifts,warnings,period:month&&year?`${monthName||month}/${year}`:"non riconosciuto",
    debug:{headerTokens:header.candidates.map(w=>({text:w.text,x:Math.round(w.cx)})),columnWidth:Math.round(columnWidth),
      leftBoundary:Math.round(leftBoundary),rowGap:Math.round(rowGap),weekdayInference,cellCount:cellDiagnostics.length,cells:cellDiagnostics}};
}
function dateAt(date,time) {
  const [h,m] = time.split(":").map(Number);
  return new Date(date.getFullYear(),date.getMonth(),date.getDate(),h,m,0);
}
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function isoLocal(d) { return `${isoDate(d)}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function displayDate(s) {
  const [y,m,d] = s.split("-").map(Number);
  return new Date(y,m-1,d,12).toLocaleDateString("it-IT",{weekday:"short",day:"numeric",month:"short",year:"numeric"});
}

function renderPeople() {
  const el = $("peopleList");
  if (!state.people.length) { el.className="panel empty"; el.textContent="Prima carica e analizza uno screenshot."; return; }
  el.className="panel"; el.innerHTML="";
  state.people.forEach(p => {
    const row=document.createElement("div"); row.className="person-row";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=state.selected.has(p);
    cb.onchange=()=>{cb.checked?state.selected.add(p):state.selected.delete(p);renderShifts();$("savePreferred").disabled=!state.selected.size;};
    const label=document.createElement("label"); label.textContent=p;
    const small=document.createElement("small"); small.textContent=state.shifts.filter(s=>normalize(s.person)===normalize(p)).length+" turni";
    row.append(cb,label,small); el.append(row);
  });
  $("savePreferred").disabled=!state.selected.size;
}
$("savePreferred").onclick=()=>{
  const first=[...state.selected][0]||""; state.preferred=first; $("preferredName").value=first;
  localStorage.setItem("ts_preferred",first); $("homeMessage").textContent=first?`Preferito salvato: ${first}`:"Preferenza rimossa.";
};
function renderShifts() {
  const list=$("shiftList"), chosen=state.shifts.filter(s=>state.selected.has(s.person));
  $("countTotal").textContent=chosen.length; $("countReview").textContent=chosen.filter(s=>s.review).length;
  $("countPeople").textContent=state.selected.size; $("exportBtn").disabled=!chosen.length; list.innerHTML="";
  if (!chosen.length) { list.innerHTML='<div class="panel empty">Nessun turno per le persone selezionate.</div>'; return; }
  chosen.sort((a,b)=>a.start.localeCompare(b.start)).forEach(s=>{
    const card=document.createElement("article"); card.className="shift-card";
    const title=document.createElement("div"); title.className="shift-top";
    const strong=document.createElement("div"); strong.className="shift-title";
    strong.textContent=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[s.code];
    title.append(strong);
    if(s.review){const tag=document.createElement("span");tag.className="tag";tag.textContent="Verifica OCR";title.append(tag);}
    const meta=document.createElement("div");meta.className="shift-meta";meta.textContent=`${s.person} · ${displayDate(s.date)} · Codice ${s.code}`;
    const edit=document.createElement("div");edit.className="shift-edit";
    const code=document.createElement("select");
    [1,2,3].forEach(n=>{const o=document.createElement("option");o.value=n;o.textContent=`${n} · ${state.settings.codes[n].name}`;code.append(o);});code.value=s.code;
    const start=document.createElement("input");start.type="datetime-local";start.value=s.start;
    const end=document.createElement("input");end.type="datetime-local";end.value=s.end;
    const person=document.createElement("input");person.value=s.person;person.placeholder="Persona";
    edit.append(code,start,end,person);
    const actions=document.createElement("div");actions.className="shift-actions";
    const remove=document.createElement("button");remove.textContent="Rimuovi";remove.onclick=()=>{state.shifts=state.shifts.filter(x=>x.id!==s.id);renderShifts();};
    const save=document.createElement("button");save.textContent="Salva modifica";save.onclick=()=>{
      s.code=Number(code.value);s.start=start.value;s.end=end.value;s.person=person.value.trim()||s.person;s.review=false;renderShifts();
    };
    actions.append(remove,save);card.append(title,meta,edit,actions);list.append(card);
  });
}
function escapeICS(s){return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");}
function icsDate(s){return s.replace(/[-:]/g,"")+"00";}
$("exportBtn").onclick=()=>{
  const chosen=state.shifts.filter(s=>state.selected.has(s.person)); if(!chosen.length)return;
  if(chosen.some(s=>s.review)){alert("Ci sono turni da verificare. Correggi o conferma ogni turno prima dell'esportazione.");return;}
  const seen=new Set(),events=[];
  for(const s of chosen){
    const title=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[s.code];
    const key=[s.start,s.end,title].join("|");
    if(state.settings.duplicates&&seen.has(key))continue; seen.add(key);
    events.push(["BEGIN:VEVENT",`UID:${s.id}@turnisync.local`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"")}`,
      `DTSTART;TZID=Europe/Rome:${icsDate(s.start)}`,`DTEND;TZID=Europe/Rome:${icsDate(s.end)}`,
      `SUMMARY:${escapeICS(title)}`,`DESCRIPTION:${escapeICS("Persona: "+s.person+"\\nCodice turno: "+s.code)}`,"END:VEVENT"].join("\r\n"));
  }
  const calendar=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//TurniSync//IT","CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE","TZID:Europe/Rome","END:VTIMEZONE",...events,"END:VCALENDAR"].join("\r\n");
  const blob=new Blob([calendar],{type:"text/calendar;charset=utf-8"}),url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download="TurniSync-turni.ics";document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
  $("exportMessage").classList.remove("hidden");
  $("exportMessage").textContent=`Creato file calendario con ${events.length} eventi. Aprilo da File e importa gli eventi nel Calendario Apple.`;
};
function loadSettings(){
  $("preferredName").value=state.preferred;$("duplicateCheck").checked=state.settings.duplicates;
  for(let i=1;i<=3;i++){$("s"+i+"start").value=state.settings.codes[i].start;$("s"+i+"end").value=state.settings.codes[i].end;}
}
$("saveSettings").onclick=()=>{
  state.preferred=$("preferredName").value.trim();state.settings.duplicates=$("duplicateCheck").checked;
  for(let i=1;i<=3;i++){state.settings.codes[i].start=$("s"+i+"start").value;state.settings.codes[i].end=$("s"+i+"end").value;}
  localStorage.setItem("ts_preferred",state.preferred);localStorage.setItem("ts_settings",JSON.stringify(state.settings));
  $("homeMessage").textContent="Impostazioni salvate sul dispositivo.";
};
$("resetBtn").onclick=()=>{
  if(!confirm("Cancellare persone e turni della sessione?"))return;
  state.people=[];state.selected.clear();state.shifts=[];state.image=null;
  $("imagePreviewWrap").classList.add("hidden");$("imageInput").value="";$("analyzeBtn").disabled=true;
  renderPeople();renderShifts();
};
async function refreshApplication(){
  const btn=$("refreshAppBtn");if(btn){btn.disabled=true;btn.textContent="Aggiorno…";}
  try{
    if("serviceWorker" in navigator){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()));}
    if("caches" in window){const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith("turnisync-")).map(k=>caches.delete(k)));}
  }catch(err){console.warn("Aggiornamento cache:",err);}
  const url=new URL(location.href);url.searchParams.set("refresh",Date.now().toString());location.replace(url.toString());
}
$("refreshAppBtn")?.addEventListener("click",refreshApplication);
$("installHelpBtn")?.addEventListener("click",()=>alert("Per installare TurniSync su iPhone: apri questa pagina in Safari, tocca Condividi e scegli “Aggiungi alla schermata Home”."));
loadSettings();
if("serviceWorker" in navigator && location.protocol.startsWith("http"))
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
