"use strict";

// IMT Smart Minutes — application 100 % navigateur.
// Transcription : Voxtral Mini Transcribe V2 (avec séparation des intervenants).
// Compte rendu : modèle de chat Mistral, export .docx via la librairie docx.

const API_BASE = "https://api.mistral.ai/v1";
const TRANSCRIBE_MODEL = "voxtral-mini-2602";
// Rédaction (compte rendu, noms) : ILAAS via notre proxy Cloudflare, qui détient la clé.
const WRITER_URL = "https://imt-smart-minutes-proxy.julienmorice.workers.dev";
const WRITER_LABEL = "Qwen 3.6 (ILAAS)";
const VIOLET = "AD1D89";
const BLEU = "00B8DE";
const FONT = "Arial";
const KEY_STORAGE = "imtSmartMinutes.apiKey";
const LONG_TRANSCRIPT = 60000; // caractères, au-delà on prévient l'utilisateur
// Offre gratuite Mistral : 50 000 tokens/minute pour Voxtral. L'audio compte environ
// 750 tokens/minute (12,5 par seconde), plus le texte produit : au-delà de ~45 min
// d'enregistrement, une seule requête dépasse la limite et Mistral répond 429.
const FREE_TIER_MAX_MINUTES = 45;

// État applicatif : uniquement en mémoire, rien n'est envoyé ailleurs qu'à Mistral.
const state = {
  turns: [],        // [{id: "Intervenant 1", start, end, text}] prises de parole fusionnées
  names: {},        // id -> nom affiché
  text: "",         // transcription de référence (lignes "[hh:mm:ss] Nom : texte")
  report: null,
  audio: null,
  audioUrl: null,
  file: null,
  duration: 0,      // durée de l'audio déposé, en secondes (0 si inconnue)
};

const $ = (id) => document.getElementById(id);

// ----------------------------- Utilitaires -----------------------------

function apiKey() { return $("apiKey").value.trim(); }
function pad2(n) { return String(n).padStart(2, "0"); }

function formatTimestamp(seconds) {
  const total = Math.round(seconds || 0);
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function longDateFR(iso) {
  const d = iso ? new Date(iso + "T12:00:00") : new Date();
  if (isNaN(d)) return iso || "";
  const s = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortDateFR(iso) {
  const d = iso ? new Date(iso + "T12:00:00") : new Date();
  if (isNaN(d)) return iso || "";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function compactDate(iso) { return (iso || todayISO()).replace(/-/g, ""); }

function slugify(value) {
  return (value || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "Reunion";
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function showMsg(elId, type, text) {
  $(elId).innerHTML = text ? `<div class="msg ${type}">${text}</div>` : "";
}

function setStepEnabled(id, enabled) { $(id).classList.toggle("disabled", !enabled); }

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " Mo";
  return Math.max(1, Math.round(bytes / 1024)) + " Ko";
}

function shortDetail(err) {
  let d = (err && err.detail) || "";
  try {
    const j = JSON.parse(d);
    d = j.message || j.detail || j.error || d;
    if (typeof d === "object") d = JSON.stringify(d);
  } catch (e) { /* corps non JSON */ }
  d = String(d).replace(/\s+/g, " ").trim();
  return escapeHtml(d.length > 240 ? d.slice(0, 240) + "…" : d);
}

function humanizeError(err) {
  const status = err && err.status;
  const detail = shortDetail(err);
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  if (err && err.source === "writer") {
    if (status === 504 || /timeout/i.test(detail))
      return "La rédaction a pris trop de temps et le service ILAAS a coupé la connexion. Relancez la génération.";
    if (status === 413)
      return "La transcription est trop longue pour être rédigée en une seule fois.";
    return `Le service de rédaction (ILAAS) a renvoyé une erreur (${status}).` + (detail ? " Détail : " + detail : "") + " Réessayez dans un instant.";
  }
  if (status === 401)
    return "Clé refusée par Mistral (erreur 401). Vérifiez qu'elle est complète et sans espace en trop. Une clé toute neuve peut mettre une minute à s'activer.";
  if (status === 403)
    return "Accès refusé (erreur 403) : ce modèle n'est pas inclus dans votre offre Mistral. Choisissez Mistral Medium ou Small." + (detail ? " Réponse de Mistral : " + detail : "");
  if (status === 429)
    return "Mistral est saturé ou votre limite d'utilisation est atteinte (erreur 429), malgré plusieurs nouvelles tentatives. Réessayez dans quelques minutes. Avec l'offre gratuite de Mistral, ces saturations sont plus fréquentes aux heures de pointe." + (detail ? " Réponse de Mistral : " + detail : "");
  if (status === 413)
    return "Fichier trop volumineux (erreur 413). Raccourcissez l'enregistrement ou exportez-le dans un format plus léger (mp3, m4a).";
  if (status === 400 || status === 422)
    return `Requête refusée par Mistral (erreur ${status}).` + (detail ? " Détail : " + detail : "") + " Si le format audio est en cause, essayez de le convertir en mp3.";
  if (typeof status === "number" && status >= 500)
    return `Le service Mistral est momentanément indisponible (erreur ${status}). Réessayez dans un instant.`;
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed"))
    return "Impossible de joindre Mistral. Vérifiez votre connexion internet, puis réessayez.";
  return escapeHtml(err && err.message ? err.message : String(err));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
}

function flashButton(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = old; }, 1600);
}

// ----------------------------- Clé API -----------------------------

function storageGet() { try { return localStorage.getItem(KEY_STORAGE); } catch (e) { return null; } }
function storageSet(v) { try { localStorage.setItem(KEY_STORAGE, v); } catch (e) {} }
function storageDel() { try { localStorage.removeItem(KEY_STORAGE); } catch (e) {} }

function persistKey() {
  if ($("rememberKey").checked && apiKey()) storageSet(apiKey());
  else storageDel();
}

function refreshKeyGate() {
  setStepEnabled("step2", !!apiKey());
  persistKey();
}

// ----------------------------- Appels API -----------------------------

async function apiError(res, label) {
  const detail = await res.text().catch(() => "");
  console.error(`Mistral ${label} error`, res.status, detail);
  const e = new Error(`HTTP ${res.status}`);
  e.status = res.status; e.detail = detail;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS = [8000, 20000]; // secondes d'attente avant chaque nouvelle tentative

// Relance automatiquement un appel quand Mistral est saturé (429) ou en erreur (5xx).
async function withRetry(fn, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err && (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= RETRY_DELAYS.length) throw err;
      if (onWait) onWait(attempt + 1, RETRY_DELAYS[attempt] / 1000);
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

async function callTranscription(file, language) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("model", TRANSCRIBE_MODEL);
  if (language) fd.append("language", language);
  fd.append("diarize", "true");
  fd.append("timestamp_granularities", "segment");
  const res = await fetch(`${API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: fd,
  });
  if (!res.ok) throw await apiError(res, "/audio/transcriptions");
  return res.json();
}

// Réassemble le flux SSE relayé par le proxy en une seule chaîne de texte.
async function readSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "", text = "", finishReason = null;
  const handleBlock = (block) => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch (e) { continue; }
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const piece = choice.delta && choice.delta.content;
      if (typeof piece === "string") text += piece;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : blocks.pop();
    blocks.forEach(handleBlock);
    if (done) break;
  }
  if (finishReason === "length") console.warn("Réponse tronquée, tentative de réparation du JSON.");
  return text;
}

async function callWriterOnce(messages, jsonMode, maxTokens) {
  const body = { messages, temperature: 0.2, max_tokens: maxTokens || 4000 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(WRITER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await apiError(res, "proxy ILAAS");
    e.source = "writer";
    throw e;
  }
  if ((res.headers.get("Content-Type") || "").includes("text/event-stream")) return readSSEStream(res);
  const data = await res.json();
  return data.content || "";
}

// Rédaction via ILAAS, avec nouvelles tentatives si le service est saturé.
function callWriter(messages, jsonMode, maxTokens, onInfo) {
  return withRetry(
    () => callWriterOnce(messages, jsonMode, maxTokens),
    (n, s) => onInfo && onInfo(`Le service de rédaction est saturé, nouvelle tentative ${n}/${RETRY_DELAYS.length} dans ${s} s…`)
  );
}

async function callModels() {
  const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${apiKey()}` } });
  if (!res.ok) throw await apiError(res, "/models");
  return res.json();
}

// ----------------------------- Normalisation -----------------------------

function pick(obj, keys, def) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return def;
}

