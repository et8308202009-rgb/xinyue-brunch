/**
 * 昕悅／創峰 派車 Worker（Cloudflare Workers）v2
 *
 * 設計原則：能預設的都預設好，你只要把金鑰貼進來就能用。
 *
 * 金鑰優先順序（Lalamove）：
 *   1. Cloudflare KV 裡「該店專屬」的金鑰（總部後台可設定）
 *   2. 環境變數 LALAMOVE_KEY / LALAMOVE_SECRET（全域預設，所有店共用）
 *
 * 地址轉座標：
 *   1. 有 GOOGLE_MAPS_KEY → 用 Google（最準）
 *   2. 沒有 → 自動改用 OpenStreetMap Nominatim（免費、免金鑰）
 *
 * 端點：
 *   GET  /health                     健康檢查（順便回報金鑰設定狀態）
 *   POST /admin/keys                 設定某店專屬金鑰（需 x-admin-token）
 *   GET  /admin/keys?storeId=        查詢某店金鑰狀態（需 x-admin-token）
 *   POST /dispatch                   派車
 */

const LALA_BASE = 'https://rest.lalamove.com';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'XinYue-Dispatch/1.0 (brunch ordering system)';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-admin-token',
  'Access-Control-Max-Age': '86400'
});

const json = (obj, status = 200, env) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS(env || {}) }
  });

/* ---------------- 簽章 / 請求 ---------------- */

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function lalamoveFetch(creds, method, path, bodyObj) {
  const timestamp = Date.now().toString();
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const signature = await hmacHex(creds.apiSecret, `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${body}`);

  const res = await fetch(`${LALA_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `hmac ${creds.apiKey}:${timestamp}:${signature}`,
      Market: creds.market || 'TW',
      'Request-ID': crypto.randomUUID()
    },
    body: bodyObj ? body : undefined
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.raw)) || `HTTP ${res.status}`;
    throw new Error(`Lalamove ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/* ---------------- 地址 → 座標 ---------------- */

async function geocodeGoogle(address, key) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&region=TW&key=${key}`;
  const data = await (await fetch(url)).json();
  if (data.status !== 'OK' || !data.results?.length) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address, provider: 'google' };
}

async function geocodeNominatim(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=tw&accept-language=zh-TW`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), formatted: arr[0].display_name, provider: 'nominatim' };
}

async function geocode(address, googleKey) {
  if (!address) throw new Error('缺少地址');
  if (googleKey) {
    const g = await geocodeGoogle(address, googleKey).catch(() => null);
    if (g) return g;
  }
  const n = await geocodeNominatim(address).catch(() => null);
  if (n) return n;
  throw new Error(`地址定位失敗：${address}（可改用更完整的地址，或設定 GOOGLE_MAPS_KEY）`);
}

/* ---------------- 取金鑰 ---------------- */

async function getStoreCreds(env, storeId) {
  if (env.STORE_KEYS && storeId) {
    const raw = await env.STORE_KEYS.get(`key:${storeId}`).catch(() => null);
    if (raw) {
      try { return { ...JSON.parse(raw), source: 'store' }; } catch (e) {}
    }
  }
  if (env.LALAMOVE_KEY && env.LALAMOVE_SECRET) {
    return {
      apiKey: env.LALAMOVE_KEY,
      apiSecret: env.LALAMOVE_SECRET,
      market: env.LALAMOVE_MARKET || 'TW',
      source: 'global'
    };
  }
  return null;
}

