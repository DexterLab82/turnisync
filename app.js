const APP_VERSION = "0.5.14";
const APP_BUILD = "2026-11-13";
const $ = (id) => document.getElementById(id);
const DEFAULT_SETTINGS = {
  codes:{1:{name:"Mattina",start:"06:00",end:"14:00"},2:{name:"Pomeriggio",start:"14:00",end:"22:00"},3:{name:"Notte",start:"22:00",end:"06:00"}},
  duplicates:true,calendarPreference:"auto",duplicateHistory:[]
};
function readLocal(key,fallback="") { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function writeLocal(key,value) { try { localStorage.setItem(key,value); return true; } catch { return false; } }
const savedPreferredSelection = (() => {
  try {
    const value = JSON.parse(readLocal("ts_preferred_selection", "[]"));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
})();
const legacyPreferred = readLocal("ts_preferred");
function detectDevice(){const ua=navigator.userAgent||"";if(/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1))return {label:"Apple / iOS",target:"apple"};if(/Android/i.test(ua))return {label:"Android",target:"google"};if(/Windows/i.test(ua))return {label:"Windows",target:"outlook"};if(/Macintosh|Mac OS X/i.test(ua))return {label:"macOS",target:"apple"};return {label:"Altro dispositivo",target:"ics"};}
const deviceInfo=detectDevice();
const storedSettings=(()=>{try{const value=JSON.parse(readLocal("ts_settings","null"));return value&&typeof value==="object"&&!Array.isArray(value)?value:{};}catch{return {};}})();
function normalizeSettings(saved) {
  const calendarPreference=["auto","apple","google","outlook"].includes(saved.calendarPreference)?saved.calendarPreference:"auto";
  const codes={};
  for(let i=1;i<=3;i++){
    const fallback=DEFAULT_SETTINGS.codes[i],candidate=saved.codes?.[i]||{};
    const validTime=value=>typeof value==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    codes[i]={name:fallback.name,start:validTime(candidate.start)?candidate.start:fallback.start,end:validTime(candidate.end)?candidate.end:fallback.end};
  }
  return {...DEFAULT_SETTINGS,...saved,codes,duplicates:typeof saved.duplicates==="boolean"?saved.duplicates:true,
    calendarPreference,duplicateHistory:Array.isArray(saved.duplicateHistory)?saved.duplicateHistory.filter(v=>typeof v==="string").slice(-2000):[]};
}
const state = {
  image: null, people: [], selected: new Set(), shifts: [], debugReport: null,
  preferred: legacyPreferred,
  preferredSelection: savedPreferredSelection.length ? savedPreferredSelection : (legacyPreferred ? [legacyPreferred] : []),
  settings: normalizeSettings(storedSettings)
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
  let worker=null;
  try {
    setProgress(.02, "Avvio riconoscimento locale…");
    worker = await Tesseract.createWorker("ita+eng", 1, {
      logger: m => {
        if (m.status === "recognizing text")
          setProgress(m.progress, `Lettura tabella: ${Math.round(m.progress * 100)}%`);
      }
    });
    const prepared = await prepareOCRImage(state.image);
    const result = await worker.recognize(prepared.canvas);
    setProgress(.72, "Separazione delle celle e verifica dei nominativi…");
    const parsed = await parseShiftTable(result.data, prepared.width, prepared.height, prepared.canvas, worker, setProgress);
    state.people = parsed.people;
    state.shifts = parsed.shifts;
    state.debugReport = buildDebugReport(result.data, parsed, prepared.width, prepared.height);
    renderDebug();
    state.selected = new Set(state.people.filter(p => state.preferredSelection.some(saved => normalize(p) === normalize(saved))));
    renderPeople(); renderShifts();
    $("homeMessage").textContent =
      `Tabella analizzata (${parsed.period}). ${parsed.people.length} persone, ${parsed.shifts.length} turni riconosciuti. ` +
      (parsed.warnings.length ? parsed.warnings.slice(0, 5).join(" · ") : "Controlla comunque tutte le righe prima dell'esportazione.");
    if (!parsed.shifts.length) $("homeMessage").textContent += " Non sono stati trovati codici 1/2/3 affidabili.";
  } catch (err) {
    $("homeMessage").textContent = "Errore OCR: " + err.message;
  } finally {
    if(worker)try{await worker.terminate();}catch(error){console.warn("Chiusura worker OCR:",error);}
    $("ocrProgress").classList.add("hidden");
    $("analyzeBtn").disabled = false;
  }
}


async function prepareOCRImage(file) {
  const image = new Image(), url = URL.createObjectURL(file);
  try {
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    const scale=Math.min(2.5,2200/image.naturalWidth,5000/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement("canvas");
    canvas.width=Math.round(image.naturalWidth*scale);
    canvas.height=Math.round(image.naturalHeight*scale);
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),d=pixels.data;
    for(let i=0;i<d.length;i+=4){
      const gray=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      // Keep faint table rules visible for grid detection while retaining dark text.
      const contrast=Math.max(0,Math.min(255,(gray-128)*1.05+128));
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
  return {appVersion:APP_VERSION,build:APP_BUILD,generatedAt:new Date().toISOString(),runtime:{url:location.href,serviceWorkerController:!!navigator.serviceWorker?.controller,serviceWorkerScript:"sw.js?v="+APP_VERSION,userAgent:navigator.userAgent},
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
  const wordDump=d.ocr.words.map(w=>`${w.text} [${w.confidence}%] x:${w.x0}-${w.x1} y:${w.y0}-${w.y1}`).join("\n");
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
${d.ocr.lines.map(l=>`${l.line}. ${l.text} [${l.confidence}%]`).join("\n")}

PAROLE E COORDINATE
${wordDump}`;
}
$("copyDebug")?.addEventListener("click",async()=>{
  if(!state.debugReport)return;
  try{await navigator.clipboard.writeText(JSON.stringify(state.debugReport,null,2));$("copyDebug").textContent="Copiato ✓";}
  catch{$("debugText").textContent=JSON.stringify(state.debugReport,null,2);}
});
$("downloadDebug")?.addEventListener("click",async()=>{
  if(!state.debugReport)return;
  const blob=new Blob([JSON.stringify(state.debugReport,null,2)],{type:"application/json"});
  try{await deliverFile(blob,"turnisync-debug.json");}
  catch(e){$("debugText").textContent="Download non riuscito: "+e.message;}
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
function detectGridLines(canvas) {
  const width=canvas.width,height=canvas.height,ctx=canvas.getContext("2d",{willReadFrequently:true});
  const pixels=ctx.getImageData(0,0,width,height).data;
  const collect=(counts,limit)=>{
    const found=[];
    for(let i=0;i<counts.length;i++)if(counts[i]>=limit)found.push(i);
    const groups=[];
    for(const n of found){
      if(!groups.length||n>groups[groups.length-1].last+1)groups.push({first:n,last:n});
      else groups[groups.length-1].last=n;
    }
    return groups.map(g=>Math.round((g.first+g.last)/2));
  };
  const thresholds=[105,165,220,250];
  let best=null;
  for(const threshold of thresholds){
    const vertical=new Uint32Array(width),horizontal=new Uint32Array(height);
    for(let y=0;y<height;y++){
      const row=y*width*4;let run=0,longest=0;
      for(let x=0;x<width;x++){
        const i=row+x*4,gray=(pixels[i]+pixels[i+1]+pixels[i+2])/3;
        if(gray<threshold){run++;if(run>longest)longest=run;}else run=0;
      }
      if(longest>=width*.5)horizontal[y]=longest;
    }
    for(let x=0;x<width;x++){
      let run=0,longest=0;
      for(let y=0;y<height;y++){
        const i=(y*width+x)*4,gray=(pixels[i]+pixels[i+1]+pixels[i+2])/3;
        if(gray<threshold){run++;if(run>longest)longest=run;}else run=0;
      }
      if(longest>=height*.5)vertical[x]=longest;
    }
    const xs=collect(vertical,height*.5),ys=collect(horizontal,width*.5);
    // Keep real borders close to the image edge; synthetic borders are only for cropped layouts.
    if(!xs.length||xs[0]>width*.03)xs.unshift(0);
    if(!ys.length||ys[0]>height*.03)ys.unshift(0);
    if(xs[xs.length-1]<width*.97)xs.push(width-1);
    if(ys[ys.length-1]<height*.97)ys.push(height-1);
    const days=xs.length-2,peopleRows=ys.length-3;
    const candidate={xLines:xs,yLines:ys,days,peopleRows,threshold};
    if(!best||Math.abs(days-30)+Math.max(0,1-peopleRows)<Math.abs(best.days-30)+Math.max(0,1-best.peopleRows))best=candidate;
    if(days>=28&&days<=31&&peopleRows>=1)return candidate;
  }
  return best||{xLines:[0,width-1],yLines:[0,height-1],days:0,peopleRows:0,threshold:null};
}
function cleanPersonName(value){
  let name=String(value||"").toLocaleUpperCase("it")
    .replace(/[^A-ZÀ-Ü' ]/g," ").replace(/\s+/g," ").trim();
  name=name.replace(/^[IL]\s+(?=[A-ZÀ-Ü]{4,})/,"");
  if(name==="MAINT ANDREA")name="MAINI ANDREA";
  return name;
}
function binaryNameCanvas(canvas){
  const ctx=canvas.getContext("2d",{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height),histogram=new Uint32Array(256);
  for(let i=0;i<image.data.length;i+=4)histogram[Math.round((image.data[i]+image.data[i+1]+image.data[i+2])/3)]++;
  const total=image.data.length/4;let sum=0;for(let i=0;i<256;i++)sum+=i*histogram[i];
  let background=0,backgroundWeight=0,bestVariance=-1,threshold=170;
  for(let i=0;i<256;i++){
    backgroundWeight+=histogram[i];if(!backgroundWeight)continue;
    const foregroundWeight=total-backgroundWeight;if(!foregroundWeight)break;
    background+=i*histogram[i];
    const meanBackground=background/backgroundWeight,meanForeground=(sum-background)/foregroundWeight;
    const variance=backgroundWeight*foregroundWeight*(meanBackground-meanForeground)**2;
    if(variance>bestVariance){bestVariance=variance;threshold=i;}
  }
  for(let i=0;i<image.data.length;i+=4){const gray=(image.data[i]+image.data[i+1]+image.data[i+2])/3,v=gray<=threshold?0:255;image.data[i]=image.data[i+1]=image.data[i+2]=v;}
  ctx.putImageData(image,0,0);return canvas;
}
async function parseShiftTable(data,imageW,imageH,sourceCanvas,worker,progress) {
  const warnings=[],grid=detectGridLines(sourceCanvas),cellDiagnostics=[];
  const x=grid.xLines,y=grid.yLines;
  if(grid.days<28||grid.days>31||grid.peopleRows<1||x.length<31||y.length<4){
    return {people:[],shifts:[],warnings:["Griglia non rilevata con sufficiente precisione: controlla che lo screenshot mostri tutta la tabella."],
      period:"non riconosciuto",debug:{grid:{xLines:x,yLines:y,days:grid.days,peopleRows:grid.peopleRows,threshold:grid.threshold}}};
  }
  const crop=(left,top,right,bottom,scale=1)=>{
    const sx=Math.max(0,Math.round(left)),sy=Math.max(0,Math.round(top));
    const sw=Math.max(1,Math.min(sourceCanvas.width-sx,Math.round(right)-sx));
    const sh=Math.max(1,Math.min(sourceCanvas.height-sy,Math.round(bottom)-sy));
    const c=document.createElement("canvas");c.width=Math.max(1,Math.round(sw*scale));c.height=Math.max(1,Math.round(sh*scale));
    c.getContext("2d").drawImage(sourceCanvas,sx,sy,sw,sh,0,0,c.width,c.height);
    return c;
  };
  const monthCell=crop(x[0]+8,y[0]+3,x[1]-8,y[1]-3,3);
  await worker.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ"});
  const monthResult=await worker.recognize(monthCell);
  const monthRaw=(monthResult.data.text||"").trim();
  const monthKey=normalize(monthRaw).toLocaleUpperCase("it");
  const monthNames={GENNAIO:1,FEBBRAIO:2,MARZO:3,APRILE:4,MAGGIO:5,GIUGNO:6,LUGLIO:7,AGOSTO:8,SETTEMBRE:9,OTTOBRE:10,NOVEMBRE:11,DICEMBRE:12};
  let month=monthNames[monthKey]||null;
  let monthSource=month?"cella intestazione":null;
  const yearCell=crop(x[0]+8,y[1]+3,x[1]-8,y[2]-3,3);
  await worker.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:"0123456789"});
  const yearResult=await worker.recognize(yearCell);
  const yearRaw=(yearResult.data.text||"").trim();
  const yearMatch=(yearRaw+" "+(data.text||"")).match(/20\d{2}/);
  const year=yearMatch?Number(yearMatch[0]):null;
  const weekdayChecks=[];
  if(year){
    await worker.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ"});
    for(const day of [1,2,3,7,14,21,28].filter(day=>day<=grid.days)){
      const left=x[day],right=x[day+1],top=y[1],bottom=y[2];
      const result=await worker.recognize(crop(left+8,top+3,right-8,bottom-3,2));
      const raw=(result.data.text||"").trim().toUpperCase();
      weekdayChecks.push({day,raw,observed:weekdayNumber(raw)});
    }
  }
  let weekdayConflict=false;
  if(!month&&year){
    const checked=weekdayChecks.filter(v=>v.observed!==null);
    const candidates=[];
    for(let m=1;m<=12;m++){
      if(new Date(year,m,0).getDate()!==grid.days)continue;
      const matches=checked.filter(v=>new Date(year,m-1,v.day,12).getDay()===v.observed).length;
      candidates.push({month:m,matches});
    }
    candidates.sort((a,b)=>b.matches-a.matches);
    const best=candidates[0],second=candidates[1];
    if(best&&checked.length>=3&&best.matches>=3&&(!second||best.matches-second.matches>=2)){
      month=best.month;monthSource="giorni della settimana";
    }else if(best&&checked.length>=3&&second&&best.matches===second.matches){
      const distance=(a,b)=>{const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let diagonal=prev[0];prev[0]=i;for(let j=1;j<=b.length;j++){const old=prev[j];prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=old;}}return prev[b.length];};
      const tied=candidates.filter(v=>v.matches===best.matches).map(v=>({month:v.month,score:distance(normalize(monthRaw),normalize(Object.keys(monthNames).find(k=>monthNames[k]===v.month)||""))})).sort((a,b)=>a.score-b.score);
      if(tied.length&&tied[0].score<=4&&(!tied[1]||tied[1].score-tied[0].score>=2)){
        month=tied[0].month;monthSource="giorni della settimana e intestazione";
      }
    }
  }
  if(month&&year){
    weekdayChecks.forEach(v=>{v.expected=new Date(year,month-1,v.day,12).getDay();v.match=v.observed===null?null:v.observed===v.expected;});
    const checked=weekdayChecks.filter(v=>v.match!==null);
    if(monthSource==="cella intestazione"&&checked.length>=3&&checked.filter(v=>!v.match).length>=2){
      weekdayConflict=true;
      warnings.push("I giorni della settimana non corrispondono al mese rilevato: controlla la tabella.");
    }
  }
  if(!month)warnings.push("Mese non riconosciuto: la tabella deve mostrare il mese oppure i giorni della settimana.");
  if(!year)warnings.push("Anno non riconosciuto nell’intestazione o nel testo OCR.");
  const daysInMonth=month&&year?new Date(year,month,0).getDate():null;
  if(daysInMonth&&daysInMonth!==grid.days)warnings.push("Il numero di colonne ("+grid.days+") non coincide con i giorni del mese ("+daysInMonth+").");
  const people=[],nameDiagnostics=[];
  const extraHeader=(data.lines||[]).some(line=>{
    const cy=((line.bbox?.y0||0)+(line.bbox?.y1||0))/2;
    return cy>=y[2]&&cy<y[3]&&/\b(DIA|GIORNO|NOMINATIVI)\b/i.test(line.text||"");
  });
  const firstNameRow=extraHeader?3:2,nameRows=Math.max(0,y.length-firstNameRow-1);
  const nameWhitelist="ABCDEFGHIJKLMNOPQRSTUVWXYZÀÈÉÌÒÙ'’- ";
  const isName=value=>{const letters=value.replace(/[^A-ZÀ-Ü]/g,"");return letters.length>=4&&/[A-ZÀ-Ü]{3,}/.test(value);};
  const fallbackName=(top,bottom)=>{
    const tokens=(data.words||[]).filter(word=>{
      const box=word.bbox||{},cx=((box.x0||0)+(box.x1||0))/2,cy=((box.y0||0)+(box.y1||0))/2;
      return cx>=x[0]&&cx<x[1]-8&&cy>=top&&cy<bottom&&/[A-ZÀ-Ü]{2,}/i.test(word.text||"");
    }).sort((a,b)=>(a.bbox?.x0||0)-(b.bbox?.x0||0));
    const value=cleanPersonName(tokens.map(token=>token.text).join(" "));
    return {name:value,confidence:tokens.length?tokens.reduce((sum,token)=>sum+(token.confidence||0),0)/tokens.length:0,source:"OCR completo"};
  };
  for(let row=0;row<nameRows;row++){
    const gridRow=row+firstNameRow,top=y[gridRow],bottom=y[gridRow+1],left=x[0],right=x[1];
    const cell=crop(left+5,top+1,right-5,bottom-1,4),binary=binaryNameCanvas(crop(left+5,top+1,right-5,bottom-1,5));
    const attempts=[];
    await worker.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:nameWhitelist});
    let result=await worker.recognize(cell),name=cleanPersonName(result.data.text),confidence=result.data.confidence||0;
    attempts.push({psm:7,raw:result.data.text||"",confidence:Number(confidence.toFixed(1))});
    let selected={name,confidence,source:"cella PSM 7"};
    if(!isName(name)||confidence<68||!name.includes(" ")){
      await worker.setParameters({tessedit_pageseg_mode:"13",tessedit_char_whitelist:nameWhitelist});
      result=await worker.recognize(binary);name=cleanPersonName(result.data.text);confidence=result.data.confidence||0;
      attempts.push({psm:13,raw:result.data.text||"",confidence:Number(confidence.toFixed(1))});
      if(isName(name)&&(confidence>selected.confidence||!isName(selected.name)))selected={name,confidence,source:"cella binarizzata PSM 13"};
    }
    if(!isName(selected.name)||selected.confidence<45){
      await worker.setParameters({tessedit_pageseg_mode:"6",tessedit_char_whitelist:nameWhitelist});
      result=await worker.recognize(cell);name=cleanPersonName(result.data.text);confidence=result.data.confidence||0;
      attempts.push({psm:6,raw:result.data.text||"",confidence:Number(confidence.toFixed(1))});
      if(isName(name)&&(confidence>selected.confidence||!isName(selected.name)))selected={name,confidence,source:"cella PSM 6"};
    }
    const global=fallbackName(top,bottom);
    if(isName(global.name)&&(!isName(selected.name)||global.confidence>selected.confidence+5))selected=global;
    else if(isName(global.name)&&isName(selected.name)&&normalize(global.name)===normalize(selected.name))selected.confidence=Math.max(selected.confidence,global.confidence);
    const accepted=isName(selected.name);
    nameDiagnostics.push({row:gridRow,name:accepted?selected.name:"",confidence:Number((selected.confidence||0).toFixed(1)),source:selected.source,attempts,globalCandidate:global.name||""});
    if(accepted)people.push({name:selected.name,row:gridRow,confidence:(selected.confidence||0)/100});
  }
  const calendarValid=!!month&&!!year&&daysInMonth===grid.days&&people.length>0;
  if(!people.length)warnings.push("Nessun nominativo riconosciuto nella prima colonna: controlla che la tabella sia completa e leggibile.");
  else if(people.length<nameRows)warnings.push("Riconosciuti "+people.length+" nominativi su "+nameRows+" righe: alcune righe sono state saltate. Controlla la tabella prima dell’esportazione.");
  if(!month||!year||daysInMonth!==grid.days)warnings.push("Turni non esportabili finché intestazione e numero di giorni non sono coerenti.");
  const shifts=[];
  if(calendarValid&&!weekdayConflict){
    // Ripristina esplicitamente l’alfabeto dei turni: i parametri OCR precedenti
    // (nomi e giorni della settimana) restano attivi sul worker se non sovrascritti.
    await worker.setParameters({tessedit_pageseg_mode:"10",tessedit_char_whitelist:"123RF"});
    for(let p=0;p<people.length;p++){
      const person=people[p],row=person.row,top=y[row],bottom=y[row+1];
      for(let day=1;day<=grid.days;day++){
        const left=x[day],right=x[day+1],cellTop=top,cellBottom=bottom;
        const cw=right-left,ch=cellBottom-cellTop;
        const cell= crop(left+cw*.16,cellTop+ch*.13,right-cw*.16,cellBottom-ch*.13,2);
        const result=await worker.recognize(cell);
        const rawText=(result.data.text||"").toUpperCase().trim();
        const raw=rawText.replace(/[^123RF]/g,"");
        const suspicious=rawText.replace(/[\s|.,]/g,"").length!==raw.length;
        const confidence=(result.data.confidence||0)/100;
        const codes=raw.match(/[123]/g)||[],hasLeave=/[RF]/.test(raw);
        if(codes.length&&!hasLeave){
          const code=Number(codes[0]),date=new Date(year,month-1,day,12),cfg=state.settings.codes[code];
          const start=dateAt(date,cfg.start),end=dateAt(date,cfg.end);
          if(end<=start)end.setDate(end.getDate()+1);
          shifts.push({id:crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random(),person:person.name,date:isoDate(date),
            code,start:isoLocal(start),end:isoLocal(end),confidence,review:confidence<.70||raw.length!==1||suspicious});
        }else if(codes.length&&hasLeave){
          warnings.push(person.name+", giorno "+day+": cella ambigua ("+raw+").");
        }else if(raw&&!hasLeave){
          warnings.push(person.name+", giorno "+day+": codice non riconosciuto ("+raw+").");
        }
        cellDiagnostics.push({person:person.name,day,raw,confidence,kind:codes.length&&!hasLeave?"shift":hasLeave?"leave":raw?"ambiguous":"empty"});
      }
      if(progress)progress(.72+.25*((p+1)/people.length),"Lettura celle: persona "+(p+1)+"/"+people.length);
    }
  }
  const monthName=Object.keys(monthNames).find(k=>monthNames[k]===month);
  return {people:people.map(p=>p.name).sort((a,b)=>a.localeCompare(b,"it")),shifts,warnings,
    period:month&&year?(monthName+"/"+year):"non riconosciuto",
    debug:{method:"grid-lines-adaptive",monthRaw,monthSource,monthConfidence:monthResult.data.confidence,yearRaw,yearConfidence:yearResult.data.confidence,
      grid:{xLines:x,yLines:y,days:grid.days,peopleRows:nameRows,threshold:grid.threshold,extraHeader},weekdayChecks,
      names:people.map(p=>({name:p.name,row:p.row,confidence:p.confidence})),nameDiagnostics,cellCount:cellDiagnostics.length,cells:cellDiagnostics}};
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
    cb.onchange=()=>{
      cb.checked?state.selected.add(p):state.selected.delete(p);
      renderShifts();
      $("savePreferred").disabled=!state.selected.size;
      $("savePreferred").textContent="Salva selezione come preferita";
      $("preferredFeedback").textContent="Selezione modificata: premi Salva per memorizzarla.";
      $("preferredFeedback").classList.remove("hidden");
    };
    const label=document.createElement("label"); label.textContent=p;
    const small=document.createElement("small"); small.textContent=state.shifts.filter(s=>normalize(s.person)===normalize(p)).length+" turni";
    row.append(cb,label,small); el.append(row);
  });
  $("savePreferred").disabled=!state.selected.size;
}
$("savePreferred").type="button";
$("savePreferred").onclick=()=>{
  const selected=[...state.selected];
  try {
    state.preferredSelection=selected;
    state.preferred=selected[0]||"";
    localStorage.setItem("ts_preferred_selection",JSON.stringify(selected));
    localStorage.setItem("ts_preferred",state.preferred);
    $("preferredName").value=state.preferred;
    $("preferredFeedback").textContent=selected.length
      ? "Selezione preferita salvata su questo iPhone: "+selected.join(", ")
      : "Preferiti rimossi.";
    $("preferredFeedback").classList.remove("hidden");
    $("savePreferred").textContent="Preferiti salvati ✓";
    $("homeMessage").textContent=selected.length
      ? "Preferiti salvati: "+selected.join(", ")
      : "Preferiti rimossi.";
  } catch(err) {
    $("preferredFeedback").textContent="Impossibile salvare la preferenza nel browser: "+err.message;
    $("preferredFeedback").classList.remove("hidden");
  }
};
function renderShifts() {
  const list=$("shiftList"), chosen=state.shifts.filter(s=>state.selected.has(s.person));
  $("countTotal").textContent=chosen.length; $("countReview").textContent=chosen.filter(s=>s.review).length;
  $("countPeople").textContent=state.selected.size; $("exportBtn").disabled=!chosen.length||chosen.some(s=>s.review); list.innerHTML="";
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
    code.onchange=()=>{
      const nextCode=Number(code.value),cfg=state.settings.codes[nextCode],d=new Date(s.date+"T12:00:00");
      const [sh,sm]=cfg.start.split(":").map(Number),[eh,em]=cfg.end.split(":").map(Number);
      const st=new Date(d.getFullYear(),d.getMonth(),d.getDate(),sh,sm),en=new Date(d.getFullYear(),d.getMonth(),d.getDate(),eh,em);
      if(en<=st)en.setDate(en.getDate()+1);
      start.value=isoLocal(st);end.value=isoLocal(en);
      // Applica subito codice e orari al turno, così l'esportazione non conserva l'intervallo precedente.
      s.code=nextCode;s.start=start.value;s.end=end.value;s.review=false;
      strong.textContent=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[nextCode];
      title.querySelector(".tag")?.remove();
      const selectedShifts=state.shifts.filter(shift=>state.selected.has(shift.person));
      $("countReview").textContent=selectedShifts.filter(shift=>shift.review).length;
      $("exportBtn").disabled=!selectedShifts.length||selectedShifts.some(shift=>shift.review);
    };
    const save=document.createElement("button");save.textContent="Salva modifica";save.onclick=()=>{
      const oldPerson=s.person,newPerson=person.value.trim()||oldPerson;
      const startDate=new Date(start.value),endDate=new Date(end.value);
      if(!start.value||!end.value||Number.isNaN(startDate.getTime())||Number.isNaN(endDate.getTime())||endDate<=startDate){alert("Intervallo orario non valido: la fine deve essere successiva all'inizio.");return;}
      const wasSelected=state.selected.has(oldPerson);
      s.code=Number(code.value);s.start=start.value;s.end=end.value;s.person=newPerson;s.review=false;
      if(wasSelected&&newPerson!==oldPerson){state.selected.delete(oldPerson);state.selected.add(newPerson);}
      renderShifts();renderPeople();
    };
    actions.append(remove,save);card.append(title,meta,edit,actions);list.append(card);
  });
}
function shiftFingerprint(s){return [normalize(s.person),s.start,s.end].join("|");}
function stableUid(value){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);}
function selectedCalendarTarget(preference=$("calendarPreference")?.value||state.settings.calendarPreference||"auto"){
 const target=preference==="auto"?deviceInfo.target:preference;
 return ["apple","google","outlook"].includes(target)?target:"ics";
}
function renderDeviceInfo(){
 const savedTarget=selectedCalendarTarget(state.settings.calendarPreference),draftTarget=selectedCalendarTarget(),label={apple:"Apple Calendar",google:"Google Calendar",outlook:"Microsoft Outlook",ics:"calendario compatibile"}[savedTarget];
 const el=$("deviceInfo");if(el)el.textContent="Dispositivo rilevato: "+deviceInfo.label+". Destinazione attiva: "+label+".";
 const format=$("calendarFormatHint");
 if(format)format.textContent=draftTarget!==savedTarget
   ?"Hai selezionato "+({apple:"Apple Calendar · .ics",google:"Google Calendar · CSV",outlook:"Outlook · .ics",ics:"calendario compatibile · .ics"}[draftTarget])+". Salva le impostazioni per applicare il nuovo formato."
   :savedTarget==="google"
     ?"Formato attivo: CSV per Google Calendar. Google importa i CSV da calendar.google.com su computer; il file può essere creato anche dal telefono e trasferito."
     :"Formato attivo: file iCalendar (.ics), compatibile con "+label+".";
 const guide=$("exportGuide");
 if(guide)guide.textContent=savedTarget==="google"
   ?"Verrà creato un CSV per Google Calendar. Per importarlo: da computer apri calendar.google.com → Impostazioni → Importa ed esporta, scegli il file e il calendario di destinazione."
   :savedTarget==="apple"
     ?"Verrà creato un file .ics per Apple Calendar. Su iPhone apri il file scaricato da File e scegli di aggiungere gli eventi al Calendario."
     :savedTarget==="outlook"
       ?"Verrà creato un file .ics per Outlook. In Outlook scegli Aggiungi calendario → Carica da file e seleziona il calendario di destinazione."
       :"Verrà creato un file .ics compatibile con i calendari che supportano iCalendar.";
}
function escapeCSV(value){return '"'+String(value??"").replace(/"/g,'""')+'"';}
function csvDate(value){const [date]=value.split("T"),[year,month,day]=date.split("-");return month+"/"+day+"/"+year;}
function csvTime(value){const [,time]=value.split("T"),[hour,minute]=time.split(":").map(Number);return (hour%12||12)+":"+String(minute).padStart(2,"0")+" "+(hour<12?"AM":"PM");}
function googleCalendarCSV(events){
 const rows=[["Subject","Start Date","Start Time","End Date","End Time","All Day Event","Description","Location","Private"]];
 for(const event of events)rows.push([
   event.title,csvDate(event.start),csvTime(event.start),csvDate(event.end),csvTime(event.end),"False",
   "Persona: "+event.person+" | Codice turno: "+event.code,"","False"
 ]);
 return "\uFEFF"+rows.map(row=>row.map(escapeCSV).join(",")).join("\r\n")+"\r\n";
}
function escapeICS(s){return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n");}
function icsDate(s){return s.replace(/[-:]/g,"")+"00";}
async function deliverFile(blob,filename,target){
  // Flusso verificato su iPhone: download diretto del file .ics, poi apertura da File.
  // Evita navigator.share, che su iOS non propone sempre l'azione "Aggiungi al Calendario".
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;a.style.display="none";
  document.body.append(a);a.click();a.remove();
  // Mantieni il Blob URL disponibile più a lungo per Safari/iOS.
  setTimeout(()=>URL.revokeObjectURL(url),600000);
  if(target==="apple"){
   return "Download avviato: "+filename+". Su iPhone apri File → Sfoglia → Download, tocca il file e premi “Aggiungi tutto”, quindi scegli il calendario.";
  }
  if(target==="google")return "Download avviato: "+filename+". Per importarlo in Google Calendar usa calendar.google.com da computer → Impostazioni → Importa ed esporta.";
  if(target==="outlook")return "Download avviato: "+filename+". In Outlook scegli Aggiungi calendario → Carica da file e seleziona il calendario.";
  return "Download avviato: "+filename+". Apri il file scaricato per importare gli eventi nel calendario.";
}
$("exportBtn").onclick=async()=>{
 const chosen=state.shifts.filter(s=>state.selected.has(s.person));if(!chosen.length)return;
 if(chosen.some(s=>s.review)){alert("Ci sono turni da verificare prima dell'esportazione.");return;}
 const target=selectedCalendarTarget(state.settings.calendarPreference),seen=new Set(),events=[],exportedKeys=[];
 const alreadyExported=new Set(state.settings.duplicateHistory);
 for(const s of chosen){
  const title=({1:"Turno Mattina",2:"Turno Pomeriggio",3:"Turno Notte"})[s.code];
  const key=shiftFingerprint(s);
  if(state.settings.duplicates&&(seen.has(key)||alreadyExported.has(key)))continue;seen.add(key);exportedKeys.push(key);
  const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  events.push({uid:stableUid(normalize(s.person)+"|"+s.date+"|"+s.code)+"@turnisync.local",stamp,
   start:s.start,end:s.end,title:title+" · "+s.person,person:s.person,code:s.code});
 }
 if(!events.length){$("exportMessage").classList.remove("hidden");$("exportMessage").textContent="Nessun turno da esportare.";return;}
 const isGoogle=target==="google",filename=isGoogle?"TurniSync-GoogleCalendar.csv":target==="outlook"?"TurniSync-Outlook.ics":target==="apple"?"TurniSync-AppleCalendar.ics":"TurniSync-turni.ics";
 const content=isGoogle?googleCalendarCSV(events):[
  "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//TurniSync//IT","CALSCALE:GREGORIAN","METHOD:PUBLISH",
  ...events.map(event=>["BEGIN:VEVENT","UID:"+event.uid,"DTSTAMP:"+event.stamp,
   "DTSTART:"+icsDate(event.start),"DTEND:"+icsDate(event.end),
   "SUMMARY:"+escapeICS(event.title),
   "DESCRIPTION:"+escapeICS("Persona: "+event.person+"\nCodice turno: "+event.code),"END:VEVENT"].join("\r\n")),
  "END:VCALENDAR",""
 ].join("\r\n");
 const blob=new Blob([content],{type:isGoogle?"text/csv;charset=utf-8":"text/calendar;charset=utf-8"});
 $("exportMessage").classList.remove("hidden");$("exportMessage").textContent="Preparazione calendario…";
 try{
  let message=await deliverFile(blob,filename,target);
  if(state.settings.duplicates){
    state.settings.duplicateHistory=[...new Set([...state.settings.duplicateHistory,...exportedKeys])].slice(-2000);
    if(!writeLocal("ts_settings",JSON.stringify(state.settings)))message+=" Nota: impossibile salvare lo storico duplicati su questo browser.";
  }
  $("exportMessage").textContent=message+" Eventi: "+events.length+".";
 }
 catch(e){$("exportMessage").textContent="Esportazione non riuscita: "+e.message;}
};
function loadSettings(){
  state.settings=normalizeSettings(state.settings);
  $("preferredName").value=state.preferred;$("duplicateCheck").checked=state.settings.duplicates;$("calendarPreference").value=state.settings.calendarPreference||"auto";renderDeviceInfo();
  for(let i=1;i<=3;i++){$("s"+i+"start").value=state.settings.codes[i].start;$("s"+i+"end").value=state.settings.codes[i].end;}
}
$("saveSettings").onclick=()=>{
  state.preferred=$("preferredName").value.trim();
  state.preferredSelection=state.preferred?[state.preferred]:[];
  writeLocal("ts_preferred",state.preferred);
  writeLocal("ts_preferred_selection",JSON.stringify(state.preferredSelection));
  state.settings.duplicates=$("duplicateCheck").checked;state.settings.calendarPreference=$("calendarPreference").value;
  for(let i=1;i<=3;i++){state.settings.codes[i].start=$("s"+i+"start").value;state.settings.codes[i].end=$("s"+i+"end").value;}
  if(!writeLocal("ts_settings",JSON.stringify(state.settings))){
    $("homeMessage").textContent="Impostazioni usate per questa sessione, ma il browser non ha consentito di salvarle.";return;
  }
  renderDeviceInfo();
  $("homeMessage").textContent="Impostazioni salvate solo in questo browser/dispositivo.";
};
 $("calendarPreference").addEventListener("change",renderDeviceInfo);
$("resetBtn").onclick=()=>{
  if(!confirm("Cancellare persone e turni della sessione?"))return;
  state.people=[];state.selected.clear();state.shifts=[];state.image=null;
  $("imagePreviewWrap").classList.add("hidden");$("imageInput").value="";$("analyzeBtn").disabled=true;
  renderPeople();renderShifts();
};
async function refreshApplication(){
  const btn=$("refreshAppBtn"),message=$("homeMessage");
  if(btn){btn.disabled=true;btn.textContent="Verifico aggiornamenti…";}
  try{
    if("serviceWorker" in navigator){
      const reg=await navigator.serviceWorker.getRegistration(location.href);
      if(reg){await reg.update();await reg.unregister();}
    }
    if("caches" in window){
      const keys=await caches.keys();
      await Promise.all(keys.filter(k=>k.startsWith("turnisync-")).map(k=>caches.delete(k)));
    }
    const url=new URL(location.href);
    url.searchParams.set("refresh",APP_VERSION+"-"+Date.now());
    url.hash="";
    location.replace(url.toString());
  }catch(err){
    console.error("Aggiornamento TurniSync:",err);
    if(message)message.textContent="Aggiornamento non riuscito: "+err.message+". Chiudi e riapri TurniSync.";
    if(btn){btn.disabled=false;btn.textContent="↻ Riprova aggiornamento";}
  }
}
$("refreshAppBtn")?.addEventListener("click",refreshApplication);
let deferredInstallPrompt=null;
window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();deferredInstallPrompt=event;});
function isInstalledPWA(){return window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;}
function setupInstallButton(){
 const btn=$("installHelpBtn"),status=$("installStatus");if(!btn)return;
 if(isInstalledPWA()){btn.textContent="TurniSync già installato ✓";btn.disabled=true;if(status)status.textContent="L'app è già disponibile dalla schermata Home.";return;}
 const ua=navigator.userAgent||"",ios=/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
 const safari=/Safari/i.test(ua)&&!/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);
 if(ios){btn.textContent="＋ Installa TurniSync";if(status)status.textContent=safari?"Aggiungi l'icona alla Home in pochi passaggi.":"Per installare, apri questa pagina in Safari.";return;}
 if(deferredInstallPrompt){btn.textContent="＋ Installa TurniSync";if(status)status.textContent="Installa l'app sul dispositivo.";return;}
 btn.textContent="＋ Come installare TurniSync";if(status)status.textContent="Aggiungi TurniSync alla schermata Home dal menu del browser.";
}
$("installHelpBtn")?.addEventListener("click",async()=>{
 if(isInstalledPWA()){setupInstallButton();return;}
 const ua=navigator.userAgent||"",ios=/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
 const safari=/Safari/i.test(ua)&&!/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);
 if(ios){
  const msg=safari?"1. Tocca Condividi (il quadrato con la freccia in basso o in alto).\n2. Scorri e seleziona “Aggiungi alla schermata Home”.\n3. Conferma con “Aggiungi”.\n\nL'icona TurniSync comparirà sulla Home.":"Apri il menu del browser e scegli “Apri in Safari”. Poi in Safari: Condividi → Aggiungi alla schermata Home → Aggiungi.";
  if($("installStatus"))$("installStatus").textContent=msg.replace(/\n/g," ");
  alert("Installazione TurniSync su iPhone\n\n"+msg);
 }else if(deferredInstallPrompt){
  deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;setupInstallButton();
 }else{
  alert("Apri il menu del browser e scegli “Installa app” oppure “Aggiungi alla schermata Home”.");
 }
});
setupInstallButton();
loadSettings();
if("serviceWorker" in navigator && location.protocol.startsWith("http"))
  window.addEventListener("load",async()=>{try{const reg=await navigator.serviceWorker.register("./sw.js?v="+APP_VERSION,{updateViaCache:"none"});await reg.update();}catch(err){console.warn("Service worker update:",err);}});

