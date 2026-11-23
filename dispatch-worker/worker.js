/**
 * 昕悅／創峰 派車 Worker（Cloudflare Workers）
 *
 * 職責：
 *   1. 保管每家店的 Lalamove API Key（存在 KV，前端永遠拿不到）
 *   2. 收到「一鍵派車」請求 → 地址轉座標 → 向 Lalamove 詢價 → 成立訂單
 *   3. 回傳單號與運費給網頁，由網頁寫回訂單
 *
 * 端點：
 *   POST /admin/keys   設定某店的 Lalamove 金鑰（需 x-admin-token）
 *   GET  /admin/keys?storeId=xxx   查詢是否已設定（需 x-admin-token）
 *   POST /dispatch     派車（店家網頁呼叫）
 *   GET  /health       健康檢查
 *
 * 環境變數（wrangler secret / vars）：
 *   ADMIN_TOKEN      總部管理密鑰（自己訂一組長字串）
 *   GOOGLE_MAPS_KEY  地址轉座標用（Google Geocoding API）
 *   ALLOWED_ORIGIN   允許的網址，預設 https://et8308202009-rgb.github.io
 *   KV 綁定 STORE_KEYS
 */

const LALA_BASE = 'https://rest.lalamove.com';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://et8308202009-rgb.github.io',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-admin-token',
  'Access-Control-Max-Age': '86400'
});

const json = (obj, status = 200, env) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS(env || {}) }
  });

/* ---------------- 工具 ---------------- */

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Lalamove v3 簽章：Authorization: hmac key:timestamp:signature */
async function lalamoveFetch(creds, method, path, bodyObj, market) {
  const timestamp = Date.now().toString();
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const raw = `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${body}`;
  const signature = await hmacHex(creds.apiSecret, raw);

  const res = await fetch(`${LALA_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `hmac ${creds.apiKey}:${timestamp}:${signature}`,
      Market: market || creds.market || 'TW',
      'Request-ID': crypto.randomUUID()
    },
    body: bodyObj ? body : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.raw)) || `HTTP ${res.status}`;
    throw new Error(`Lalamove ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/** Google 地址轉座標 */
async function geocode(address, googleKey) {
  if (!googleKey) throw new Error('未設定 GOOGLE_MAPS_KEY，無法將地址轉為座標');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&region=TW&key=${googleKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`地址定位失敗（${data.status}）：${address}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
}

/* ---------------- 金鑰存取 ---------------- */

async function getCreds(env, storeId) {
  if (!env.STORE_KEYS) throw new Error('未綁定 KV：STORE_KEYS');
  const raw = await env.STORE_KEYS.get(`key:${storeId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ---------------- 路由 ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env) });

    try {
      if (path === '/health') {
        return json({ ok: true, ts: Date.now() }, 200, env);
      }

      /* ---- 設定金鑰（總部用）---- */
      if (path === '/admin/keys' && request.method === 'POST') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: '管理密鑰錯誤' }, 401, env);
        }
        const body = await request.json();
        const storeId = (body.storeId || '').trim();
        if (!storeId || !body.apiKey || !body.apiSecret) {
          return json({ ok: false, error: 'storeId / apiKey / apiSecret 皆必填' }, 400, env);
        }
        const payload = {
          apiKey: body.apiKey.trim(),
          apiSecret: body.apiSecret.trim(),
          market: (body.market || 'TW').trim().toUpperCase(),
          updatedAt: Date.now()
        };
        await env.STORE_KEYS.put(`key:${storeId}`, JSON.stringify(payload));
        return json({ ok: true, storeId, masked: payload.apiKey.slice(0, 4) + '****' }, 200, env);
      }

      /* ---- 查詢金鑰狀態 ---- */
      if (path === '/admin/keys' && request.method === 'GET') {
        if (request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: '管理密鑰錯誤' }, 401, env);
        }
        const storeId = (url.searchParams.get('storeId') || '').trim();
        const creds = storeId ? await getCreds(env, storeId) : null;
        return json({
          ok: true,
          storeId,
          configured: !!creds,
          masked: creds ? creds.apiKey.slice(0, 4) + '****' : '',
          market: creds ? creds.market : '',
          updatedAt: creds ? creds.updatedAt : 0
        }, 200, env);
      }

      /* ---- 派車 ---- */
      if (path === '/dispatch' && request.method === 'POST') {
        const body = await request.json();
        const storeId = (body.storeId || '').trim();
        if (!storeId) return json({ ok: false, error: '缺少 storeId' }, 400, env);

        const creds = await getCreds(env, storeId);
        if (!creds) {
          return json({
            ok: false,
            code: 'NO_KEY',
            error: '這間店尚未設定 Lalamove 金鑰，請在總部後台設定'
          }, 400, env);
        }

        const pickup = body.pickup || {};
        const dropoff = body.dropoff || {};
        if (!pickup.address || !dropoff.address) {
          return json({ ok: false, error: '缺少取件或送件地址' }, 400, env);
        }

        // 1) 地址轉座標
        const [p, d] = await Promise.all([
          geocode(pickup.address, env.GOOGLE_MAPS_KEY),
          geocode(dropoff.address, env.GOOGLE_MAPS_KEY)
        ]);

        // 2) 詢價
        const quoteBody = {
          data: {
            serviceType: body.serviceType || 'MOTORCYCLE',
            specialRequests: [],
            language: 'zh_TW',
            stops: [
              { coordinates: { lat: String(p.lat), lng: String(p.lng) }, address: p.formatted || pickup.address },
              { coordinates: { lat: String(d.lat), lng: String(d.lng) }, address: d.formatted || dropoff.address }
            ],
            deliveries: [
              {
                toStop: 1,
                toContact: {
                  name: dropoff.name || '顧客',
                  phone: dropoff.phone || ''
                },
                remarks: body.note || '餐點請小心運送'
              }
            ]
          }
        };
        const quote = await lalamoveFetch(creds, 'POST', '/v3/quotations', quoteBody, creds.market);
        const q = (quote.data && quote.data[0]) || null;
        if (!q) throw new Error('Lalamove 沒有回傳報價');

        // 3) 成立訂單
        const orderBody = {
          data: {
            quotationId: q.id,
            senderStopId: q.stops[0].stopId,
            recipientStopId: q.stops[1].stopId,
            remarks: body.note || '',
            priorityFee: q.priceBreakdown && q.priceBreakdown.priorityFee ? q.priceBreakdown.priorityFee : undefined
          }
        };
        const order = await lalamoveFetch(creds, 'POST', '/v3/orders', orderBody, creds.market);

        return json({
          ok: true,
          storeId,
          orderRef: (order.data && (order.data.orderId || order.data.id)) || '',
          quotationId: q.id,
          price: q.priceBreakdown ? q.priceBreakdown.total : null,
          currency: (q.priceBreakdown && q.priceBreakdown.currency) || 'TWD',
          distance: q.distance ? q.distance.value : null,
          eta: order.data && order.data.driver ? order.data.driver : null
        }, 200, env);
      }

      return json({ ok: false, error: 'Not Found' }, 404, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500, env);
    }
  }
};
