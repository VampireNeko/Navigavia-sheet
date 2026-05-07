/* ============================================================
   NAVIGAVIA — Scheda Personaggio
   app.js
   ============================================================ */

/* ── Chiave con cui salviamo i dati nel localStorage del browser ── */
const STORAGE_KEY = "navigavia-character-sheet-v1";

/* ── Liste fisse di tratti e abilità (determinano anche l'ordine di visualizzazione) ── */
const traitsList = ["Vigore","Grazia","Risolutezza","Acume","Panache"];
const skillsList  = [
  "Allettare","A. D. Guerra","Atletica","Cavalcare","Convincere",
  "Empatia","Esibirsi","Furto","Intimidire","Istruzione",
  "Mira","Mischia","Nascondersi","Navigazione","Notare","Rissa"
];

/* ── Struttura dati di default per una scheda vuota.
   Viene usata anche come "template" per creare nuove schede
   e come fallback se il salvataggio è corrotto. ── */
const defaultData = {
  identity:    { player:"", character:"", concept:"", nation:"", faith:"" },
  traits:      Object.fromEntries(traitsList.map(n => [n, 2])),    // tratti partono a 2 di default
  traitBonus:  Object.fromEntries(traitsList.map(n => [n, ""])),   // campo testo per bonus/modificatori
  skills:      Object.fromEntries(skillsList.map(n => [n, 0])),
  skillBonus:  Object.fromEntries(skillsList.map(n => [n, ""])),
  wealth:      0,
  arcana:      { virtue:"", hubris:"" },
  stories:     [],           // array di { title, goal, reward, act1, notes }
  heroPoints:  0,
  deathSpiral: Array(20).fill(false),  // 20 caselle, false = vuota
  background:  "",
  advantages:  [],           // array di { name, desc }
  meta: { app:"Navigavia Scheda Webapp", version:1, updatedAt:"" }
};

/* ── Stato corrente della scheda (viene modificato da tutto il resto) ── */
let data = structuredClone(defaultData);

/* ── Timer per il debounce del salvataggio automatico ── */
let saveTimer = null;

/* ── Scorciatoia per document.querySelector ── */
const $ = s => document.querySelector(s);


/* ============================================================
   AUTO-EXPAND TEXTAREA
   Le textarea con classe .auto-expand crescono in altezza
   automaticamente man mano che l'utente scrive.
   ============================================================ */
function autoExpand(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/* Applica l'auto-expand a tutte le textarea .auto-expand presenti nel DOM */
function initAutoExpand() {
  document.querySelectorAll("textarea.auto-expand").forEach(el => autoExpand(el));
}


/* ============================================================
   UTILITY DI DATI
   ============================================================ */

/* Naviga un oggetto seguendo un path tipo "identity.player" */
function getByPath(o, p) {
  return p.split(".").reduce((a,k) => a?.[k], o);
}

/* Scrive un valore in un oggetto seguendo un path tipo "identity.player",
   creando i livelli intermedi se non esistono */
function setByPath(o, p, v) {
  const parts = p.split("."), last = parts.pop();
  parts.reduce((a,k) => a[k] ??= {}, o)[last] = v;
}

/* Clamp numerico: forza un valore nell'intervallo [min, max],
   restituisce min se il valore non è un numero finito */
function clampNumber(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min;
}

/* Merge ricorsivo: copia le proprietà di `source` in `target`
   senza sovrascrivere interi sotto-oggetti (merge profondo) */
function deepMerge(t, s) {
  for (const [k,v] of Object.entries(s)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!t[k] || typeof t[k] !== "object") t[k] = {};
      deepMerge(t[k], v);
    } else {
      t[k] = v;
    }
  }
}

/* Normalizza i dati importati (da JSON o dal localStorage) per garantire
   la compatibilità con versioni precedenti della scheda.
   Questo è il "migration layer": gestisce i vecchi formati. */