// Convertit la réponse Voxtral en prises de parole, en fusionnant les segments
// consécutifs d'un même intervenant pour une lecture plus fluide.
function normalizeTurns(data) {
  const raw = pick(data, ["segments", "chunks", "results"], null);
  if (!Array.isArray(raw) || raw.length === 0) {
    const text = String(pick(data, ["text"], "") || "").trim();
    if (!text) throw new Error("La transcription est vide. L'enregistrement contient-il bien de la parole ?");
    return [{ id: "Intervenant 1", start: 0, end: 0, text }];
  }
  const speakerMap = {};
  let order = 0;
  const turns = [];
  for (const seg of raw) {
    const text = String(pick(seg, ["text", "transcript", "content"], "") || "").trim();
    if (!text) continue;
    const key = String(pick(seg, ["speaker_id", "speaker", "speakerId", "speaker_label"], "0"));
    if (!(key in speakerMap)) { order += 1; speakerMap[key] = `Intervenant ${order}`; }
    const id = speakerMap[key];
    const start = parseFloat(pick(seg, ["start", "start_time", "startTime"], 0)) || 0;
    const end = parseFloat(pick(seg, ["end", "end_time", "endTime"], 0)) || 0;
    const last = turns[turns.length - 1];
    if (last && last.id === id) {
      last.text += " " + text;
      last.end = end || last.end;
    } else {
      turns.push({ id, start, end, text });
    }
  }
  return turns;
}

function repairJSON(text) {
  let s = text.trim();
  let inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') inString = !inString;
  }
  if (inString) s = s.slice(0, s.lastIndexOf('"')).replace(/,\s*$/, "");
  const stack = [];
  inString = false; escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }
  s = s.replace(/,\s*$/, "");
  while (stack.length) s += stack.pop() === "{" ? "}" : "]";
  return s;
}

function extractJSON(raw) {
  const cleaned = (raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) { try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_) {} }
  if (first >= 0) { try { return JSON.parse(repairJSON(cleaned.slice(first))); } catch (_) {} }
  console.error("JSON non lisible :", raw);
  throw new Error("La réponse du modèle est illisible. Relancez la génération ; si le problème persiste, choisissez un autre modèle.");
}

// ----------------------------- Transcription (texte) -----------------------------

function turnsToText(turns) {
  return turns.map((t) => `[${formatTimestamp(t.start)}] ${t.id} : ${t.text}`).join("\n\n");
}

