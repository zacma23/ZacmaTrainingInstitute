# BirrLedger — Student Fee Management System (Ethiopia)

Production-grade Student Fee Management, Installment Scheduling, Receipting, Automated Reminders & Financial Reporting System tailored for Ethiopian short-term professional training institutes.

## Technology Stack
- **Backend:** Node.js, Express.js, `mysql2/promise`, `bcryptjs`, `jsonwebtoken`, `express-rate-limit`, `helmet`, `node-cron`, `exceljs`
- **Database:** MySQL / MariaDB (11 normalized tables with foreign keys, indexes, and ACID transactions)
- **Frontend:** HTML5, CSS3, Vanilla JavaScript, Chart.js, Lucide Icons, jsPDF
- **Localization:** ETB Currency (`ETB`), `Africa/Addis_Ababa` Timezone (`EAT`), Ethiopian phone validation (`+251`/`09`/`07`), Ethiopian regions & cities

## Quick Start
```bash
npm install
cp .env.example .env
# Edit .env with your MySQL credentials and JWT_SECRET
npm run db:init
# Optional: seed realistic Ethiopian institute data for testing
npm run db:seed
npm run dev
```

## Default Administrator Setup Procedure
No hardcoded passwords are stored in source code.
1. **Option A (Interactive First-Time Setup):** Start the server (`npm run dev`) with an empty `users` table and leave `ADMIN_INIT_PASSWORD` blank in `.env`. Open `http://localhost:3000` — the system will display the **Create Administrator** setup screen.
2. **Option B (Environment Bootstrap):** Set `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD`, and `ADMIN_INIT_FULLNAME` in `.env`, then run `npm run db:init`. The initial administrator account is hashed with `bcrypt` and inserted into `users`.

## Project Structure
- `server.js` — Express entry point, security middleware, static vendor bundles, REST routes, cron scheduler
- `sql/schema.sql` — Normalized 11-table MySQL schema
- `config/db.js` & `config/logger.js` — MySQL pool, transaction wrapper, structured file logger
- `middleware/auth.js` — JWT verification, RBAC (`admin`, `accountant`), rate limiting, audit log writer
- `services/` — `feeService.js`, `reminderService.js`, `messagingService.js`, `seedService.js`
- `routes/` — Modular REST APIs (`auth`, `dashboard`, `courses`, `students`, `installments`, `transactions`, `notifications`, `reports`, `users`, `settings`)
- `public/` — Single-page HTML5/CSS3/JS workspace (`index.html`, `styles.css`, `app.js`, `js/api.js`, `js/receipt.js`)
- `scripts/` — `init-db.js`, `seed-db.js`, `build.js`, `lint.js`, `backup-db.sh`
- `ecosystem.config.js` & `DEPLOYMENT.md` — PM2 & VPS deployment documentation
