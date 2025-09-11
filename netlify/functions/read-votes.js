// netlify/functions/read-votes.js
// Requiert deux variables d'env sur Netlify :
// - NETLIFY_TOKEN : Personal Access Token (User settings → Applications → New token)
// - SITE_ID       : Settings → Site details → "API ID"

exports.handler = async (event) => {
  try {
    const { NETLIFY_TOKEN, MY_SITE_ID } = process.env;
    const SITE_ID = MY_SITE_ID;

    if (!NETLIFY_TOKEN || !SITE_ID) {
      return { statusCode: 500, body: 'Missing NETLIFY_TOKEN or SITE_ID' };
    }

    const tf = (new URL(event.rawUrl).searchParams.get('tf') || '1D').toUpperCase();
    const lookbackMs = ({
      '1H': 60*60*1000,
      '1D': 24*60*60*1000,
      '7D': 7*24*60*60*1000,
      '90D': 90*24*60*60*1000,
      '1Y': 365*24*60*60*1000,
    })[tf] || 24*60*60*1000;

    // 1) Trouver l'ID du form "vote"
    const formsResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    });
    const forms = await formsResp.json();
    const form = Array.isArray(forms) ? forms.find(f => f.name === 'vote') : null;
    if (!form) return { statusCode: 404, body: 'Form "vote" not found' };

    // 2) Récup soumissions (pagination simple jusqu’à 1000)
    const subsResp = await fetch(`https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`, {
      headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }
    });
    const subs = await subsResp.json();

    // 3) Filtrer sur la fenêtre temps & formater
    const now = Date.now();
    const rows = subs
      .map(s => ({ t: Date.parse(s.created_at), v: Number(s.data?.value) }))
      .filter(r => !Number.isNaN(r.t) && !Number.isNaN(r.v))
      .filter(r => now - r.t <= lookbackMs);

    // 4) Buckets par période
    const bucketMs = (()=>{
      if (tf==='1H') return 60*1000;          // 1 min
      if (tf==='1D') return 5*60*1000;        // 5 min
      if (tf==='7D') return 30*60*1000;       // 30 min
      if (tf==='90D') return 24*60*60*1000;   // 1 jour
      if (tf==='1Y') return 24*60*60*1000;    // 1 jour
      return 5*60*1000;
    })();

    // Grouper et moyenner
    const map = new Map();
    for (const r of rows){
      const b = Math.floor(r.t / bucketMs) * bucketMs;
      const cur = map.get(b) || { sum:0, n:0 };
      cur.sum += r.v; cur.n += 1;
      map.set(b, cur);
    }
    const buckets = Array.from(map.entries()).sort((a,b)=>a[0]-b[0]).map(([t,{sum,n}]) => ({
      t: new Date(t).toISOString().slice(0, (tf==='1H'||tf==='1D'||tf==='7D') ? 16 : 10),
      v: +(sum/n).toFixed(1)
    }));

    // Lissage EMA léger pour un rendu propre
    const ema = (arr, a=0.2)=>{ let p = arr[0] ?? 50; return arr.map(x => p = a*x + (1-a)*p); };
    const smVals = ema(buckets.map(b=>b.v), tf==='1H'?0.25:(tf==='1D'?0.2:(tf==='7D'?0.15:0.12)));
    const points = buckets.map((b,i)=>({ t:b.t, v:+smVals[i].toFixed(1) }));
    const current = Math.round(points.at(-1)?.v ?? 50);

    return {
      statusCode: 200,
      headers: { 'content-type':'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ current, points })
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