// Relit le texte (éventuellement modifié à la main) en prises de parole.
const LINE_RE = /^(?:\[(\d{2}:\d{2}:\d{2})\]\s*)?([^:\n]{1,60}?)\s*:\s+(.*)$/;
function parseText(text) {
  const out = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (m) out.push({ ts: m[1] || "", who: m[2].trim(), text: m[3].trim() });
    else if (out.length) out[out.length - 1].text += " " + line;
    else out.push({ ts: "", who: "", text: line });
  }
  return out;
}

function plainTranscript() {
  return parseText(state.text).map((t) => (t.who ? `${t.who} : ${t.text}` : t.text)).join("\n\n");
}

function renameInText(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const re = new RegExp(`^((?:\\[\\d{2}:\\d{2}:\\d{2}\\]\\s*)?)${escapeRegExp(oldName)}(\\s*:)`, "gm");
  state.text = state.text.replace(re, `$1${newName}$2`);
}

function renderTranscript() {
  const view = $("transcriptView");
  view.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const t of parseText(state.text)) {
    const div = document.createElement("div");
    div.className = "turn";
    div.innerHTML = (t.who ? `<span class="who">${escapeHtml(t.who)}</span>` : "") +
      (t.ts ? `<span class="ts">${t.ts}</span>` : "") +
      `<p>${escapeHtml(t.text)}</p>`;
    frag.appendChild(div);
  }
  view.appendChild(frag);
  if (document.activeElement !== $("transcriptEditor")) $("transcriptEditor").value = state.text;
  const words = state.text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 150));
  $("transcriptStats").textContent = `${words.toLocaleString("fr-FR")} mots · environ ${minutes} min de lecture à voix haute`;
}

function switchTab(edit) {
  $("tabRead").classList.toggle("active", !edit);
  $("tabEdit").classList.toggle("active", edit);
  $("tabRead").setAttribute("aria-selected", String(!edit));
  $("tabEdit").setAttribute("aria-selected", String(edit));
  $("transcriptView").classList.toggle("hidden", edit);
  $("transcriptEditor").classList.toggle("hidden", !edit);
  if (edit) $("transcriptEditor").value = state.text;
  else renderTranscript();
}

function currentParticipants() {
  const ids = [...new Set(state.turns.map((t) => t.id))];
  return ids.map((id) => state.names[id] || id).filter((n) => !/^Intervenant \d+$/.test(n));
}

function refreshParticipantsMeta() {
  $("metaParticipants").value = currentParticipants().join("\n");
}

// ----------------------------- Intervenants -----------------------------

function buildNameEditor() {
  const ids = [...new Set(state.turns.map((t) => t.id))];
  const editor = $("nameEditor");
  editor.innerHTML = "";
  for (const id of ids) {
    const row = document.createElement("div");
    row.className = "name-row";
    const lbl = document.createElement("span");
    lbl.className = "spk";
    lbl.textContent = id;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Prénom NOM";
    input.value = state.names[id] && state.names[id] !== id ? state.names[id] : "";
    input.setAttribute("aria-label", `Nom de ${id}`);
    input.addEventListener("change", () => applyName(id, input.value.trim()));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-listen";
    btn.textContent = "▶ Écouter";
    const turn = state.turns.find((t) => t.id === id);
    if (state.audioUrl && turn) {
      btn.title = `Écouter la première prise de parole de ${id}`;
      btn.addEventListener("click", () => playClip(turn.start, turn.end, btn));
    } else {
      btn.disabled = true;
    }
    row.append(lbl, input, btn);
    editor.appendChild(row);
  }
}

function applyName(id, newName) {
  const oldName = state.names[id] || id;
  const target = newName || id;
  if (target === oldName) return;
  if (Object.entries(state.names).some(([k, v]) => k !== id && v === target)) {
    showMsg("msgIdentify", "warn", `« ${escapeHtml(target)} » est déjà attribué à un autre intervenant : les deux seront fusionnés dans le texte.`);
  }
  renameInText(oldName, target);
  state.names[id] = target;
  renderTranscript();
  refreshParticipantsMeta();
}

function playClip(start, end, btn) {
  const a = state.audio;
  if (!a || !state.audioUrl) return;
  start = start || 0;
  // Premier tour de parole, limité à 12 secondes.
  const stopAt = Math.min(end && end > start ? end : start + 8, start + 12);
  const wasThis = a._btn === btn && !a.paused;
  a.pause();
  if (a._stopHandler) { a.removeEventListener("timeupdate", a._stopHandler); a._stopHandler = null; }
  if (a._btn) { a._btn.classList.remove("playing"); a._btn = null; }
  if (wasThis) return; // second clic = stop

  const begin = () => {
    try { a.currentTime = start; } catch (e) {}
    a._btn = btn;
    btn.classList.add("playing");
    a._stopHandler = () => {
      if (a.currentTime >= stopAt) {
        a.pause();
        a.removeEventListener("timeupdate", a._stopHandler);
        a._stopHandler = null;
        if (a._btn) { a._btn.classList.remove("playing"); a._btn = null; }
      }
    };
    a.addEventListener("timeupdate", a._stopHandler);
    a.play().catch(() => { btn.classList.remove("playing"); });
  };
  if (a.readyState >= 1) begin();
  else a.addEventListener("loadedmetadata", begin, { once: true });
}