function normalizeImported(imp) {
  const m = structuredClone(defaultData);
  deepMerge(m, imp || {});

  // Clamp valori numerici
  traitsList.forEach(n => m.traits[n] = clampNumber(m.traits[n], 0, 5));
  skillsList.forEach(n => m.skills[n] = clampNumber(m.skills[n], 0, 5));
  m.wealth     = clampNumber(m.wealth,     0, 5);
  m.heroPoints = clampNumber(m.heroPoints, 0, 99);

  // V1 aveva deathSpiral come numero (0-20), ora è array di 20 booleani
  if (typeof m.deathSpiral === "number") {
    const n = clampNumber(m.deathSpiral, 0, 20);
    m.deathSpiral = Array(20).fill(false).map((_,i) => i < n);
  } else if (!Array.isArray(m.deathSpiral) || m.deathSpiral.length !== 20) {
    m.deathSpiral = Array(20).fill(false);
  }

  // advantages: era una stringa, poi array di stringhe, ora array di {name, desc}
  if (typeof m.advantages === "string") {
    m.advantages = m.advantages.trim()
      ? m.advantages.split("\n").map(s => ({ name: s.trim(), desc: "" })).filter(v => v.name)
      : [];
  } else if (Array.isArray(m.advantages)) {
    m.advantages = m.advantages.map(v =>
      typeof v === "string" ? { name: v, desc: "" } : { name: v.name||"", desc: v.desc||"" }
    );
  } else {
    m.advantages = [];
  }

  // stories: era un oggetto singolo {title, goal, ...}, ora è un array
  if (!Array.isArray(m.stories)) {
    if (m.story && typeof m.story === "object") {
      m.stories = [{ title: m.story.title||"", goal: m.story.goal||"", reward: m.story.reward||"", act1: m.story.act1||"", notes: m.story.notes||"" }];
    } else {
      m.stories = [];
    }
    delete m.story;
  }

  return m;
}


/* ============================================================
   RENDERING TRATTI E ABILITÀ
   Costruisce le righe con quadratini, label e campo bonus.
   ============================================================ */
function renderRatings(containerId, groupName, names) {
  const cont = document.getElementById(containerId);
  if (!cont) return;
  cont.innerHTML = "";

  // capisce quale sotto-oggetto contiene i bonus per questo gruppo
  const bonusGroup = groupName === "traits" ? "traitBonus" : "skillBonus";

  names.forEach(name => {
    const row = document.createElement("div");
    row.className = "rating-row";

    // --- 5 quadratini cliccabili ---
    const boxesDiv = document.createElement("div");
    boxesDiv.className = "boxes";
    boxesDiv.setAttribute("aria-label", name);
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "box";
      b.dataset.ratingGroup = groupName;
      b.dataset.ratingName  = name;
      b.dataset.ratingValue = i;
      b.setAttribute("aria-label", `${name} ${i}`);
      boxesDiv.appendChild(b);
    }

    // --- label con il nome ---
    const label = document.createElement("div");
    label.className = "rating-label";
    label.textContent = name;

    // --- piccolo campo per bonus/modificatori (es. +1 da vantaggio) ---
    const bonus = document.createElement("input");
    bonus.type = "text";
    bonus.className = "rating-bonus";
    bonus.placeholder = "+/-";
    bonus.maxLength = 4;
    bonus.title = "Modificatori / bonus";
    bonus.value = data[bonusGroup]?.[name] || "";
    bonus.addEventListener("input", () => {
      if (!data[bonusGroup]) data[bonusGroup] = {};
      data[bonusGroup][name] = bonus.value;
      queueSave();
    });

    row.appendChild(boxesDiv);
    row.appendChild(label);
    row.appendChild(bonus);
    cont.appendChild(row);
  });
}


/* ============================================================
   RENDERING MONETE (tracker ricchezza I–V)
   ============================================================ */
function renderWealth() {
  const cont = $("#wealth");
  cont.innerHTML = "";
  ["I","II","III","IV","V"].forEach((lbl, i) => {
    const c = document.createElement("button");
    c.type = "button"; c.className = "coin";
    c.dataset.wealth = i + 1;
    c.textContent = lbl;
    cont.appendChild(c);
  });
}