/* ---------------- 路由 ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env) });

    try {
      if (path === '/health') {
        return json({
          ok: true,
          version: 2,
          time: new Date().toISOString(),
          geocoder: env.GOOGLE_MAPS_KEY ? 'google' : 'nominatim (免費備援)',
          globalKey: !!(env.LALAMOVE_KEY && env.LALAMOVE_SECRET),
          kvBound: !!env.STORE_KEYS,
          adminTokenSet: !!env.ADMIN_TOKEN
        }, 200, env);
      }

      if (path === '/admin/keys' && request.method === 'POST') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: '管理密鑰錯誤' }, 401, env);
        }
        const body = await request.json();
        const storeId = (body.storeId || '').trim();
        if (!storeId || !body.apiKey || !body.apiSecret) {
          return json({ ok: false, error: 'storeId / apiKey / apiSecret 皆必填' }, 400, env);
        }
        if (!env.STORE_KEYS) return json({ ok: false, error: '未綁定 KV（STORE_KEYS）' }, 500, env);
        const payload = {
          apiKey: body.apiKey.trim(),
          apiSecret: body.apiSecret.trim(),
          market: (body.market || 'TW').trim().toUpperCase(),
          updatedAt: Date.now()
        };
        await env.STORE_KEYS.put(`key:${storeId}`, JSON.stringify(payload));
        return json({ ok: true, storeId, masked: payload.apiKey.slice(0, 4) + '****' }, 200, env);
      }

      if (path === '/admin/keys' && request.method === 'GET') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: '管理密鑰錯誤' }, 401, env);
        }
        const storeId = (url.searchParams.get('storeId') || '').trim();
        const raw = env.STORE_KEYS && storeId ? await env.STORE_KEYS.get(`key:${storeId}`).catch(() => null) : null;
        const creds = raw ? JSON.parse(raw) : null;
        return json({
          ok: true,
          storeId,
          configured: !!creds,
          usesGlobalKey: !creds && !!(env.LALAMOVE_KEY && env.LALAMOVE_SECRET),
          masked: creds ? creds.apiKey.slice(0, 4) + '****' : (env.LALAMOVE_KEY ? env.LALAMOVE_KEY.slice(0, 4) + '****' : ''),
          market: creds ? creds.market : (env.LALAMOVE_MARKET || 'TW'),
          updatedAt: creds ? creds.updatedAt : 0
        }, 200, env);
      }

      if (path === '/dispatch' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const storeId = (body.storeId || '').trim();
        if (!storeId) return json({ ok: false, error: '缺少 storeId' }, 400, env);

        const creds = await getStoreCreds(env, storeId);
        if (!creds) {
          return json({
            ok: false, code: 'NO_KEY',
            error: '尚未設定 Lalamove 金鑰：請在總部後台填入，或設定環境變數 LALAMOVE_KEY / LALAMOVE_SECRET'
          }, 400, env);
        }

        const pickup = body.pickup || {};
        const dropoff = body.dropoff || {};
        if (!pickup.address || !dropoff.address) {
          return json({ ok: false, error: '缺少取件或送件地址' }, 400, env);
        }

        const [p, d] = await Promise.all([
          geocode(pickup.address, env.GOOGLE_MAPS_KEY),
          geocode(dropoff.address, env.GOOGLE_MAPS_KEY)
        ]);

        const quoteBody = {
          data: {
            serviceType: body.serviceType || env.SERVICE_TYPE || 'MOTORCYCLE',
            specialRequests: [],
            language: 'zh_TW',
            stops: [
              { coordinates: { lat: String(p.lat), lng: String(p.lng) }, address: p.formatted || pickup.address },
              { coordinates: { lat: String(d.lat), lng: String(d.lng) }, address: d.formatted || dropoff.address }
            ],
            deliveries: [{
              toStop: 1,
              toContact: { name: dropoff.name || '顧客', phone: dropoff.phone || '' },
              remarks: body.note || '餐點請小心運送，謝謝'
            }]
          }
        };

        const quote = await lalamoveFetch(creds, 'POST', '/v3/quotations', quoteBody);
        const q = (quote.data && quote.data[0]) || null;
        if (!q) throw new Error('Lalamove 沒有回傳報價');

        const order = await lalamoveFetch(creds, 'POST', '/v3/orders', {
          data: {
            quotationId: q.id,
            senderStopId: q.stops[0].stopId,
            recipientStopId: q.stops[1].stopId,
            remarks: body.note || ''
          }
        });

        return json({
          ok: true,
          storeId,
          orderRef: (order.data && (order.data.orderId || order.data.id)) || '',
          quotationId: q.id,
          price: q.priceBreakdown ? q.priceBreakdown.total : null,
          currency: (q.priceBreakdown && q.priceBreakdown.currency) || 'TWD',
          distance: q.distance ? q.distance.value : null,
          keySource: creds.source,
          geocoder: p.provider
        }, 200, env);
      }

      return json({ ok: false, error: 'Not Found' }, 404, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500, env);
    }
  }
};
