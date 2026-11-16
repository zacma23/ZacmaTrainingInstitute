# BirrLedger — Student Fee Management System (Ethiopia)

Role-based Student Registration, Fee Payment, Installment Scheduling, Attendance, Receipting, Automated Reminders & Financial Reporting System tailored for Ethiopian short-term professional training institutes.

## Technology Stack
- **Backend:** Node.js 20+, Express.js, `mysql2/promise`, `bcryptjs`, `jsonwebtoken`, `express-rate-limit`, `helmet`, `exceljs`, `@google/genai`
- **Database:** Cloud MySQL / MariaDB (TiDB Cloud, Aiven, Railway, AWS RDS, or local MariaDB) + Firebase Auth & Cloud Firestore workspace sync
- **Frontend:** HTML5, CSS3, Vanilla JavaScript, Chart.js, Lucide Icons, jsPDF (bundled/served statically via `public/vendor/` and `public/js/firebase-bundle.js`)
- **Deployment Targets:** Vercel Serverless + Static CDN (`api/index.js`, `vercel.json`) or Node.js VPS / PM2

## Local Development Quick Start
```bash
npm install
cp .env.example .env
# Edit .env with your MySQL credentials and JWT_SECRET
npm run db:init
# Optional: seed sample Ethiopian institute data
npm run db:seed
npm run build
npm run dev
```

## Deploy to GitHub & Vercel

### 1. Push to GitHub
```bash
git add .
git commit -m "Prepare BirrLedger for GitHub and Vercel deployment"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### 2. Provision a Cloud MySQL Database
Vercel Serverless Functions cannot connect to `127.0.0.1` (`localhost`), so use any managed MySQL/MariaDB provider (e.g., **TiDB Cloud Serverless**, **Aiven for MySQL**, **Railway MySQL**, or **AWS RDS**).

### 3. Import Project in Vercel & Set Environment Variables
Import your GitHub repository in **Vercel** (`Framework Preset: Other` — `vercel.json` configures `npm run build` and `public` automatically) and add these Environment Variables:
- `DATABASE_URL` (e.g., `mysql://user:pass@host:4000/sfmt_ethiopia?ssl-mode=REQUIRED`) **or** `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`
- `JWT_SECRET` (at least 32–64 random hex characters)
- `NODE_ENV=production`
- `TZ=Africa/Addis_Ababa`
- `GEMINI_API_KEY` (optional, enables the Operations & Fee Assistant chatbot)
- `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD`, `ADMIN_INIT_FULLNAME` (optional, or create the first Admin via the web First-Time Setup screen)
- `CRON_SECRET` (optional, secures `GET /api/cron/reminders`)

### 4. Authorize Your Vercel Domain in Firebase
If using **Sign in with Google**, add your `*.vercel.app` (and any custom domain) under **Firebase Console → Authentication → Settings → Authorized domains**.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for full Vercel, Cloud MySQL, and VPS production instructions.

## Project Structure
- `api/index.js` & `vercel.json` — Vercel Serverless Function entry point and edge rewrites
- `server.js` — Express application, security middleware, REST APIs, and local/VPS bootstrap
- `sql/schema.sql` — Normalized MySQL schema
- `config/db.js` & `config/logger.js` — Cloud/local MySQL pool (with `DATABASE_URL` + TLS/SSL) and serverless-safe logger
- `middleware/auth.js` — JWT verification, RBAC (`admin`, `accountant`), rate limiting, audit log writer
- `services/` — `feeService.js`, `reminderService.js`, `messagingService.js`, `seedService.js`, `firebaseAdmin.js`, `geminiService.js`
- `routes/` — Modular REST APIs (`auth`, `dashboard`, `courses`, `students`, `applications`, `paymentSubmissions`, `installments`, `transactions`, `receipts`, `attendance`, `notifications`, `reports`, `users`, `settings`, `chat`)
- `public/` & `src/` — SPA UI (`index.html`, `styles.css`, `app.js`, `js/api.js`, `js/receipt.js`, bundled `js/firebase-bundle.js`, built `vendor/`)
- `scripts/` — `init-db.js`, `seed-db.js`, `build.js`, `lint.js`, `backup-db.sh`
