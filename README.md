# CVISUAL WHATSAPP GATEWAY & ANTI-BAN SAAS SYSTEM

Mikwosèvis WhatsApp Gateway Multi-Tenant endepandan avèk achitekti Doub Vitès (Fast Lane & Slow Lane), Boukliye Anti-Bann Meta (Spintax Dinamik & Zero-Width Unicode Hash), ak Panèl Administrasyon konplè pare pou VPS Linux ak Docker.

---

## 1. Karakteristik Prensipal

- **Achitekti Doub Vitès (Dual-Lane Engine):**
  - **Liy Rapid Tranzaksyonèl (Fast Lane):** Pou resi, fakti PDF, kòd OTP, ak mesaj byenvini. Delè 3-10 segonn avèk similasyon moun k ap tape (2-4s). Okenn plafon 25/jou pa aplike sou kanal sa a.
  - **Liy Dousman pou Rapèl (Slow Lane):** Pou rapèl bòdwo ak maketing. Delè 10 a 16 minit (`600000ms + jitter`) ant chak mesaj, plafon 25 rapèl/jou pou chak grenn SIM, ak poz repo 10 minit apre chak 5 rapèl.
- **Boukliye Anti-Spam & Anti-Bann Meta:**
  - **Spintax Dinamik:** Chanje salitasyon yo otomatikman (`{Bonjour|Salut|Bonsoir}`).
  - **Zero-Width Unicode Hash Shield:** Enjekte karaktè envizib (`\u200B`, `\u200C`, `\u200D`) pou chak grenn mesaj gen yon anprent SHA-256 diferan nèt, sa ki anpeche Meta detekte repetisyon.
  - **Envitasyon pou Repons "OK":** Transfòme fraz yo an envitasyon repons pou Meta klase nimewo a kòm nimewo konfyans.
- **Cluster WhatsApp Multi-SIM:**
  - Distribisyon mesaj sou plizyè liy atravè **Least Recently Used (LRU)**.
  - Otomatik rale dènye vèsyon WhatsApp Web sou GitHub (`wppconnect-team/wa-version`) pou elimine erè koneksyon.
  - Auto-Recovery sou crash Chromium ak netwayaj fichye lock (`SingletonLock`, `DevToolsActivePort`).
  - Stealth Mode: Efase `navigator.webdriver` epi itilize User-Agent modèn.
- **Panèl Administrasyon & Dashboard Kliyan:**
  - Rekonèt otomatikman imel admin nan pou l antre dirèkteman nan sant kontwòl la.
  - Validasyon demann kliyan ak plan yo (Starter 300/mwa, Pro 3,000/mwa, Enterprise illimité).
  - Eskane QR Code WhatsApp dirèkteman sou navigatè a.
  - Rekipere ak jere kle API REST (`Authorization: Bearer <API_KEY>`).

---

## 2. Estrikti Pwojè a

```
CVISUAL AUTOMATISATION/
├── src/
│   ├── api/
│   │   ├── middleware.js         # API Key & Admin Auth Middleware
│   │   └── routes.js             # Tout wout REST API
│   ├── whatsapp/
│   │   ├── account_instance.js   # Jesyon grenn sesyon WhatsApp Puppeteer
│   │   └── cluster_manager.js    # Schedulers Fast Lane & Slow Lane LRU
│   ├── config.js                 # Konfigirasyon jeneral
│   ├── database.js               # Supabase Client & In-memory Fallback
│   ├── shield.js                 # Spintax & Zero-Width Hash Shield
│   └── server.js                 # Express server & pwen lantre
├── public/
│   ├── index.html                # Landing Page + Client & Admin Dashboards
│   ├── css/
│   │   └── style.css             # Tèm nwa modèn (Glassmorphism, No Emojis)
│   └── js/
│       ├── app.js                # Navigasyon SPA, Auth, Shield Simulator
│       ├── client.js             # Dashboard Kliyan & Outbox
│       └── admin.js              # Sant Kontwòl Admin & QR Code Viewer
├── supabase_schema.sql           # SQL Schema pou PostgreSQL / Supabase
├── Dockerfile                    # Docker build avèk Chromium & fon Chinwa/Japonè
├── docker-compose.yml            # Orchestrasyon Docker pare pou VPS
├── .env.example                  # Modèl varyab anviwonman
└── package.json
```

