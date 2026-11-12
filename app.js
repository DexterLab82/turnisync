const $ = (id) => document.getElementById(id);
const state = {
  image: null, people: [], selected: new Set(), shifts: [],
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
    const result = await worker.recognize(state.image);
    await worker.terminate();
    setProgress(1, "Ricostruzione righe e colonne…");
    const bitmap = await createImageBitmap(state.image);
    const parsed = parseShiftTable(result.data, bitmap.width, bitmap.height);
    bitmap.close();
    state.people = parsed.people;
    state.shifts = parsed.shifts;
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
  for (const w of words) {
    const key = normalize(w.text).toLocaleUpperCase("it");
    for (const [name, num] of Object.entries(MONTHS)) {
      if (key === normalize(name).toLocaleUpperCase("it") || key.startsWith(normalize(name).toLocaleUpperCase("it"))) return num;
    }
  }
  return null;
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
function parseShiftTable(data, imageW, imageH) {
  const words = (data.words || []).filter(w => w.text && w.confidence > 18).map(w => ({
    text: w.text.trim(), cx: (w.bbox.x0+w.bbox.x1)/2, cy: (w.bbox.y0+w.bbox.y1)/2,
    width: w.bbox.x1-w.bbox.x0, height: w.bbox.y1-w.bbox.y0, confidence: w.confidence/100
  }));
  const rows = groupRows(words, imageH);
  const warnings = [];

  // In questa tabella il mese e l'anno sono nell'angolo alto sinistro;
  // la prima riga contiene i numeri dei giorni (1..31), la seconda i weekday.
  const month = monthFromWords(words.filter(w => w.cy < imageH * .22));
  const yearWord = words.find(w => w.cy < imageH * .28 && /^\d{4}$/.test(w.text) && Number(w.text) >= 2020 && Number(w.text) <= 2100);
  const year = yearWord ? Number(yearWord.text) : null;

  const dayRows = rows.map(row => {
    const candidates = row.words.filter(w => w.cx > imageW*.10 && /^\d{1,2}$/.test(w.text) &&
      Number(w.text) >= 1 && Number(w.text) <= 31);
    return { row, candidates };
  }).filter(x => x.candidates.length >= 5);
  const header = dayRows.sort((a,b) => b.candidates.length-a.candidates.length)[0];

  if (!month || !year) {
    warnings.push("Mese o anno non riconosciuti nell'intestazione: controllare lo screenshot.");
  }
  if (!header) {
    warnings.push("Non riconosco la riga superiore con i numeri dei giorni.");
    return { people: [], shifts: [], warnings, period: "non riconosciuto" };
  }
  const observations = header.candidates.map(w => ({ day:Number(w.text), x:w.cx }))
    .filter(p => p.day >= 1 && p.day <= 31);
  const fit = linearFit(observations);
  if (!fit || fit.slope <= 0) {
    warnings.push("Non riesco a ricostruire la spaziatura delle colonne.");
    return { people: [], shifts: [], warnings, period: "non riconosciuto" };
  }
  const columnWidth = fit.slope;
  const firstColumnX = fit.intercept + columnWidth;
  const leftBoundary = firstColumnX - columnWidth*.50;

  // Estrae le righe delle persone sotto l'intestazione dei giorni.
  const personRows = rows.filter(r => r.cy > header.row.cy + imageH*.055);
  const people = [], shifts = [];
  const ignoreLeft = new Set(["NOVEMBRE","OTTOBRE","GENNAIO","FEBBRAIO","MARZO","APRILE","MAGGIO","GIUGNO","LUGLIO","AGOSTO","SETTEMBRE","DICEMBRE"]);
  for (const row of personRows) {
    const left = row.words.filter(w => w.cx < leftBoundary && /[A-Za-zÀ-ÿ]/.test(w.text));
    if (!left.length) continue;
    const name = left.map(w => w.text).join(" ").replace(/\s+/g," ").trim();
    if (name.length < 3 || ignoreLeft.has(name.toUpperCase()) || /^\d+$/.test(name)) continue;
    if (!people.some(p => normalize(p) === normalize(name))) people.push(name);

    for (const cell of row.words.filter(w => w.cx >= leftBoundary)) {
      const day = Math.round((cell.cx - fit.intercept) / columnWidth);
      if (day < 1 || day > 31) continue;
      const expectedX = fit.intercept + day*columnWidth;
      if (Math.abs(cell.cx-expectedX) > columnWidth*.46) continue;
      const token = cell.text.toUpperCase().replace(/[|]/g,"1").trim();
      if (token === "R" || token === "F" || token === "RF" || token === "FR" || token === "-") continue;
      if (!/^[1-3]$/.test(token)) {
        if (/[0-9]/.test(token) || /^[A-Z]$/.test(token)) warnings.push(`${name}, giorno ${day}: "${cell.text}" da verificare`);
        continue;
      }
      if (!month || !year) continue;
      const date = new Date(year, month-1, day, 12);
      if (date.getMonth() !== month-1) { warnings.push(`Data non valida: ${day}/${month}/${year}`); continue; }
      const code = Number(token), cfg = state.settings.codes[code];
      const start = dateAt(date, cfg.start), end = dateAt(date, cfg.end);
      if (end <= start) end.setDate(end.getDate()+1);
      shifts.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
        person: name, date: isoDate(date), code, start: isoLocal(start), end: isoLocal(end),
        confidence: cell.confidence, review: cell.confidence < .70
      });
    }
  }
  if (!month || !year) warnings.push("Nessun turno creato per evitare di inventare le date.");
  const period = month && year ? `${Object.keys(MONTHS).find(k=>MONTHS[k]===month && k.length>3) || month}/${year}` : "mese/anno mancanti";
  return { people: people.sort((a,b)=>a.localeCompare(b,"it")), shifts, warnings, period };
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
loadSettings();
if("serviceWorker" in navigator && location.protocol.startsWith("http"))
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