/* ============================================================
   SPIRALE DELLA MORTE — SVG interattiva
   ============================================================ */

/* Caselle con teschio (ferite drammatiche): al 5°, 10°, 15°, 20° posto */
const SKULL_STEPS = new Set([5, 10, 15, 20]);
const R_CELL = 13;  // raggio uguale per tutti i cerchi

/* Calcola le coordinate XY di ciascuna delle 20 caselle.
   Algoritmo: spirale di Archimede con passo angolare variabile
   tale che la distanza euclidea tra caselle consecutive sia sempre
   uguale a targetDist (36px). Questo evita sovrapposizioni. */
function computeSpiralPositions() {
  const cx = 120, cy = 120;  // centro della viewBox

  const targetDist = 36;   // distanza centro-centro tra caselle
  const rStart     = 100;  // raggio della casella 1 (la più esterna)
  const rEnd       = 38;   // raggio della casella 20 (la più interna)

  // quanto decresce il raggio per ogni radiant percorso
  const drPerRad = (rStart - rEnd) / (2.0 * Math.PI * 1.55);

  const positions = [];
  let r     = rStart;
  let angle = -Math.PI / 2;  // parte dalla cima (12 o'clock)

  for (let i = 0; i < 20; i++) {
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    positions.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);

    if (i < 19) {
      // dθ = targetDist / √(r² + drPerRad²)  — formula di avanzamento lungo la spirale
      const dTheta = targetDist / Math.sqrt(r * r + drPerRad * drPerRad);
      angle -= dTheta;   // senso antiorario (angolo decresce in SVG con y verso il basso)
      r = Math.max(rEnd, r - drPerRad * dTheta);
    }
  }
  return positions;
}
const SPIRAL_POS = computeSpiralPositions();

/* Costruisce l'SVG della spirale: traccia guida + 20 caselle cliccabili */
function buildSpiral() {
  const g = document.getElementById("spiralCells");
  g.innerHTML = "";

  // --- traccia guida: curva leggera che collega i centri ---
  const pts = SPIRAL_POS;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const p  = pts[i - 1], q = pts[i];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    d += ` Q ${p[0]} ${p[1]} ${mx} ${my}`;  // curva quadratica per fluidità
  }
  d += ` L ${pts[19][0]} ${pts[19][1]}`;

  const guide = document.createElementNS("http://www.w3.org/2000/svg","path");
  guide.setAttribute("d", d);
  guide.setAttribute("fill","none");
  guide.setAttribute("stroke","rgba(120,80,20,.20)");
  guide.setAttribute("stroke-width","3");
  guide.setAttribute("stroke-linecap","round");
  guide.setAttribute("stroke-linejoin","round");
  g.appendChild(guide);

  // --- 20 caselle (cerchio + numero/teschio) ---
  pts.forEach(([x, y], i) => {
    const step    = i + 1;
    const isSkull = SKULL_STEPS.has(step);

    const grp = document.createElementNS("http://www.w3.org/2000/svg","g");
    grp.classList.add("sp-cell");
    if (isSkull) grp.classList.add("skull");
    grp.dataset.spiral = step;
    grp.dataset.idx    = i;  // indice 0-based nell'array deathSpiral

    const circ = document.createElementNS("http://www.w3.org/2000/svg","circle");
    circ.setAttribute("cx", x); circ.setAttribute("cy", y); circ.setAttribute("r", R_CELL);

    const txt = document.createElementNS("http://www.w3.org/2000/svg","text");
    txt.setAttribute("x", x); txt.setAttribute("y", y);
    txt.textContent = isSkull ? "☠" : step;

    grp.appendChild(circ); grp.appendChild(txt);
    g.appendChild(grp);
  });
}

/* Gestisce il click su una casella della spirale.
   - Teschio → toggle indipendente (si può segnare senza toccare le altre)
   - Normale → seleziona tutte le normali da 1 fino a questa;
                se già tutte selezionate, deseleziona l'ultima */