---

## 3. Konfigirasyon Baz Done (Supabase)

1. Kreye yon pwojè sou [Supabase](https://supabase.com).
2. Ale nan **SQL Editor** nan Supabase dashboard ou a.
3. Kopye kontni fichye `supabase_schema.sql` la epi klike sou **Run**.
4. Rekipere **Project URL** ak **Service Role Key** nan **Project Settings > API**.

---

## 4. Konfigirasyon Fichye `.env`

Kreye yon fichye `.env` nan rasin pwojè a (oswa kopye `.env.example`):

```bash
PORT=3000
NODE_ENV=development

# SUPABASE
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# ADMIN ACCESS (Mete adrès imel admin ou la)
ADMIN_EMAILS=admin@cvisual.com,oumenm@example.com

# ANTI-BAN ENGINE
FAST_LANE_CONCURRENCY=5
SLOW_LANE_INTERVAL_MIN_MS=600000
SLOW_LANE_JITTER_MAX_MS=360000
MAX_REMINDERS_PER_DAY=25
BATCH_PAUSE_EVERY_N=5
BATCH_PAUSE_MS=600000
```

> **Remak:** Si w pa mete kle Supabase yo touswit, sèvè a ap fonksyone nan mòd **In-Memory Demo**, sa ki pèmèt ou teste tout koòdone a ak API a imedyatman!

---

## 5. Kòman pou w Lanse l Lokalman

```bash
# 1. Enstale depandans yo
npm install

# 2. Lanse sèvis la
npm start

# Pou devlopman avèk auto-reload:
npm run dev
```

Apre sa, ouvri navigatè w sou: `http://localhost:3000`

---

## 6. Deplwayman sou VPS Linux avèk Docker

Sèvis la pare pou l kouri sou nenpòt VPS (Ubuntu, Debian, DigitalOcean, Hetzner, AWS):

```bash
# 1. Klone oswa transfere dosye a sou VPS la
cd /opt/cvisual-gateway

# 2. Kreye fichye .env sou VPS la
nano .env

# 3. Bati epi lanse kontenè a an background
docker compose up -d --build

# 4. Gade logs an dirèk
docker compose logs -f
```

Sesyon WhatsApp yo estoke nan volim Docker `cvisual_wwebjs_auth`, sa vle di menm si ou redemare sèvè a oswa w mete l ajou, ou pap janm bezwen re-eskane kòd QR la!

---

## 7. Referans REST API

Tout wout API yo bezwen header: `Authorization: Bearer <API_KEY>`

### A. Voye yon Mesaj
```http
POST /api/v1/messages/send
Content-Type: application/json
Authorization: Bearer cv_live_...

{
  "to": "50931234567",
  "message": "{Bonjour|Salut} Jean! Resi w disponib.",
  "kind": "receipt",
  "pdf_base64": "JVBERi0xLjQKJ...",
  "pdf_file_name": "Fakti.pdf"
}
```

**Repons:**
```json
{
  "ok": true,
  "message_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "status": "queued",
  "lane": "fast_lane",
  "kind": "receipt",
  "recipient": "50931234567"
}
```

### B. Tcheke Estati yon Mesaj
```http
GET /api/v1/messages/:id/status
Authorization: Bearer cv_live_...
```

### C. Gade Tout Liy Cluster yo
```http
GET /api/v1/accounts
```

### D. Rekipere QR Code yon Liy pou Eskane
```http
GET /api/v1/accounts/1/qr
```

### E. Reset Sesyon yon Liy
```http
POST /api/v1/accounts/1/reset
```

### F. Anrejistre yon Webhook
```http
POST /api/v1/webhooks/register
Authorization: Bearer cv_live_...

{
  "url": "https://moncrm.com/api/whatsapp-callback",
  "events": ["message.sent", "message.failed"]
}
```
