/**
 * IMT Smart Minutes — Proxy Cloudflare Worker
 * -------------------------------------------
 * Relaie les demandes de rédaction (compte rendu, noms des intervenants) de
 * l'application (GitHub Pages) vers ILAAS, service d'inférence souverain
 * compatible OpenAI. La clé ILAAS vit uniquement dans les secrets du Worker :
 * elle n'apparaît ni dans le code, ni dans le navigateur.
 *
 * Corps attendu (POST, JSON) :
 *   { "messages": [...], "max_tokens": 12000, "response_format": { "type": "json_object" } }
 *
 * Réponse : le flux SSE d'ILAAS relayé tel quel (le navigateur le réassemble).
 * Relayer sans parser évite la coupure de la passerelle ILAAS (~60 s
 * d'inactivité) et la limite CPU de 10 ms du plan Workers gratuit.
 */

const ALLOWED_ORIGINS = [
  "https://practice-imtbs.github.io",
  "http://localhost:8765",
];

const MAX_TOKENS_CAP = 16000;
const MAX_BODY_BYTES = 1_500_000; // ~ 3 h de réunion transcrite

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // Le proxy ne sert que l'application : on refuse les autres origines.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: { message: "Origine non autorisée" } }, 403, origin);
    }
    // Liste des modèles disponibles (identifiants seulement), pour vérifier la configuration.
    if (request.method === "GET" && new URL(request.url).pathname === "/models") {
      const res = await fetch(env.ILAAS_BASE.replace(/\/$/, "") + "/models", {
        headers: { Authorization: "Bearer " + env.ILAAS_API_KEY },
      });
      const data = await res.json().catch(() => ({}));
      const ids = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
      return json({ status: res.status, configured: env.ILAAS_MODEL, models: ids }, res.ok ? 200 : res.status, origin);
    }
    if (request.method !== "POST") {
      return json({ error: { message: "Méthode non autorisée" } }, 405, origin);
    }
    if (!env.ILAAS_BASE || !env.ILAAS_API_KEY || !env.ILAAS_MODEL) {
      return json({ error: { message: "Proxy mal configuré (clé ou modèle ILAAS manquant)" } }, 500, origin);
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return json({ error: { message: "Transcription trop longue pour la rédaction" } }, 413, origin);
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return json({ error: { message: "Corps JSON invalide" } }, 400, origin);
    }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return json({ error: { message: "Aucun message à traiter" } }, 400, origin);
    }

    // Le modèle est imposé par le Worker : le navigateur ne peut pas en changer.
    const upstreamBody = {
      model: env.ILAAS_MODEL,
      messages: payload.messages.map((m) => ({ role: String(m.role), content: String(m.content) })),
      max_tokens: Math.min(Number(payload.max_tokens) || 8000, MAX_TOKENS_CAP),
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.2,
      stream: true,
    };
    if (payload.response_format && payload.response_format.type === "json_object") {
      upstreamBody.response_format = { type: "json_object" };
    }

    let upstream;
    try {
      upstream = await fetch(env.ILAAS_BASE.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.ILAAS_API_KEY },
        body: JSON.stringify(upstreamBody),
      });
    } catch (e) {
      return json({ error: { message: "ILAAS injoignable : " + e.message } }, 502, origin);
    }

    const contentType = upstream.headers.get("Content-Type") || "";
    if (upstream.ok && contentType.includes("text/event-stream")) {
      return new Response(upstream.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...corsHeaders(origin) },
      });
    }

    // Erreur (ou réponse non streamée) : on renvoie un JSON lisible.
    const raw = await upstream.text();
    if (/^\s*</.test(raw)) {
      const timeout = /gateway time-?out|didn't respond in time/i.test(raw);
      return json({ error: { message: timeout ? "TIMEOUT" : "Réponse ILAAS inattendue (" + upstream.status + ")" } }, timeout ? 504 : 502, origin);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json({ error: { message: "Réponse ILAAS illisible (" + upstream.status + ")" } }, 502, origin);
    }
    if (!upstream.ok) {
      const message = (data.error && (data.error.message || data.error)) || data.message || "Erreur ILAAS (" + upstream.status + ")";
      return json({ error: { message: typeof message === "string" ? message : JSON.stringify(message) } }, upstream.status, origin);
    }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return json({ content: typeof text === "string" ? text : "" }, 200, origin);
  },
};
