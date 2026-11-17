# Production Deployment Guide — BirrLedger Student Fee Management System

## Option A: Hosting on Netlify (Recommended Cloud Deployment)

The application deploys to Netlify with a static frontend build (`bun run build` → `dist/`) and the Express
API running as a **Netlify Server** (`netlify/server/index.mjs`), backed by **Netlify Database** (managed Postgres).

1. **Database**: Netlify Database is provisioned and connected automatically — no connection string or
   environment variables are required. SQL migrations in `netlify/database/migrations/` are applied
   automatically before each deploy is published. Baseline roles, settings, payment plans, and the default
   course catalog are seeded on first API request.

2. **Required Netlify Environment Variables**:
   - `JWT_SECRET` (generate with `openssl rand -hex 32`)
   - `GEMINI_API_KEY` (required if using the Operations & Fee Assistant chatbot)
   - `CRON_SECRET` (optional bearer token protecting `GET /api/cron/reminders`)
   - `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` (optional bootstrap; otherwise use the First-Time Setup screen)
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (optional Firebase Admin JSON or base64 string)

3. **Firebase Google Sign-In Domain Allowlist**:
   Add your deployed Netlify domain (`your-site.netlify.app`) in **Firebase Console → Authentication → Settings → Authorized domains**.

4. **Automated Reminders**: A scheduled function (`netlify/functions/reminder-check.mjs`) runs the payment
   reminder scan hourly. External schedulers can also call `GET /api/cron/reminders` with
   `Authorization: Bearer <CRON_SECRET>`.

---

## Option B: Linux VPS / Self-Hosted Hosting (Advanced — requires a managed Postgres)

This application requires **Node.js 22+**, a reachable **PostgreSQL** database (Netlify Database is not
available off-platform), and a persistent process manager (**PM2**).
- **Recommended:** Ubuntu 22.04/24.04 or Debian 12 VPS (DigitalOcean, Hetzner, AWS EC2, Ethio Telecom Cloud, or on-premise institute server).
- **Important Note on Shared cPanel Hosting:** Standard shared cPanel hosting often restricts long-lived Node.js processes, background timers, outbound messaging webhooks, or database connection pooling. Verify that your hosting plan explicitly supports **Node.js App Manager (Passenger) or SSH/PM2 access** before deploying on cPanel; otherwise deploy on Netlify or a Linux VPS.

## 2. Server Preparation (Ubuntu / Debian VPS)
```bash
# Install Node.js 22 LTS and MariaDB/MySQL
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get update && sudo apt-get install -y nodejs mariadb-server nginx
sudo npm install -g pm2
```

## 3. Postgres Database Provisioning
```bash
sudo -u postgres psql -c "CREATE DATABASE sfmt_ethiopia;"
sudo -u postgres psql -c "CREATE USER sfmt_app WITH PASSWORD 'STRONG_UNIQUE_PASSWORD';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE sfmt_ethiopia TO sfmt_app;"
```

Apply the schema from the generated migration files:
```bash
psql -U sfmt_app -d sfmt_ethiopia -f netlify/database/migrations/20261117170613_create_initial_schema/migration.sql
psql -U sfmt_app -d sfmt_ethiopia -f netlify/database/migrations/20261117170614_add_updated_at_triggers/migration.sql
```
Set `NETLIFY_DB_URL=postgres://sfmt_app:...@127.0.0.1:5432/sfmt_ethiopia` so the server can connect.

## 4. Environment Configuration (`.env`)
```bash
cp .env.example .env
```
Edit `.env` with secure production values:
- `NODE_ENV=production`
- `PORT=3000`
- `TZ=Africa/Addis_Ababa`
- `NETLIFY_DB_URL=postgres://sfmt_app:<strong-password>@127.0.0.1:5432/sfmt_ethiopia`
- `JWT_SECRET=$(openssl rand -hex 32)`
- Leave `ADMIN_INIT_PASSWORD` blank if you prefer setting up the first administrator via the web First-Time Setup screen (`POST /api/auth/setup-admin`), OR set `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` before running `npm run db:init` and remove `ADMIN_INIT_PASSWORD` afterwards.

## 5. Install & Initialize
```bash
npm ci --omit=dev
npm run db:init
npm run build
```

## 6. Process Management with PM2
```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

## 7. Nginx Reverse Proxy + SSL
Create `/etc/nginx/sites-available/birrledger`:
```nginx
server {
    listen 80;
    server_name fees.yourinstitute.edu.et;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Enable and secure with Let's Encrypt:
```bash
sudo ln -s /etc/nginx/sites-available/birrledger /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fees.yourinstitute.edu.et
```

## 8. Error Logging & Monitoring
- Application logs: `./logs/app.log`
- Error logs: `./logs/error.log`
- PM2 logs: `./logs/pm2-out.log` and `./logs/pm2-error.log`
- Health probe endpoint: `GET /api/health` (returns HTTP 200 when the database pool is healthy, HTTP 503 if degraded).

## 9. Backup & Recovery
Schedule daily automated backups via cron (`crontab -e`):
```cron
0 2 * * * cd /var/www/birrledger && bash scripts/backup-db.sh >> logs/backup.log 2>&1
```
To restore from backup:
```bash
gunzip -c backups/sfmt_ethiopia_YYYYMMDD_HHMMSS.sql.gz | psql -U sfmt_app -d sfmt_ethiopia
```
