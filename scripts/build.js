const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

// 1. Validate syntax first & bundle Firebase Client SDK for browser
execFileSync(process.execPath, [path.join(__dirname, 'lint.js')], { stdio: 'inherit' });
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [path.join(rootDir, 'src/firebase-client.ts')],
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  format: 'iife',
  outfile: path.join(rootDir, 'public/js/firebase-bundle.js'),
  minify: true,
});

// 2. Verify critical runtime files exist
const requiredPaths = [
  'server.js',
  'sql/schema.sql',
  'config/db.js',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'public/js/firebase-bundle.js',
  'node_modules/chart.js/dist/chart.umd.min.js',
  'node_modules/lucide/dist/umd/lucide.min.js',
  'node_modules/jspdf/dist/jspdf.umd.min.js',
];

for (const rel of requiredPaths) {
  const p = path.join(rootDir, rel);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing required build asset: ${rel}`);
  }
}

// 3. Copy static public assets into dist/public for production static deployment verification
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, 'public'), { recursive: true });
fs.cpSync(path.join(rootDir, 'public'), path.join(distDir, 'public'), { recursive: true });

console.log('Production verification build completed cleanly -> dist/public');