const SPEAKERS_SYSTEM = `Tu analyses la transcription d'une réunion où les intervenants sont anonymisés (Intervenant 1, Intervenant 2, etc.). Déduis, à partir du contenu (présentations, prénoms utilisés pour s'adresser à quelqu'un, tours de parole), le nom réel de chaque intervenant.

Règles strictes :
- Format : Prénom NOM (nom de famille en majuscules), ou seulement le Prénom si le nom n'est jamais cité.
- Attention : un prénom cité par un intervenant désigne en général la personne à qui il parle, pas lui-même.
- En cas de doute, renvoie exactement le label d'origine (ex. "Intervenant 3"). N'invente jamais de nom.
- Réponds uniquement par un objet JSON : les clés sont les labels d'origine, les valeurs les noms déduits.
Exemple : {"Intervenant 1": "Julien MORICE", "Intervenant 2": "Marine", "Intervenant 3": "Intervenant 3"}`;

async function onIdentify() {
  showMsg("msgIdentify", "", "");
  $("spinIdentify").classList.add("on");
  $("btnIdentify").disabled = true;
  try {
    const ids = [...new Set(state.turns.map((t) => t.id))];
    // On travaille sur les labels d'origine pour que le modèle garde des clés stables.
    const text = turnsToText(state.turns).slice(0, 120000);
    const user = `Intervenants à identifier : ${ids.join(", ")}.\n\nTranscription :\n${text}`;
    const content = await callWriter(
      [{ role: "system", content: SPEAKERS_SYSTEM }, { role: "user", content: user }],
      true, 1000,
      (m) => showMsg("msgIdentify", "info", escapeHtml(m))
    );
    const mapping = extractJSON(content);
    let found = 0;
    for (const id of ids) {
      const v = typeof mapping[id] === "string" ? mapping[id].trim() : "";
      if (v && v !== id && !/^Intervenant \d+$/i.test(v)) { applyName(id, v); found++; }
    }
    buildNameEditor();
    showMsg("msgIdentify", found ? "ok" : "info",
      found ? `${found} nom(s) proposé(s). Vérifiez-les en écoutant chaque intervenant et corrigez si besoin.`
            : "Aucun nom n'a pu être déduit avec certitude. Saisissez-les manuellement si vous le souhaitez.");
  } catch (err) {
    showMsg("msgIdentify", "error", humanizeError(err));
  } finally {
    $("spinIdentify").classList.remove("on");
    $("btnIdentify").disabled = false;
  }
}

// ----------------------------- Transcription (action) -----------------------------

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)} s`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${pad2(m % 60)}` : `${m} min`;
}

// Lit la durée de l'audio dans le navigateur (sans rien envoyer).
function readDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(isFinite(d) && d > 0 ? d : 0); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

function tooLongMessage() {
  return `Cet enregistrement dure <strong>${formatDuration(state.duration)}</strong>. Avec l'offre gratuite de Mistral, la transcription est limitée à <strong>environ ${FREE_TIER_MAX_MINUTES} minutes</strong> par fichier (plafond de 50 000 tokens par minute). Deux solutions :<br />
    1. <strong>Découper l'enregistrement</strong> en parties de ${FREE_TIER_MAX_MINUTES - 5} minutes maximum (par exemple avec QuickTime : Édition › Diviser le clip), puis transcrire chaque partie ;<br />
    2. <strong>Activer le paiement à l'usage</strong> sur <a href="https://admin.mistral.ai/" target="_blank" rel="noopener">admin.mistral.ai</a> (environ 0,20 € par heure d'audio), qui relève cette limite.`;
}

async function setFile(file) {
  if (!file) return;
  state.file = file;
  state.duration = 0;
  $("fileName").textContent = `${file.name} · ${formatSize(file.size)}`;
  showMsg("msgTranscribe", "", "");
  const d = await readDuration(file);
  if (state.file !== file) return; // un autre fichier a été choisi entre-temps
  state.duration = d;
  if (d) $("fileName").textContent = `${file.name} · ${formatSize(file.size)} · ${formatDuration(d)}`;
  if (d / 60 > FREE_TIER_MAX_MINUTES) showMsg("msgTranscribe", "warn", tooLongMessage() + "<br />Vous pouvez tout de même essayer si votre compte Mistral est payant.");
}

async function onTranscribe() {
  const file = state.file;
  if (!file) { showMsg("msgTranscribe", "error", "Choisissez d'abord un fichier audio."); return; }
  showMsg("msgTranscribe", "", "");
  $("spinTranscribe").classList.add("on");
  $("btnTranscribe").disabled = true;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $("spinTranscribeText").textContent = `Transcription en cours… ${Math.floor(s / 60)} min ${pad2(s % 60)} s (compter environ 1 min pour 15 min d'audio)`;
  }, 1000);
  try {
    const tooLong = state.duration / 60 > FREE_TIER_MAX_MINUTES;
    // Un fichier trop long pour l'offre gratuite échouera à chaque fois : inutile de réessayer.
    const data = tooLong
      ? await callTranscription(file, $("lang").value)
      : await withRetry(
        () => callTranscription(file, $("lang").value),
        (n, s) => showMsg("msgTranscribe", "info", `Mistral est saturé, nouvelle tentative ${n}/${RETRY_DELAYS.length} dans ${s} s…`)
      );
    showMsg("msgTranscribe", "", "");
    state.turns = normalizeTurns(data);
    state.names = {};
    state.report = null;
    state.text = turnsToText(state.turns);
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    state.audio.src = state.audioUrl;
    buildNameEditor();
    switchTab(false);
    refreshParticipantsMeta();
    $("reportBlock").classList.add("hidden");
    showMsg("msgIdentify", "", "");
    setStepEnabled("step3", true);
    setStepEnabled("step4", true);
    const n = new Set(state.turns.map((t) => t.id)).size;
    showMsg("msgTranscribe", "ok", `Transcription terminée : ${n} intervenant(s) détecté(s).`);
    if (state.text.length > LONG_TRANSCRIPT) {
      showMsg("msgReport", "info", "Réunion longue : la rédaction du compte rendu peut prendre plusieurs minutes. Mistral Medium ou Large sont conseillés.");
    }
    $("step3").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    const tooLong = state.duration / 60 > FREE_TIER_MAX_MINUTES;
    showMsg("msgTranscribe", "error", err && err.status === 429 && tooLong
      ? "Mistral a refusé ce fichier (erreur 429). " + tooLongMessage()
      : humanizeError(err));
  } finally {
    clearInterval(timer);
    $("spinTranscribe").classList.remove("on");
    $("spinTranscribeText").textContent = "Transcription en cours…";
    $("btnTranscribe").disabled = false;
  }
}

