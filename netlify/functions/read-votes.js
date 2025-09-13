// netlify/functions/read-votes.js
// Env vars : NETLIFY_TOKEN (+ optionnel MY_SITE_ID si SITE_ID non injecté)

exports.handler = async (event) => {
  try {
    const TOKEN   = process.env.NETLIFY_TOKEN;
    const SITE_ID = process.env.SITE_ID || process.env.MY_SITE_ID;
    if (!TOKEN || !SITE_ID) return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };

    const url = new URL(event.rawUrl);
    const tf  = (url.searchParams.get('tf') || '1D').toUpperCase();

    // Buckets terminés ; si aucun vote → mean=50 ; point = moyenne glissante des 5 dernières mean(buckets)
    const cfg = {
      '1H':  { spanMs: 60*60*1000,         stepMs: 1*60*1000,      fmt: d=>d.toISOString().slice(11,16) }, // HH:MM
      '1D':  { spanMs: 24*60*60*1000,      stepMs: 30*60*1000,     fmt: d=>d.toISOString().slice(11,16) },
      '7D':  { spanMs: 7*24*60*60*1000,    stepMs: 8*60*60*1000,   fmt: d=>d.toISOString().slice(5,10)  }, // MM-DD
      '1M':  { spanMs: 30*24*60*60*1000,   stepMs: 24*60*60*1000,  fmt: d=>d.toISOString().slice(0,10)  }, // YYYY-MM-DD
      '90D': { spanMs: 90*24*60*60*1000,   stepMs: 3*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10)  },
      '1Y':  { spanMs: 365*24*60*60*1000,  stepMs: 14*24*60*60*1000,fmt: d=>d.toISOString().slice(0,10) },
    }[tf] || { spanMs: 24*60*60*1000, stepMs: 30*60*1000, fmt: d=>d.toISOString().slice(11,16) };

    const now = Date.now();
    const alignedNow = Math.floor(now / cfg.stepMs) * cfg.stepMs;
    const endClosed  = alignedNow - cfg.stepMs;              // dernier bucket terminé
    const start      = endClosed - cfg.spanMs + cfg.stepMs;  // bord gauche (visible)
    const bufferCnt  = 4;                                    // ⟵ Important : buffer avant fenêtre
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

    // 2) Submissions
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const baseUrl = `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`;
    let subs = await fetch(baseUrl, { headers }).then(r=>r.json());

    // 3) Fenêtre [startWithBuffer, endClosed] + normalisation
    const rows = (Array.isArray(subs) ? subs : [])
      .map(s => {
        const t = Date.parse(s.created_at);
        const raw = s.data?.value ?? s.data?.choice;
        const v = Number(raw);
        return { t, v };
      })
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v) && r.t >= startWithBuffer && r.t <= endClosed)
      .sort((a,b)=>a.t-b.t);

    // 4) Buckets fixes depuis le buffer
    const buckets = [];
    for (let t = startWithBuffer; t <= endClosed; t += cfg.stepMs) buckets.push({ t, vals: [] });

    const firstTs = startWithBuffer;
    for (const r of rows) {
      const idx = Math.floor((r.t - firstTs) / cfg.stepMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].vals.push(r.v);
    }

    // mean par bucket (no vote => 50)
    const means = buckets.map(b => {
      const n = b.vals.length;
      const m = n ? (b.vals.reduce((a,c)=>a+c,0) / n) : 50;
      return { t:b.t, mean: Math.max(0, Math.min(100, m)), n };
    });

    // 5) Lissage "5-last" indépendant de la fenêtre visible : utilise le buffer
    const smoothed = means.map((_, i) => {
      const from = Math.max(0, i-4), to = i; // inclus
      const slice = means.slice(from, to+1);
      const avg = slice.reduce((a,c)=>a+c.mean, 0) / slice.length;
      return { t: means[i].t, v: +avg.toFixed(1), n: means[i].n };
    });

    // 6) On ne renvoie que la partie visible (t >= start)
    const visible = smoothed.filter(p => p.t >= start);
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
