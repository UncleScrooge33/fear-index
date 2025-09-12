// netlify/functions/read-votes.js
// Requiert des variables d'env sur Netlify :
// - NETLIFY_TOKEN : Personal Access Token (User settings → Applications → New token)
// - (optionnel) MY_SITE_ID : Settings → Site details → "API ID"
//   -> Le runtime Netlify injecte souvent SITE_ID automatiquement côté Functions.
//      On lit donc d'abord process.env.SITE_ID puis MY_SITE_ID en fallback.

exports.handler = async (event) => {
  try {
    const TOKEN   = process.env.NETLIFY_TOKEN;
    const SITE_ID = process.env.SITE_ID || process.env.MY_SITE_ID; // priorité à SITE_ID si présent
    if (!TOKEN || !SITE_ID) {
      return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };
    }

    const url = new URL(event.rawUrl);
    const tf  = (url.searchParams.get('tf') || '1D').toUpperCase();
    const includeSpam = url.searchParams.get('includeSpam') === '1';

    // Config d’échantillonnage demandée
    // 1H : 1 min ; 1D : 30 min ; 7D : 8 h ; 90D : 3 jours ; 1Y : 2 semaines
    const cfg = {
      '1H':  { spanMs: 60*60*1000,        stepMs: 1*60*1000,   fmt: (d)=> d.toISOString().slice(11,16) }, // HH:MM
      '1D':  { spanMs: 24*60*60*1000,     stepMs: 30*60*1000,  fmt: (d)=> d.toISOString().slice(11,16) }, // HH:MM
      '7D':  { spanMs: 7*24*60*60*1000,   stepMs: 8*60*60*1000,fmt: (d)=> d.toISOString().slice(5,10)  }, // MM-DD
      '90D': { spanMs: 90*24*60*60*1000,  stepMs: 3*24*60*60*1000, fmt: (d)=> d.toISOString().slice(0,10) }, // YYYY-MM-DD
      '1Y':  { spanMs: 365*24*60*60*1000, stepMs: 14*24*60*60*1000,fmt: (d)=> d.toISOString().slice(0,10) }, // YYYY-MM-DD
    }[tf] || { spanMs: 24*60*60*1000, stepMs: 30*60*1000, fmt: (d)=> d.toISOString().slice(11,16) };

    const now = Date.now();
    // On aligne le "bord droit" sur un multiple du pas pour que la dernière graduation corresponde exactement
    const alignedNow = Math.floor(now / cfg.stepMs) * cfg.stepMs;
    // Bord gauche = now - span + step (ex: à 17:43 en 1H → 16:43)
    const start = alignedNow - cfg.spanMs + cfg.stepMs;

    // --- 1) Récupérer le form "vote" le plus récent ---
    const formsResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const forms = await formsResp.json();
    const form = (Array.isArray(forms) ? forms : [])
      .filter(f => f.name === 'vote')
      .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at))[0];
    if (!form) return { statusCode: 404, body: 'Form "vote" not found' };

    // --- 2) Submissions (verified + spam si demandé) ---
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const baseUrl = `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`;
    const verResp = await fetch(baseUrl, { headers });
    let subs = await verResp.json();
    if (includeSpam) {
      const spamResp = await fetch(baseUrl + '&state=spam', { headers });
      const spam = await spamResp.json();
      subs = subs.concat(spam);
    }

    // --- 3) Filtrer sur la fenêtre et normaliser les valeurs ---
    const rows = (Array.isArray(subs) ? subs : [])
      .map(s => {
        const t = Date.parse(s.created_at);
        // On accepte value ou choice (compat anciens tests)
        const raw = s.data?.value ?? s.data?.choice;
        const v = Number(raw);
        return { t, v };
      })
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v) && r.t >= start && r.t <= alignedNow)
      .sort((a,b)=> a.t - b.t);

    // --- 4) Construire tous les buckets fixes + moyenne + carry-forward ---
    const buckets = [];
    for (let t = start; t <= alignedNow; t += cfg.stepMs) {
      buckets.push({ t, sum:0, n:0 });
    }

    const firstTs = start;
    for (const r of rows) {
      const idx = Math.floor((r.t - firstTs) / cfg.stepMs);
      if (idx >= 0 && idx < buckets.length) {
        buckets[idx].sum += r.v;
        buckets[idx].n   += 1;
      }
    }

    const points = [];
    let prev = 50; // valeur de départ si aucun vote encore
    for (const b of buckets) {
      const avg = b.n ? (b.sum / b.n) : prev; // carry-forward si pas de vote
      prev = avg;
      points.push({ t: cfg.fmt(new Date(b.t)), v: +avg.toFixed(1) });
    }

    const current = Math.round(points.at(-1)?.v ?? 50);

    return {
      statusCode: 200,
      headers: { 'content-type':'application/json', 'cache-control':'no-store' },
      body: JSON.stringify({
        current,
        points,
        meta: { tf, start, end: alignedNow, stepMs: cfg.stepMs }
      })
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