function handleSpiralClick(idx) {
  const step    = idx + 1;
  const isSkull = SKULL_STEPS.has(step);

  if (isSkull) {
    data.deathSpiral[idx] = !data.deathSpiral[idx];
  } else {
    // indici di tutte le caselle normali da 0 fino a questa inclusa
    const normalsBefore = SPIRAL_POS
      .map((_,i) => i)
      .filter(i => !SKULL_STEPS.has(i+1) && i <= idx);

    const allOn = normalsBefore.every(i => data.deathSpiral[i]);

    if (allOn) {
      // erano tutte accese: spegni solo questa
      data.deathSpiral[idx] = false;
    } else {
      // accendi tutte le normali fino qui
      normalsBefore.forEach(i => { data.deathSpiral[i] = true; });
    }
  }
}


/* ============================================================
   RENDERING VANTAGGI (lista dinamica)
   ============================================================ */
function renderVantaggi() {
  const list = document.getElementById("vantaggiList");
  list.innerHTML = "";

  (data.advantages || []).forEach((v, i) => {
    const card = document.createElement("div");
    card.className = "vantaggio-card";

    // --- header: nome in grassetto + pulsante elimina ---
    const header = document.createElement("div");
    header.className = "vantaggio-header";

    const nomeInp = document.createElement("input");
    nomeInp.type = "text"; nomeInp.className = "vantaggio-nome";
    nomeInp.value = v.name || ""; nomeInp.placeholder = "Nome vantaggio";
    nomeInp.addEventListener("input", () => { data.advantages[i].name = nomeInp.value; queueSave(); });

    // pulsante elimina con long-press 3 secondi (barra di progresso via CSS)
    const del = makeLongPressDelete(3000, () => {
      data.advantages.splice(i, 1);
      renderVantaggi(); queueSave();
    });

    header.appendChild(nomeInp); header.appendChild(del);

    // --- textarea descrizione ed effetti ---
    const descTA = document.createElement("textarea");
    descTA.className = "vantaggio-desc";
    descTA.value = v.desc || "";
    descTA.placeholder = "Descrizione ed effetti…";
    descTA.addEventListener("input", () => { data.advantages[i].desc = descTA.value; queueSave(); });

    card.appendChild(header); card.appendChild(descTA);
    list.appendChild(card);
  });
}


/* ============================================================
   RENDERING STORIE (lista dinamica)
   ============================================================ */
function renderStorie() {
  const list = document.getElementById("storieList");
  list.innerHTML = "";

  (data.stories || []).forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "storia-card";

    // --- header: titolo + pulsante elimina ---
    const header = document.createElement("div");
    header.className = "storia-header";

    const titInp = document.createElement("input");
    titInp.type = "text"; titInp.className = "storia-titolo";
    titInp.value = s.title || ""; titInp.placeholder = "Titolo storia";
    titInp.addEventListener("input", () => { data.stories[i].title = titInp.value; queueSave(); });

    const del = makeLongPressDelete(3000, () => {
      data.stories.splice(i, 1);
      renderStorie(); queueSave();
    });

    header.appendChild(titInp); header.appendChild(del);

    // --- campi corpo: scopo, ricompensa, atto 1, note ---
    const body = document.createElement("div");
    body.className = "storia-body";

    [
      ["Scopo",      "goal",    "input"],
      ["Ricompensa", "reward",  "input"],
      ["Atto 1",     "act1",    "input"],
      ["Note",       "notes",   "textarea"],
    ].forEach(([lbl, key, tag]) => {
      const f = document.createElement("div"); f.className = "storia-field";
      const l = document.createElement("label"); l.textContent = lbl;
      const el = document.createElement(tag);
      el.value = s[key] || ""; el.placeholder = lbl + "…";
      if (tag === "textarea") {
        el.classList.add("auto-expand");
        el.addEventListener("input", () => { data.stories[i][key] = el.value; queueSave(); autoExpand(el); });
      } else {
        el.addEventListener("input", () => { data.stories[i][key] = el.value; queueSave(); });
      }
      f.appendChild(l); f.appendChild(el);
      body.appendChild(f);
    });

    card.appendChild(header); card.appendChild(body);
    list.appendChild(card);
  });

  requestAnimationFrame(initAutoExpand);
}


