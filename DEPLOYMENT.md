# Production Deployment Guide — BirrLedger Student Fee Management System

## 1. Hosting Environment Compatibility
This application requires **Node.js 20+**, **MySQL 8.0+ / MariaDB 10.6+**, and a persistent process manager (**PM2**).
- **Recommended:** Ubuntu 22.04/24.04 or Debian 12 VPS (DigitalOcean, Hetzner, AWS EC2, Ethio Telecom Cloud, or on-premise institute server).
- **Important Note on Shared cPanel Hosting:** Standard shared cPanel hosting often restricts long-lived Node.js processes, `node-cron` background timers, outbound messaging webhooks, or `mysql2` connection pooling. Verify that your hosting plan explicitly supports **Node.js App Manager (Passenger) or SSH/PM2 access** before deploying on cPanel; otherwise deploy on a Linux VPS.

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
