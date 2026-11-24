# 派車伺服器（Cloudflare Worker）

這個 Worker 的用途：**用「每一間店自己的」Lalamove 帳號** 代客叫車。
金鑰存在 Cloudflare KV，網頁前端與 Firestore 都拿不到。

---

## 一、部署（做一次就好，約 15 分鐘）

### 1. 安裝工具

在 PowerShell 執行：

```powershell
npm install -g wrangler
wrangler login
```

會跳出瀏覽器要你登入 Cloudflare（免費帳號即可）。

### 2. 建立金鑰儲存空間

```powershell
cd "C:\Users\User\Desktop\昕悅\dispatch-worker"
wrangler kv namespace create STORE_KEYS
```

它會印出類似：

```
[[kv_namespaces]]
binding = "STORE_KEYS"
id = "abc123def456..."
```

把那個 `id` 貼進 `wrangler.toml` 對應的位置。

### 3. 設定兩個密鑰

```powershell
# 總部管理密鑰：自己訂一組長字串（等一下在總部後台要輸入同一組）
wrangler secret put ADMIN_TOKEN

# Google 地址轉座標（沒有它無法把地址變成經緯度）
wrangler secret put GOOGLE_MAPS_KEY
```

> `GOOGLE_MAPS_KEY` 取得方式：Google Cloud Console → 啟用「Geocoding API」→ 建立 API 金鑰。
> 每月 $200 美金額度內免費，你的用量永遠用不完。

### 4. 部署

```powershell
wrangler deploy
```

成功後會印出網址，例如：

```
https://xinyue-dispatch.your-name.workers.dev
```

### 5. 驗證

用瀏覽器打開 `<網址>/health`，看到 `{"ok":true,...}` 就成功。

---

## 二、設定店家金鑰（每間店一次）

1. 開總部控制中心 → 編輯店家
2. 在「🚚 派車伺服器與 Lalamove 金鑰」填入：
   - **派車伺服器網址**：上面那串 `https://xxx.workers.dev`
   - **管理密鑰**：步驟 3 設定的 `ADMIN_TOKEN`
   - **Lalamove API Key / Secret**：店家自己的（Lalamove 企業後台 → API 設定）
   - 地區：`TW`
3. 按「**儲存金鑰到派車伺服器**」→ 狀態變綠色「已設定 KEY1****」
4. 按「**儲存店家設定**」（把網址寫進資料庫，店家端才讀得到）

之後店家的「一鍵派車」就會真的叫車。

---

## 三、Lalamove 帳號怎麼申請

1. 到 <https://www.lalamove.com/zh-tw/> 點「企業合作 / 成為企業用戶」
2. 填公司或商業登記資料（個人小店請直接問客服是否能開「企業錢包」）
3. 審核通過後登入企業後台 → 「開發者 / API」→ 取得 `API Key` 與 `Secret`
4. 在錢包儲值（運費從這裡扣）

---

## 四、費用

| 項目 | 費用 |
|---|---|
| Cloudflare Worker | 免費（每天 10 萬次請求）|
| Cloudflare KV | 免費（10 萬次讀寫/天）|
| Google Geocoding | 每月 $200 美金額度內免費 |
| Lalamove 運費 | 依距離，從店家自己的錢包扣 |

---

## 五、端點說明

| 端點 | 用途 | 驗證 |
|---|---|---|
| `GET /health` | 健康檢查 | 無 |
| `POST /admin/keys` | 設定某店金鑰 | `x-admin-token` |
| `GET /admin/keys?storeId=` | 查詢是否已設定 | `x-admin-token` |
| `POST /dispatch` | 派車 | 無（僅能派已存在的訂單）|

### 派車請求範例

```json
POST /dispatch
{
  "storeId": "xinyue-brunch",
  "orderId": "firestore-doc-id",
  "pickup":  { "name": "昕悅早午餐", "phone": "035262699", "address": "新竹市西門街266號" },
  "dropoff": { "name": "王先生", "phone": "0912345678", "address": "新竹市北大路168號5樓" },
  "note": "兩份餐點",
  "total": 300
}
```

回應：

```json
{ "ok": true, "orderRef": "LALA_ORDER_999", "price": "95", "currency": "TWD", "distance": "3.2" }
```

---

## 六、還沒做的部分（下一階段）

- **司機到店通知**：Lalamove 會在司機接單後打 webhook 過來，需要再加一個 `/webhook` 端點接收，才能即時顯示司機姓名與車牌（目前只顯示派車單號與運費）。
- **防濫用**：目前靠「同一張訂單只能派一次」在店家端擋，建議再加 Worker 端的每店每小時上限。
