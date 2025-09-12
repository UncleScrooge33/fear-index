// netlify/functions/read-votes.js
// Env vars requises :
// - NETLIFY_TOKEN : Personal Access Token (User settings → Applications → New token)
// - (optionnel) MY_SITE_ID : API ID du site (fallback si SITE_ID non injecté)

exports.handler = async (event) => {
  try {
    const TOKEN   = process.env.NETLIFY_TOKEN;
    const SITE_ID = process.env.SITE_ID || process.env.MY_SITE_ID;
    if (!TOKEN || !SITE_ID) {
      return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };
    }

    const url = new URL(event.rawUrl);
    const tf  = (url.searchParams.get('tf') || '1D').toUpperCase();
    const includeSpam = url.searchParams.get('includeSpam') === '1';

    // Config par timeframe : span/step + inertie
    // baseAlpha = poids max donné au bucket quand il a assez de votes
    // nRef = nombre de votes ~référence pour atteindre baseAlpha
    // K = nb de points passés pour la moyenne longue (β)
    // maxDelta = limite d'évolution par bucket (optionnelle et raisonnable)
    const cfg = {
      '1H':  { spanMs: 60*60*1000,        stepMs: 1*60*1000,    fmt: d=>d.toISOString().slice(11,16), baseAlpha: 0.45, nRef: 25, K: 6,  beta: 0.20, maxDelta: 12 },
      '1D':  { spanMs: 24*60*60*1000,     stepMs: 30*60*1000,   fmt: d=>d.toISOString().slice(11,16), baseAlpha: 0.40, nRef: 60, K: 6,  beta: 0.22, maxDelta: 10 },
      '7D':  { spanMs: 7*24*60*60*1000,   stepMs: 8*60*60*1000, fmt: d=>d.toISOString().slice(5,10),  baseAlpha: 0.35, nRef:120, K: 5,  beta: 0.24, maxDelta: 9  },
      '90D': { spanMs: 90*24*60*60*1000,  stepMs: 3*24*60*60*1000, fmt:d=>d.toISOString().slice(0,10), baseAlpha: 0.32, nRef:160, K: 4,  beta: 0.25, maxDelta: 8  },
      '1Y':  { spanMs: 365*24*60*60*1000, stepMs: 14*24*60*60*1000,fmt:d=>d.toISOString().slice(0,10), baseAlpha: 0.28, nRef:220, K: 4,  beta: 0.25, maxDelta: 7  },
    }[tf] || { spanMs: 24*60*60*1000, stepMs: 30*60*1000, fmt: d=>d.toISOString().slice(11,16), baseAlpha: 0.40, nRef: 60, K: 6, beta: 0.22, maxDelta: 10 };

    const now = Date.now();
    const alignedNow = Math.floor(now / cfg.stepMs) * cfg.stepMs;
    const endClosed  = alignedNow - cfg.stepMs;              // dernier bucket TERMINÉ (immutabilité)
    const start      = endClosed - cfg.spanMs + cfg.stepMs;  // première graduation fixe

    // 1) Form "vote" le plus récent
    const formsResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const forms = await formsResp.json();
    const form = (Array.isArray(forms) ? forms : [])
      .filter(f => f.name === 'vote')
      .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at))[0];
    if (!form) return { statusCode: 404, body: 'Form "vote" not found' };

    // 2) Submissions (verified + spam si demandé)
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const baseUrl = `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`;
    let subs = await fetch(baseUrl, { headers }).then(r=>r.json());
    if (includeSpam) {
      const spam = await fetch(baseUrl + '&state=spam', { headers }).then(r=>r.json());
      subs = subs.concat(spam);
    }

    // 3) Filtre fenêtre [start, endClosed] + normalisation
    const rows = (Array.isArray(subs) ? subs : [])
      .map(s => {
        const t = Date.parse(s.created_at);
        const raw = s.data?.value ?? s.data?.choice; // accepte value ou choice
        const v = Number(raw);
        return { t, v };
      })
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v) && r.t >= start && r.t <= endClosed)
      .sort((a,b)=>a.t-b.t);

    // 4) Buckets fixes + listes de valeurs
    const buckets = [];
    for (let t = start; t <= endClosed; t += cfg.stepMs) {
      buckets.push({ t, vals: [] });
    }
    const firstTs = start;
    for (const r of rows) {
      const idx = Math.floor((r.t - firstTs) / cfg.stepMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].vals.push(r.v);
    }

    // 5) Append-only avec inertie (EWMA + moyenne des K derniers points)
    const points = [];
    let prev = 50;                 // dernier point émis
    const lastVals = [];           // mémoire des derniers points pour moyenne long terme

    for (const b of buckets) {
      let bucketMean;
      if (b.vals.length > 0) {
        const sum = b.vals.reduce((a,c)=>a+c,0);
        bucketMean = sum / b.vals.length;       // aucune exclusion : tous les votes comptent
      } else {
        bucketMean = prev;                      // 0 vote → on propage
      }

      // α effectif augmente avec le volume du bucket (plus de votes → plus réactif)
      const alphaEff = Math.min(cfg.baseAlpha, cfg.baseAlpha * (b.vals.length / cfg.nRef));

      // Inertie courte : mélange point précédent & moyenne du bucket
      let proposed = (1 - alphaEff) * prev + alphaEff * bucketMean;

      // Inertie longue : moyenne des K derniers points
      if (lastVals.length > 0) {
        const Kmean = lastVals.reduce((a,c)=>a+c,0) / lastVals.length;
        proposed = (1 - cfg.beta) * proposed + cfg.beta * Kmean;
      }

      // Limite d'évolution par bucket (optionnelle mais évite un bond absurde)
      const delta = proposed - prev;
      const cap = cfg.maxDelta;
      if (Math.abs(delta) > cap) {
        proposed = prev + Math.sign(delta) * cap;
      }

      // Clamp final 0..100
      proposed = Math.max(0, Math.min(100, proposed));

      prev = proposed;
      lastVals.push(proposed);
      if (lastVals.length > cfg.K) lastVals.shift();

      points.push({ t: cfg.fmt(new Date(b.t)), v: +proposed.toFixed(1) });
    }

    const current = Math.round(points.at(-1)?.v ?? 50);

    return {
      statusCode: 200,
      headers: { 'content-type':'application/json', 'cache-control':'no-store' },
      body: JSON.stringify({
        current,
        points,
        meta: { tf, start, end: endClosed, stepMs: cfg.stepMs }
      })
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