/* ============================================================
   HELPER: crea un pulsante ✕ con long-press
   Parametri:
     duration — millisecondi da tenere premuto
     onConfirm — callback da chiamare alla conferma
   Ritorna il <button> pronto da appendere al DOM.
   ============================================================ */
function makeLongPressDelete(duration, onConfirm) {
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn-del";
  btn.title = `Tieni premuto ${duration/1000}s per eliminare`;
  btn.textContent = "✕";
  btn.style.setProperty("--progress", "0%");

  let timer = null, interval = null;

  function start(e) {
    e.preventDefault();
    const t0 = Date.now();
    btn.classList.add("pressing");
    interval = setInterval(() => {
      btn.style.setProperty("--progress", Math.min(100, ((Date.now()-t0)/duration)*100) + "%");
    }, 30);
    timer = setTimeout(() => {
      clearInterval(interval);
      btn.classList.remove("pressing");
      btn.style.setProperty("--progress", "0%");
      onConfirm();
    }, duration);
  }
  function cancel() {
    clearTimeout(timer); clearInterval(interval);
    btn.classList.remove("pressing");
    btn.style.setProperty("--progress", "0%");
  }

  btn.addEventListener("mousedown",   start);
  btn.addEventListener("touchstart",  start, { passive: false });
  btn.addEventListener("mouseup",     cancel);
  btn.addEventListener("mouseleave",  cancel);
  btn.addEventListener("touchend",    cancel);
  btn.addEventListener("touchcancel", cancel);

  return btn;
}


/* ============================================================
   SYNC UI — aggiorna tutto il DOM per rispecchiare `data`
   Chiamata dopo ogni caricamento o modifica rilevante.
   ============================================================ */
function syncUI() {
  // aggiorna tutti i campi con data-path (input e textarea)
  document.querySelectorAll("[data-path]").forEach(el => {
    el.value = getByPath(data, el.dataset.path) ?? "";
  });

  // aggiorna i quadratini pieni/vuoti per tratti e abilità
  document.querySelectorAll("[data-rating-group]").forEach(b => {
    b.classList.toggle("on",
      Number(b.dataset.ratingValue) <= (data[b.dataset.ratingGroup]?.[b.dataset.ratingName] || 0)
    );
  });

  // aggiorna i campi bonus accanto ai rating
  document.querySelectorAll(".rating-bonus").forEach(inp => {
    const label = inp.parentElement.querySelector(".rating-label");
    if (!label) return;
    const name = label.textContent;
    const grp  = traitsList.includes(name) ? "traitBonus" : "skillBonus";
    inp.value = data[grp]?.[name] || "";
  });

  // aggiorna le monete della ricchezza
  document.querySelectorAll("[data-wealth]").forEach(c => {
    c.classList.toggle("on", Number(c.dataset.wealth) <= data.wealth);
  });

  // aggiorna le caselle della spirale
  document.querySelectorAll("[data-spiral]").forEach(cell => {
    const idx = parseInt(cell.dataset.idx);
    cell.classList.toggle("on", data.deathSpiral[idx] === true);
  });

  // aggiorna le righe F. Dram. con colore verde (buff) o rosso (malus)
  // teschio 1 (idx 4) e 3 (idx 14) → verde; teschio 2 (idx 9) e 4 (idx 19) → rosso
  [[4,1,"active"],[9,2,"active-bad"],[14,3,"active"],[19,4,"active-bad"]].forEach(([idx, num, cls]) => {
    const row = document.getElementById("fdram-" + num);
    if (!row) return;
    const on = data.deathSpiral[idx] === true;
    row.classList.toggle("active",     cls === "active"     && on);
    row.classList.toggle("active-bad", cls === "active-bad" && on);
  });

  // aggiorna il contatore punti eroe
  $("#heroPointsValue").textContent = data.heroPoints;

  // ri-renderizza le liste dinamiche
  renderVantaggi();
  renderStorie();

  requestAnimationFrame(initAutoExpand);
}


