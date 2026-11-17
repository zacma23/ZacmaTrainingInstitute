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

// 2. Copy local UMD vendor bundles into public/vendor/ for static hosting (Vercel CDN)
const vendorDir = path.join(rootDir, 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });
const vendorFiles = [
  ['node_modules/chart.js/dist/chart.umd.min.js', 'chart.umd.min.js'],
  ['node_modules/lucide/dist/umd/lucide.min.js', 'lucide.min.js'],
  ['node_modules/jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js'],
];
for (const [srcRel, destName] of vendorFiles) {
  const srcPath = path.join(rootDir, srcRel);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing required vendor asset: ${srcRel}`);
  }
  fs.copyFileSync(srcPath, path.join(vendorDir, destName));
}

// 3. Verify critical runtime files exist
const requiredPaths = [
  'server.js',
  'api/index.js',
  'vercel.json',
  'sql/schema.sql',
  'config/db.js',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'public/js/firebase-bundle.js',
  'public/vendor/chart.umd.min.js',
  'public/vendor/lucide.min.js',
  'public/vendor/jspdf.umd.min.js',
];

for (const rel of requiredPaths) {
  const p = path.join(rootDir, rel);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing required build asset: ${rel}`);
  }
}

// 4. Publish the existing static application at the configured dist root
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.cpSync(path.join(rootDir, 'public'), distDir, { recursive: true });

console.log('Production verification build completed cleanly -> public/vendor & dist');