function transcriptFileBase() {
  return `Transcription_${slugify($("metaTitre").value || "Reunion")}_${compactDate($("metaDate").value)}`;
}

function buildTranscriptMarkdown() {
  const lines = [`# Transcription de réunion`, `*${longDateFR($("metaDate").value)}*`, ""];
  for (const t of parseText(state.text)) {
    lines.push(t.who ? `**${t.who}**${t.ts ? ` _(${t.ts})_` : ""}` : "");
    lines.push(t.text, "");
  }
  return lines.join("\n").trim() + "\n";
}

// ----------------------------- Compte rendu -----------------------------

const REPORT_SYSTEM = `Tu es chargé·e de rédiger le compte rendu professionnel d'une réunion à partir de sa transcription et de métadonnées.

Structure attendue :
1. "synthese" : 2 à 4 paragraphes en prose qui résument l'essentiel de la réunion (avancées, décisions, points d'attention), avec les chiffres clés cités.
2. "sections" : une section par thème abordé, dans l'ordre logique (pas forcément chronologique). Titre court et explicite. Chaque section contient 1 à 3 paragraphes rédigés en prose (pas de listes à puces), qui restituent les échanges, les arguments, les décisions et les prochaines étapes.
3. "actions" : le relevé de toutes les actions et décisions à suivre. "responsable" = prénom(s) de la ou des personnes concernées ; "echeance" = date ou moment précis si mentionné, sinon "À faire" (ou "En cours" si l'action est déjà engagée).

Règles de fond :
- Reste strictement fidèle à la transcription : n'invente ni fait, ni chiffre, ni nom, ni échéance.
- Ignore les digressions sans intérêt, les hésitations et le bavardage.
- La transcription automatique peut contenir des erreurs : corrige les mots manifestement mal transcrits d'après le contexte.
- Si un intervenant n'a pas de nom (Intervenant N), parle de lui de façon neutre ("un participant") plutôt que d'utiliser le label.

Règles de forme :
- Français soigné, ton professionnel et factuel, à la troisième personne, au passé composé ou au présent.
- N'utilise jamais de tiret long (—) ni de tiret demi-cadratin (–) ; utilise des virgules, deux-points ou parenthèses.
- Pas de Markdown dans les textes (ni **, ni #).

Réponds uniquement par un objet JSON valide, sans texte autour. Les six clés (sous_titre, objet, participants, synthese, sections, actions) sont toutes au premier niveau de l'objet ; "synthese" ne contient que des chaînes de caractères et se referme par "]" avant la clé "sections". Schéma :
{"sous_titre":"nom court de la réunion","objet":"une phrase qui résume l'objet","participants":["Prénom NOM (rôle si connu)"],"synthese":["paragraphe", "..."],"sections":[{"titre":"...","paragraphes":["...", "..."]}],"actions":[{"action":"...","responsable":"...","echeance":"..."}]}`;

function asParagraphs(v) {
  if (Array.isArray(v)) {
    return v.flatMap((p) => {
      if (typeof p === "string") return [p.trim()];
      if (p && typeof p === "object") return asParagraphs(p.paragraphes || p.contenu || p.texte || p.text);
      return [];
    }).filter(Boolean);
  }
  if (typeof v === "string") return v.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  return [];
}

function cleanDashes(s) { return String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/\*\*/g, ""); }

const REPORT_KEYS = ["sous_titre", "objet", "participants", "synthese", "sections", "actions"];

// Répare une erreur fréquente des modèles : une liste mal refermée qui avale les
// clés suivantes, par ex. "synthese": ["§1", "§2", "sections", [...], "actions", [...]].
function repairReportShape(raw) {
  if (!raw || typeof raw !== "object") return {};
  for (const key of Object.keys(raw)) {
    const arr = raw[key];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const name = typeof item === "string" ? item.trim().toLowerCase() : "";
      if (REPORT_KEYS.includes(name) && name !== key && i + 1 < arr.length && typeof arr[i + 1] !== "string") {
        if (!raw[name] || (Array.isArray(raw[name]) && !raw[name].length)) raw[name] = arr[i + 1];
        i++;
        continue;
      }
      // Une section égarée dans la synthèse : on la replace dans les sections.
      if (key === "synthese" && item && typeof item === "object" && !Array.isArray(item) && item.titre) {
        raw.sections = Array.isArray(raw.sections) ? raw.sections : [];
        raw.sections.push(item);
        continue;
      }
      kept.push(item);
    }
    raw[key] = kept;
  }
  return raw;
}

function reportLooksValid(r) {
  return r.synthese.length > 0 && r.sections.length > 0 && r.sections.every((s) => s.titre && s.paragraphes.length);
}

