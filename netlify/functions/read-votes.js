// netlify/functions/read-votes.js
// Env vars : NETLIFY_TOKEN (+ optionnel MY_SITE_ID si SITE_ID non injecté)

exports.handler = async (event) => {
  try {
    const TOKEN   = process.env.NETLIFY_TOKEN;
    const SITE_ID = process.env.SITE_ID || process.env.MY_SITE_ID;
    if (!TOKEN || !SITE_ID) return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };

    const url = new URL(event.rawUrl);
    const tf  = (url.searchParams.get('tf') || '1D').toUpperCase();

    // Périodes (buckets terminés uniquement) + alpha EMA par échelle
    const cfg = {
      '1H':  { spanMs: 60*60*1000,         stepMs: 1*60*1000,      fmt: d=>d.toISOString().slice(11,16), alpha: 0.35 },
      '1D':  { spanMs: 24*60*60*1000,      stepMs: 30*60*1000,     fmt: d=>d.toISOString().slice(11,16), alpha: 0.30 },
      '7D':  { spanMs: 7*24*60*60*1000,    stepMs: 8*60*60*1000,   fmt: d=>d.toISOString().slice(5,10),  alpha: 0.28 },
      '1M':  { spanMs: 30*24*60*60*1000,   stepMs: 24*60*60*1000,  fmt: d=>d.toISOString().slice(0,10),  alpha: 0.25 },
      '90D': { spanMs: 90*24*60*60*1000,   stepMs: 3*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10),  alpha: 0.22 },
      '1Y':  { spanMs: 365*24*60*60*1000,  stepMs: 14*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10), alpha: 0.20 },
    }[tf] || { spanMs: 24*60*60*1000, stepMs: 30*60*1000, fmt: d=>d.toISOString().slice(11,16), alpha: 0.30 };

    const now = Date.now();
    const alignedNow = Math.floor(now / cfg.stepMs) * cfg.stepMs;
    const endClosed  = alignedNow - cfg.stepMs;              // dernier bucket terminé
    const start      = endClosed - cfg.spanMs + cfg.stepMs;  // début de fenêtre visible

    // Buffer (pré-chauffe EMA pour éviter l'effet de bord)
    const bufferCnt  = 4;
    const startWithBuffer = start - bufferCnt * cfg.stepMs;

    // 1) Form "vote" le plus récent
    const formsResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const forms = await formsResp.json();
    const form = (Array.isArray(forms) ? forms : [])
      .filter(f => f.name === 'vote')
      .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at))[0];
    if (!form) return { statusCode: 404, body: 'Form "vote" not found' };

    // 2) Submissions (verified)
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const baseUrl = `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`;
    let subs = await fetch(baseUrl, { headers }).then(r=>r.json());

    // 3) Filtre fenêtre [startWithBuffer, endClosed] + normalisation
    const rows = (Array.isArray(subs) ? subs : [])
      .map(s => {
        const t = Date.parse(s.created_at);
        const v = Number(s.data?.value ?? s.data?.choice);
        return { t, v };
      })
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v) && r.t >= startWithBuffer && r.t <= endClosed)
      .sort((a,b)=>a.t-b.t);

    // 4) Buckets fixes (nous allons y ajouter baseline simulée)
    const buckets = [];
    for (let t = startWithBuffer; t <= endClosed; t += cfg.stepMs) buckets.push({ t, vals: [] });

    const firstTs = startWithBuffer;
    for (const r of rows) {
      const idx = Math.floor((r.t - firstTs) / cfg.stepMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].vals.push(r.v);
    }

    // --- utilitaires pour baseline déterministe par bucket ---
    function djb2hash(str){
      let h = 5381;
      for (let i=0;i<str.length;i++) h = ((h << 5) + h) + str.charCodeAt(i); // h * 33 + c
      return Math.abs(h);
    }
    function baselineForTimestamp(ts){
      // ts est le timestamp du début du bucket (number)
      // retourne { count: 10..40, mean: 40.00..45.00 }
      const s = String(ts);
      const h = djb2hash(s + '_base_v1'); // stable entre appels
      const count = 10 + (h % 31); // 10..40
      // pour la mean, on veut 40.00 .. 45.00 avec 2 décimales
      const h2 = djb2hash(s + '_mean_v1');
      const centi = h2 % 501; // 0..500 -> 0.00..5.00
      const mean = 40 + (centi / 100);
      return { count, mean: Math.round(mean * 100) / 100 };
    }

    // 5) Calcul des raw means A) réels B) baseline C) combinaison
    const raw = buckets.map(b => {
      const nReal = b.vals.length;
      const sumReal = nReal ? b.vals.reduce((a,c)=>a+c,0) : 0;
      const realMean = nReal ? (sumReal / nReal) : null;

      // baseline simulée (déterministe)
      const { count: baseCount, mean: baseMean } = baselineForTimestamp(b.t);

      // combine baseline + réels
      if (nReal && nReal > 0) {
        const combinedCount = baseCount + nReal;
        const combinedMean = ((baseMean * baseCount) + sumReal) / combinedCount;
        return { t: b.t, mean: Math.max(0, Math.min(100, combinedMean)), n: combinedCount };
      } else {
        // pas de votes réels -> on affiche la baseline
        return { t: b.t, mean: Math.max(0, Math.min(100, baseMean)), n: baseCount };
      }
    });

    // 6) EMA : y[i] = α*raw[i] + (1-α)*y[i-1]
    const a = cfg.alpha;
    const ema = [];
    let prev = raw.length ? raw[0].mean : 50; // init EMA
    ema.push({ t: raw[0]?.t ?? startWithBuffer, v: +prev.toFixed(1), n: raw[0]?.n ?? 0 });
    for (let i=1; i<raw.length; i++){
      const y = a*raw[i].mean + (1-a)*prev;
      prev = y;
      ema.push({ t: raw[i].t, v: +y.toFixed(1), n: raw[i].n });
    }

    // 7) Ne renvoyer que la partie visible (t >= start)
    const visible = ema.filter(p => p.t >= start);
    const current = Math.round(visible.at(-1)?.v ?? 50);

    return {
      statusCode: 200,
      headers: { 'content-type':'application/json', 'cache-control':'no-store' },
      body: JSON.stringify({
        current,
        points: visible.map(p => ({ t: cfg.fmt(new Date(p.t)), v: p.v, n: p.n })),
        meta: { tf, start, end: endClosed, stepMs: cfg.stepMs }
      })
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