/* ============================================================
   SALVATAGGIO LOCALE (localStorage)
   Il salvataggio è debouncato: aspetta 250ms di inattività
   prima di scrivere, per non sprecare operazioni.
   ============================================================ */
function queueSave() {
  clearTimeout(saveTimer);
  $("#saveStatus").textContent = "Salvataggio…";
  saveTimer = setTimeout(saveNow, 250);
}

function saveNow() {
  data.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  $("#saveStatus").textContent = "Salvato " + new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}

/* Carica dal localStorage; in caso di dati mancanti o corrotti,
   usa la struttura di default senza mostrare errori all'utente */
function load() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    data = s ? normalizeImported(JSON.parse(s)) : structuredClone(defaultData);
  } catch(e) {
    data = structuredClone(defaultData);
  }
}


/* ============================================================
   ESPORTA / IMPORTA JSON
   ============================================================ */
function exportJson() {
  saveNow();
  // usa il nome del personaggio come nome file (caratteri speciali rimossi)
  const name = (data.identity.character?.trim().replace(/[^a-z0-9_-]+/gi, "-") || "personaggio");
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `navigavia-${name}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function importJson(file) {
  if (!file) return;
  try {
    data = normalizeImported(JSON.parse(await file.text()));
    syncUI(); saveNow();
    $("#saveStatus").textContent = "JSON importato";
  } catch(e) {
    alert("File JSON non valido.");
  }
}

/* Svuota completamente la scheda (chiamata dopo il long-press del pulsante Svuota) */
function resetSheet() {
  data = structuredClone(defaultData);
  localStorage.removeItem(STORAGE_KEY);
  syncUI();
  $("#saveStatus").textContent = "Scheda svuotata";
}


/* ============================================================
   BINDING EVENTI
   Collega tutti i listener interattivi al DOM.
   ============================================================ */
function bindEvents() {

  // --- input su qualsiasi campo con data-path → aggiorna data e salva ---
  document.addEventListener("input", e => {
    const el = e.target.closest("[data-path]");
    if (!el) return;
    setByPath(data, el.dataset.path, el.value);
    queueSave();
    // auto-expand per le textarea marcate
    if (el.tagName === "TEXTAREA" && el.classList.contains("auto-expand")) autoExpand(el);
  });

  // auto-expand anche per le textarea dei vantaggi (non hanno data-path)
  document.addEventListener("input", e => {
    if (e.target.classList.contains("vantaggio-desc")) autoExpand(e.target);
  });

  // --- click su quadratini rating, monete, caselle spirale, contatori ---
  document.addEventListener("click", e => {
    // quadratino rating (tratto o abilità): click = toggle
    const r = e.target.closest("[data-rating-group]");
    if (r) {
      const {ratingGroup:g, ratingName:n, ratingValue:v} = r.dataset;
      data[g][n] = data[g][n] === +v ? +v-1 : +v;
      syncUI(); queueSave(); return;
    }
    // moneta ricchezza
    const w = e.target.closest("[data-wealth]");
    if (w) {
      const v = Number(w.dataset.wealth);
      data.wealth = data.wealth === v ? v-1 : v;
      syncUI(); queueSave(); return;
    }
    // casella spirale
    const sp = e.target.closest("[data-spiral]");
    if (sp) {
      handleSpiralClick(parseInt(sp.dataset.idx));
      syncUI(); queueSave(); return;
    }
    // pulsanti +/- per i contatori (punti eroe)
    const cnt = e.target.closest("[data-counter]");
    if (cnt) {
      data[cnt.dataset.counter] = clampNumber(
        (data[cnt.dataset.counter] || 0) + Number(cnt.dataset.delta), 0, 99
      );
      syncUI(); queueSave();
    }
  });

  // --- pulsanti topbar ---
  $("#exportBtn").addEventListener("click", exportJson);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", e => importJson(e.target.files[0]));

  // --- SVUOTA — long-press 5 secondi con barra di progresso ---
  const resetBtn = $("#resetBtn");
  resetBtn.style.setProperty("--reset-progress", "0%");
  let resetTimer = null, resetInterval = null;

  function startReset(e) {
    e.preventDefault();
    const t0 = Date.now();
    resetBtn.classList.add("pressing");
    resetInterval = setInterval(() => {
      resetBtn.style.setProperty("--reset-progress", Math.min(100, ((Date.now()-t0)/5000)*100) + "%");
    }, 40);
    resetTimer = setTimeout(() => {
      clearInterval(resetInterval);
      resetBtn.classList.remove("pressing");
      resetBtn.style.setProperty("--reset-progress", "0%");
      resetSheet();
    }, 5000);
  }
  function cancelReset() {
    clearTimeout(resetTimer); clearInterval(resetInterval);
    resetBtn.classList.remove("pressing");
    resetBtn.style.setProperty("--reset-progress", "0%");
  }
  resetBtn.addEventListener("mousedown",   startReset);
  resetBtn.addEventListener("touchstart",  startReset, { passive: false });
  resetBtn.addEventListener("mouseup",     cancelReset);
  resetBtn.addEventListener("mouseleave",  cancelReset);
  resetBtn.addEventListener("touchend",    cancelReset);
  resetBtn.addEventListener("touchcancel", cancelReset);

  // --- aggiungi vantaggio ---
  $("#addVantaggio").addEventListener("click", () => {
    if (!Array.isArray(data.advantages)) data.advantages = [];
    data.advantages.push({ name: "", desc: "" });
    renderVantaggi(); queueSave();
    // focus diretto sull'input del nuovo vantaggio
    const inputs = document.querySelectorAll(".vantaggio-nome");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // --- aggiungi storia ---
  $("#addStoria").addEventListener("click", () => {
    if (!Array.isArray(data.stories)) data.stories = [];
    data.stories.push({ title:"", goal:"", reward:"", act1:"", notes:"" });
    renderStorie(); queueSave();
    const inputs = document.querySelectorAll(".storia-titolo");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // --- AZZERA SPIRALE — long-press 3 secondi ---
  const spBtn = $("#resetSpiral");
  spBtn.style.setProperty("--sp-progress", "0%");
  let spTimer = null, spInterval = null;

  function startSpReset(e) {
    e.preventDefault();
    const t0 = Date.now();
    spBtn.classList.add("pressing");
    spInterval = setInterval(() => {
      spBtn.style.setProperty("--sp-progress", Math.min(100, ((Date.now()-t0)/3000)*100) + "%");
    }, 30);
    spTimer = setTimeout(() => {
      clearInterval(spInterval);
      spBtn.classList.remove("pressing");
      spBtn.style.setProperty("--sp-progress", "0%");
      data.deathSpiral = Array(20).fill(false);
      syncUI(); queueSave();
    }, 3000);
  }
  function cancelSpReset() {
    clearTimeout(spTimer); clearInterval(spInterval);
    spBtn.classList.remove("pressing");
    spBtn.style.setProperty("--sp-progress", "0%");
  }
  spBtn.addEventListener("mousedown",   startSpReset);
  spBtn.addEventListener("touchstart",  startSpReset, { passive: false });
  spBtn.addEventListener("mouseup",     cancelSpReset);
  spBtn.addEventListener("mouseleave",  cancelSpReset);
  spBtn.addEventListener("touchend",    cancelSpReset);
  spBtn.addEventListener("touchcancel", cancelSpReset);
}

/* ── AVVIO ── */
renderRatings("traits", "traits", traitsList);
renderRatings("skills", "skills", skillsList);
renderWealth();
buildSpiral();
bindEvents();
load();
syncUI();
initAutoExpand();