function normalizeReport(raw, meta) {
  raw = repairReportShape(raw);
  const r = {};
  r.entete = meta.entete;
  r.sous_titre = cleanDashes(meta.titre || raw.sous_titre || "");
  r.date = longDateFR(meta.dateISO);
  r.dateCourte = shortDateFR(meta.dateISO);
  r.objet = cleanDashes(meta.objet || raw.objet || "");
  r.participants = meta.participants.length ? meta.participants
    : (Array.isArray(raw.participants) ? raw.participants.map(cleanDashes).filter(Boolean) : []);
  r.redacteur = meta.redacteur;
  r.synthese = asParagraphs(raw.synthese).map(cleanDashes);
  r.sections = (Array.isArray(raw.sections) ? raw.sections : []).map((s) => ({
    titre: cleanDashes(s && s.titre),
    paragraphes: asParagraphs(s && (s.paragraphes || s.contenu)).map(cleanDashes),
  })).filter((s) => s.titre || s.paragraphes.length);
  r.actions = (Array.isArray(raw.actions) ? raw.actions : []).map((a) => ({
    action: cleanDashes(a && a.action),
    responsable: cleanDashes(a && a.responsable),
    echeance: cleanDashes(a && a.echeance) || "À faire",
  })).filter((a) => a.action);
  return r;
}

// Numérotation commune à l'aperçu, au texte, au Markdown et au .docx.
function reportOutline(r) {
  const out = [{ titre: "Synthèse", paragraphes: r.synthese }];
  for (const s of r.sections) out.push(s);
  return out.map((s, i) => ({ ...s, numero: i + 1 }));
}
function actionsNumber(r) { return reportOutline(r).length + 1; }

function metaRows(r) {
  const rows = [["Date", r.date], ["Objet", r.objet], ["Participants", r.participants.join(", ")]];
  if (r.redacteur) rows.push(["Rédacteur", r.redacteur]);
  return rows.filter(([, v]) => v);
}

function footerMention(r) {
  return `Compte rendu rédigé à partir de la transcription de la réunion du ${r.dateCourte}.`;
}

function renderReportPreview(r) {
  let html = "";
  if (r.entete) html += `<div class="rp-head">${escapeHtml(r.entete)}</div>`;
  html += `<div class="rp-title">Compte rendu de réunion</div>`;
  if (r.sous_titre) html += `<div class="rp-sub">${escapeHtml(r.sous_titre)}</div>`;
  html += `<table class="meta">${metaRows(r).map(([k, v]) => `<tr><td class="lbl">${k}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>`;
  for (const s of reportOutline(r)) {
    html += `<h4>${s.numero}. ${escapeHtml(s.titre)}</h4>`;
    html += s.paragraphes.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }
  if (r.actions.length) {
    html += `<h4>${actionsNumber(r)}. Relevé de décisions et d'actions</h4>`;
    html += `<table class="acts"><tr><th>Action</th><th>Responsable</th><th>Échéance</th></tr>`;
    html += r.actions.map((a) => `<tr><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.responsable)}</td><td>${escapeHtml(a.echeance)}</td></tr>`).join("");
    html += `</table>`;
  }
  html += `<div class="rp-foot">${escapeHtml(footerMention(r))}</div>`;
  $("reportPreview").innerHTML = html;
}

function reportToPlainText(r) {
  const L = [];
  if (r.entete) L.push(r.entete);
  L.push("COMPTE RENDU DE RÉUNION");
  if (r.sous_titre) L.push(r.sous_titre);
  L.push("");
  for (const [k, v] of metaRows(r)) L.push(`${k} : ${v}`);
  for (const s of reportOutline(r)) {
    L.push("", `${s.numero}. ${s.titre.toUpperCase()}`, "");
    L.push(s.paragraphes.join("\n\n"));
  }
  if (r.actions.length) {
    L.push("", `${actionsNumber(r)}. RELEVÉ DE DÉCISIONS ET D'ACTIONS`, "");
    for (const a of r.actions) L.push(`- ${a.action} | Responsable : ${a.responsable || "-"} | Échéance : ${a.echeance}`);
  }
  L.push("", footerMention(r));
  return L.join("\n");
}

function reportToMarkdown(r) {
  const cell = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const L = [];
  if (r.entete) L.push(`*${r.entete}*`, "");
  L.push("# Compte rendu de réunion");
  if (r.sous_titre) L.push(`*${r.sous_titre}*`);
  L.push("");
  for (const [k, v] of metaRows(r)) L.push(`- **${k}** : ${v}`);
  for (const s of reportOutline(r)) {
    L.push("", `## ${s.numero}. ${s.titre}`, "");
    L.push(s.paragraphes.join("\n\n"));
  }
  if (r.actions.length) {
    L.push("", `## ${actionsNumber(r)}. Relevé de décisions et d'actions`, "");
    L.push("| Action | Responsable | Échéance |", "|---|---|---|");
    for (const a of r.actions) L.push(`| ${cell(a.action)} | ${cell(a.responsable)} | ${cell(a.echeance)} |`);
  }
  L.push("", `*${footerMention(r)}*`);
  return L.join("\n") + "\n";
}

