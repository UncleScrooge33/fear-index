// netlify/functions/read-votes.js
// Env vars requises : NETLIFY_TOKEN (+ optionnel MY_SITE_ID si SITE_ID non injecté)

exports.handler = async (event) => {
  try {
    const TOKEN   = process.env.NETLIFY_TOKEN;
    const SITE_ID = process.env.SITE_ID || process.env.MY_SITE_ID;
    if (!TOKEN || !SITE_ID) return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };

    const url = new URL(event.rawUrl);
    const tf  = (url.searchParams.get('tf') || '1D').toUpperCase();
    const includeSpam = url.searchParams.get('includeSpam') === '1'; // ignoré côté front

    // Buckets terminés uniquement ; point = moyenne glissante des 5 dernières moyennes de bucket
    const cfg = {
      '1H':  { spanMs: 60*60*1000,         stepMs: 1*60*1000,      fmt: d=>d.toISOString().slice(11,16) }, // HH:MM
      '1D':  { spanMs: 24*60*60*1000,      stepMs: 30*60*1000,     fmt: d=>d.toISOString().slice(11,16) },
      '7D':  { spanMs: 7*24*60*60*1000,    stepMs: 8*60*60*1000,   fmt: d=>d.toISOString().slice(5,10)  }, // MM-DD
      '1M':  { spanMs: 30*24*60*60*1000,   stepMs: 24*60*60*1000,  fmt: d=>d.toISOString().slice(0,10)  }, // YYYY-MM-DD (1 jour)
      '90D': { spanMs: 90*24*60*60*1000,   stepMs: 3*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10)  },
      '1Y':  { spanMs: 365*24*60*60*1000,  stepMs: 14*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10) },
    }[tf] || { spanMs: 24*60*60*1000, stepMs: 30*60*1000, fmt: d=>d.toISOString().slice(11,16) };

    const now = Date.now();
    const alignedNow = Math.floor(now / cfg.stepMs) * cfg.stepMs;
    const endClosed  = alignedNow - cfg.stepMs;              // dernier bucket terminé
    const start      = endClosed - cfg.spanMs + cfg.stepMs;  // bord gauche

    // 1) Form "vote" le plus récent
    const formsResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const forms = await formsResp.json();
    const form = (Array.isArray(forms) ? forms : [])
      .filter(f => f.name === 'vote')
      .sort((a,b)=> new Date(b.created_at) - new Date(a.created_at))[0];
    if (!form) return { statusCode: 404, body: 'Form "vote" not found' };

    // 2) Submissions
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const baseUrl = `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`;
    let subs = await fetch(baseUrl, { headers }).then(r=>r.json());
    if (includeSpam) {
      const spam = await fetch(baseUrl + '&state=spam', { headers }).then(r=>r.json());
      subs = subs.concat(spam);
    }

    // 3) Fenêtre + normalisation
    const rows = (Array.isArray(subs) ? subs : [])
      .map(s => {
        const t = Date.parse(s.created_at);
        const raw = s.data?.value ?? s.data?.choice;
        const v = Number(raw);
        return { t, v };
      })
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v) && r.t >= start && r.t <= endClosed)
      .sort((a,b)=>a.t-b.t);

    // 4) Buckets fixes
    const buckets = [];
    for (let t = start; t <= endClosed; t += cfg.stepMs) buckets.push({ t, vals: [] });

    const firstTs = start;
    for (const r of rows) {
      const idx = Math.floor((r.t - firstTs) / cfg.stepMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].vals.push(r.v);
    }

    // Moyenne simple par bucket (carry-forward si vide)
    const bucketMeans = [];
    let lastMean = 50;
    for (const b of buckets) {
      let m;
      if (b.vals.length > 0) m = b.vals.reduce((a,c)=>a+c,0) / b.vals.length;
      else m = lastMean;
      m = Math.max(0, Math.min(100, m));
      bucketMeans.push({ t: b.t, m, n: b.vals.length });
      lastMean = m;
    }

    // 5) Point = moyenne glissante des 5 dernières moyennes de bucket
    const points = [];
    for (let i=0; i<bucketMeans.length; i++){
      const windowStart = Math.max(0, i-4);
      const slice = bucketMeans.slice(windowStart, i+1);
      const avg = slice.reduce((a,c)=>a+c.m, 0) / slice.length;
      points.push({ t: cfg.fmt(new Date(bucketMeans[i].t)), v: +avg.toFixed(1), n: bucketMeans[i].n });
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
