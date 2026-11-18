# Production Deployment Guide — BirrLedger Student Fee Management System

## Option A: Hosting on Vercel (Recommended Cloud Deployment)

This repository includes `api/index.js` and `vercel.json` configured for **Vercel Serverless Functions + Edge Static CDN + Daily Vercel Cron**.

1. **Managed Cloud MySQL Database**:
   Vercel serverless functions require an externally reachable MySQL/MariaDB server (e.g., **TiDB Cloud Serverless**, **Aiven**, **Railway**, **AWS RDS**, or **DigitalOcean Managed MySQL**).
   - Either set `DATABASE_URL` (e.g. `mysql://user:pass@host:4000/sfmt_ethiopia?ssl-mode=REQUIRED`)
   - Or set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_SSL=true` (use `DB_SSL=skip-verify` or `DB_SSL_CA` if your provider uses a self-signed proxy certificate).
   - On first API request, `api/index.js` automatically applies `sql/schema.sql`, runs schema upgrades, and seeds baseline roles/courses/plans. After initial provisioning, you can optionally set `DB_SKIP_SCHEMA_SYNC=true` for faster cold starts.

2. **Required Vercel Environment Variables (Project Settings → Environment Variables)**:
   - `DATABASE_URL` (or `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL`)
   - `JWT_SECRET` (generate with `openssl rand -hex 32`, minimum 16 characters)
   - `NODE_ENV=production`
   - `TZ=Africa/Addis_Ababa`
   - `GEMINI_API_KEY` (required for Fayda ID scanning, slip OCR, and Operations & Fee Assistant)
   - `CRON_SECRET` (recommended: Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` to `GET /api/cron/reminders`)
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (optional Firebase Admin JSON or base64 string)
   - Optional SMS / Email gateway variables (`SMS_PROVIDER`, `AFROMESSAGE_TOKEN`, `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`, or `RESEND_API_KEY`)

3. **Firebase Google Sign-In Domain Allowlist**:
   Add your deployed Vercel domain (`your-app.vercel.app` and any custom domain) in **Firebase Console → Authentication → Settings → Authorized domains**.

4. **Automated Daily Reminders & Health Probe**:
   - `vercel.json` schedules daily Vercel Cron (`0 5 * * *`, 08:00 AM Addis Ababa time) on `GET /api/cron/reminders`.
   - Verify deployment readiness at `GET https://your-app.vercel.app/api/health`.

---

## Option B: Hosting on Hostinger (Node.js Web App or Hostinger VPS)

### Hostinger Managed Node.js Web App (GitHub Integration)
1. **Repository & Build Settings**:
   - **Node.js Version**: `20.x` or `22.x`
   - **Build Command**: `npm run build`
   - **Start Command / Entry Point**: `npm start` (`server.js`)
2. **Hostinger MySQL Database**:
   - Create a MySQL database & user in **hPanel → Databases → Management**.
   - Set **Environment Variables** in Hostinger hPanel:
     - `NODE_ENV=production`
     - `TZ=Africa/Addis_Ababa`
     - `DB_HOST=<your-hostinger-mysql-host>` (e.g. `127.0.0.1` or `auth-db*.hstgr.io`)
     - `DB_PORT=3306`
     - `DB_USER=<hostinger_db_user>`
     - `DB_PASSWORD=<hostinger_db_password>`
     - `DB_NAME=<hostinger_db_name>`
     - `JWT_SECRET=<random-64-char-hex-secret>`
     - Optional: `GEMINI_API_KEY`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD`
3. **Firebase Google Sign-In Domain Allowlist**:
   - Add your Hostinger domain (e.g. `yourdomain.com` and `www.yourdomain.com`) in **Firebase Console → Authentication → Settings → Authorized domains**.
4. **Verify**: Visit `https://yourdomain.com/api/health` and confirm HTTP `200` (`"status": "ok"`).

---

## Option C: Linux VPS (Hostinger VPS / Ubuntu / Debian)
This application requires **Node.js 20+**, **MySQL 8.0+ / MariaDB 10.6+**, and a persistent process manager (**PM2**).
- **Recommended:** Ubuntu 22.04/24.04 or Debian 12 VPS (Hostinger KVM VPS, DigitalOcean, Hetzner, AWS EC2, Ethio Telecom Cloud, or on-premise institute server).

## 2. Server Preparation (Ubuntu / Debian VPS)
```bash
# Install Node.js 22 LTS and MariaDB/MySQL
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get update && sudo apt-get install -y nodejs mariadb-server nginx
sudo npm install -g pm2
```

## 3. MySQL Database Provisioning
```bash
sudo mysql -e "CREATE DATABASE IF NOT EXISTS sfmt_ethiopia CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER IF NOT EXISTS 'sfmt_app'@'127.0.0.1' IDENTIFIED BY 'STRONG_UNIQUE_PASSWORD';"
sudo mysql -e "GRANT ALL PRIVILEGES ON sfmt_ethiopia.* TO 'sfmt_app'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

Import the schema directly or let the initializer apply it:
```bash
mysql -u sfmt_app -p sfmt_ethiopia < sql/schema.sql
```

## 4. Environment Configuration (`.env`)
```bash
cp .env.example .env
```
Edit `.env` with secure production values:
- `NODE_ENV=production`
- `PORT=3000`
- `TZ=Africa/Addis_Ababa`
- `DB_HOST=127.0.0.1`, `DB_USER=sfmt_app`, `DB_PASSWORD=<strong-password>`, `DB_NAME=sfmt_ethiopia`
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
- Health probe endpoint: `GET /api/health` (returns HTTP 200 when MySQL pool is healthy, HTTP 503 if degraded).

## 9. Backup & Recovery
Schedule daily automated backups via cron (`crontab -e`):
```cron
0 2 * * * cd /var/www/birrledger && bash scripts/backup-db.sh >> logs/backup.log 2>&1
```
To restore from backup:
```bash
gunzip -c backups/sfmt_ethiopia_YYYYMMDD_HHMMSS.sql.gz | mysql -u sfmt_app -p sfmt_ethiopia
```