// Reproduit la mise en page du modèle de CR IMT-BS / PracTice.
function buildDocx(r) {
  const D = window.docx;
  const run = (text, o = {}) => new D.TextRun({ text: text || "", font: FONT, size: 22, ...o });
  const para = (text, o = {}) => new D.Paragraph({ children: [run(text)], spacing: { after: 140, line: 276 }, ...o });
  const heading = (text) => new D.Paragraph({
    children: [run(text, { bold: true, color: VIOLET, size: 30 })],
    spacing: { before: 320, after: 140 },
    keepNext: true,
  });
  const none = { style: D.BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const line = { style: D.BorderStyle.SINGLE, size: 4, color: "404040" };
  const gridBorders = { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
  const margins = { top: 60, bottom: 60, left: 110, right: 110 };
  const TOTAL = 9360; // largeur utile en twips (A4, marges 2,5 cm environ)

  const children = [];
  if (r.entete) children.push(new D.Paragraph({ children: [run(r.entete, { bold: true, color: BLEU, size: 22 })], spacing: { after: 60 } }));
  children.push(new D.Paragraph({ children: [run("Compte rendu de réunion", { bold: true, color: VIOLET, size: 48 })], spacing: { after: 80 } }));
  if (r.sous_titre) children.push(new D.Paragraph({ children: [run(r.sous_titre, { italics: true, color: "666666", size: 24 })], spacing: { after: 200 } }));

  // Tableau d'identité
  const labelW = Math.round(TOTAL * 0.24);
  children.push(new D.Table({
    width: { size: TOTAL, type: D.WidthType.DXA },
    columnWidths: [labelW, TOTAL - labelW],
    layout: D.TableLayoutType.FIXED,
    borders: noBorders,
    rows: metaRows(r).map(([k, v]) => new D.TableRow({
      children: [
        new D.TableCell({
          width: { size: labelW, type: D.WidthType.DXA },
          shading: { type: D.ShadingType.CLEAR, fill: VIOLET, color: "auto" },
          margins,
          children: [new D.Paragraph({ children: [run(k, { bold: true, color: "FFFFFF", size: 21 })] })],
        }),
        new D.TableCell({
          width: { size: TOTAL - labelW, type: D.WidthType.DXA },
          margins,
          children: [new D.Paragraph({ children: [run(v, { size: 21 })] })],
        }),
      ],
    })),
  }));
  children.push(new D.Paragraph({ children: [run("")], spacing: { after: 120 } }));

  for (const s of reportOutline(r)) {
    children.push(heading(`${s.numero}. ${s.titre}`));
    for (const p of s.paragraphes) children.push(para(p));
  }

  if (r.actions.length) {
    children.push(heading(`${actionsNumber(r)}. Relevé de décisions et d'actions`));
    const w = [Math.round(TOTAL / 3), Math.round(TOTAL / 3), TOTAL - 2 * Math.round(TOTAL / 3)];
    const cell = (text, i, header) => new D.TableCell({
      width: { size: w[i], type: D.WidthType.DXA },
      margins,
      shading: header ? { type: D.ShadingType.CLEAR, fill: VIOLET, color: "auto" } : undefined,
      children: [new D.Paragraph({ children: [run(text, header ? { bold: true, color: "FFFFFF", size: 20 } : { size: 20 })] })],
    });
    const rows = [new D.TableRow({ tableHeader: true, children: ["Action", "Responsable", "Échéance"].map((t, i) => cell(t, i, true)) })];
    for (const a of r.actions) rows.push(new D.TableRow({ cantSplit: true, children: [a.action, a.responsable, a.echeance].map((t, i) => cell(t, i, false)) }));
    children.push(new D.Table({ width: { size: TOTAL, type: D.WidthType.DXA }, columnWidths: w, layout: D.TableLayoutType.FIXED, borders: gridBorders, rows }));
  }

  children.push(new D.Paragraph({ children: [run(footerMention(r), { italics: true, color: "777777", size: 18 })], spacing: { before: 360 } }));

  const doc = new D.Document({
    creator: "IMT Smart Minutes",
    title: "Compte rendu de réunion",
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1300, left: 1270, right: 1270 } } },
      footers: {
        default: new D.Footer({
          children: [new D.Paragraph({
            alignment: D.AlignmentType.RIGHT,
            children: [run("", { size: 16, color: "999999" }), new D.TextRun({ children: [D.PageNumber.CURRENT], font: FONT, size: 16, color: "999999" })],
          })],
        }),
      },
      children,
    }],
  });
  return D.Packer.toBlob(doc);
}

function reportFileBase() {
  const titre = $("metaTitre").value || (state.report && state.report.sous_titre) || "Reunion";
  return `CR_${slugify(titre).slice(0, 50)}_${compactDate($("metaDate").value)}`;
}

async function onReport() {
  showMsg("msgReport", "", "");
  showMsg("msgReportActions", "", "");
  $("spinReport").classList.add("on");
  $("btnReport").disabled = true;
  try {
    const meta = {
      entete: $("metaEntete").value.trim(),
      titre: $("metaTitre").value.trim(),
      dateISO: $("metaDate").value || todayISO(),
      objet: $("metaObjet").value.trim(),
      redacteur: $("metaRedacteur").value.trim(),
      participants: $("metaParticipants").value.split("\n").map((s) => s.trim()).filter(Boolean),
    };
    const user = [
      "Métadonnées de la réunion :",
      `- Date : ${longDateFR(meta.dateISO)}`,
      meta.titre ? `- Nom de la réunion : ${meta.titre}` : "",
      meta.objet ? `- Objet : ${meta.objet}` : "",
      meta.participants.length ? `- Participants : ${meta.participants.join(", ")}` : "- Participants : à déduire de la transcription (n'inclus que les personnes nommées)",
      "",
      "Transcription :",
      plainTranscript(),
    ].filter((l) => l !== "").join("\n");
    const messages = [{ role: "system", content: REPORT_SYSTEM }, { role: "user", content: user }];
    let report = null;
    // Deux essais : si la structure renvoyée est incomplète, on redemande en signalant l'erreur.
    for (let attempt = 1; attempt <= 2 && !report; attempt++) {
      const content = await callWriter(messages, true, 12000, (m) => showMsg("msgReport", "info", escapeHtml(m)));
      let candidate = null;
      try { candidate = normalizeReport(extractJSON(content), meta); } catch (e) { console.warn(e); }
      if (candidate && reportLooksValid(candidate)) { report = candidate; break; }
      if (attempt === 1) {
        showMsg("msgReport", "info", "La première version était mal structurée, nouvelle rédaction en cours…");
        messages.push({ role: "assistant", content: content.slice(0, 4000) });
        messages.push({ role: "user", content: "Ta réponse ne respecte pas le schéma JSON demandé : \"synthese\" doit être une liste de paragraphes (chaînes uniquement), puis \"sections\" et \"actions\" doivent être des clés distinctes au premier niveau de l'objet. Réécris le compte rendu complet en respectant exactement le schéma." });
      } else if (candidate && (candidate.synthese.length || candidate.sections.length)) {
        report = candidate; // mieux vaut un compte rendu partiel que rien
      }
    }
    if (!report) throw new Error("Le compte rendu généré est incomplet. Relancez la génération.");
    state.report = report;
    renderReportPreview(report);
    showMsg("msgReport", "", "");
    $("reportBlock").classList.remove("hidden");
    $("reportBlock").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showMsg("msgReport", "error", humanizeError(err));
  } finally {
    $("spinReport").classList.remove("on");
    $("btnReport").disabled = false;
  }
}

// ----------------------------- Initialisation -----------------------------

document.addEventListener("DOMContentLoaded", () => {
  state.audio = new Audio();
  state.audio.preload = "metadata";
  $("metaDate").value = todayISO();
  $("year").textContent = new Date().getFullYear();

  const saved = storageGet();
  if (saved) { $("apiKey").value = saved; $("rememberKey").checked = true; }
  refreshKeyGate();

  $("apiKey").addEventListener("input", refreshKeyGate);
  $("rememberKey").addEventListener("change", persistKey);
  $("btnToggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("btnToggleKey").textContent = show ? "Masquer" : "Afficher";
  });
  $("btnTestKey").addEventListener("click", async () => {
    if (!apiKey()) { showMsg("msgKey", "error", "Collez d'abord votre clé."); return; }
    const btn = $("btnTestKey");
    btn.disabled = true;
    showMsg("msgKey", "info", "Vérification…");
    try {
      const data = await callModels();
      const ids = (data.data || []).map((m) => String(m.id || "").toLowerCase());
      if (ids.some((id) => id.includes("voxtral"))) showMsg("msgKey", "ok", "Clé valide, la transcription Voxtral est disponible.");
      else showMsg("msgKey", "warn", "Clé valide, mais aucun modèle Voxtral n'apparaît sur ce compte : la transcription risque d'échouer.");
    } catch (err) {
      showMsg("msgKey", "error", humanizeError(err));
    } finally {
      btn.disabled = false;
    }
  });

  // Dépôt du fichier
  const dz = $("dropzone");
  $("audioFile").addEventListener("change", (e) => setFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
  $("btnTranscribe").addEventListener("click", onTranscribe);

  // Transcription
  $("btnIdentify").addEventListener("click", onIdentify);
  $("tabRead").addEventListener("click", () => switchTab(false));
  $("tabEdit").addEventListener("click", () => switchTab(true));
  $("transcriptEditor").addEventListener("input", (e) => { state.text = e.target.value; });
  $("btnCopyTranscript").addEventListener("click", async (e) => {
    const ok = await copyText(plainTranscript());
    ok ? flashButton(e.target, "Copié ✓") : showMsg("msgTranscript", "error", "La copie a échoué : utilisez l'onglet « Modifier le texte » et copiez manuellement.");
  });
  $("btnDownloadTxt").addEventListener("click", () => {
    downloadBlob(new Blob([state.text + "\n"], { type: "text/plain;charset=utf-8" }), transcriptFileBase() + ".txt");
  });
  $("btnDownloadTranscriptMd").addEventListener("click", () => {
    downloadBlob(new Blob([buildTranscriptMarkdown()], { type: "text/markdown;charset=utf-8" }), transcriptFileBase() + ".md");
  });

  // Compte rendu
  $("btnReport").addEventListener("click", onReport);
  $("btnDownloadDocx").addEventListener("click", async () => {
    if (!state.report) return;
    if (!window.docx) { showMsg("msgReportActions", "error", "La librairie Word n'a pas pu être chargée (connexion internet ?). Utilisez « Copier le texte » ou le .md."); return; }
    try {
      downloadBlob(await buildDocx(state.report), reportFileBase() + ".docx");
    } catch (err) {
      console.error(err);
      showMsg("msgReportActions", "error", "La création du fichier Word a échoué : " + escapeHtml(err.message));
    }
  });
  $("btnCopyReport").addEventListener("click", async (e) => {
    if (!state.report) return;
    const ok = await copyText(reportToPlainText(state.report));
    ok ? flashButton(e.target, "Copié ✓") : showMsg("msgReportActions", "error", "La copie a échoué dans ce navigateur.");
  });
  $("btnDownloadReportMd").addEventListener("click", () => {
    if (!state.report) return;
    downloadBlob(new Blob([reportToMarkdown(state.report)], { type: "text/markdown;charset=utf-8" }), reportFileBase() + ".md");
  });
});
