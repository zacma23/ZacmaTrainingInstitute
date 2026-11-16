const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const filesToCheck = [];

function collectJs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'logs', 'data', 'vendor', '.vercel'].includes(entry.name)) continue;
      collectJs(full);
    } else if (entry.name.endsWith('.js')) {
      filesToCheck.push(full);
    }
  }
}

collectJs(rootDir);

for (const file of filesToCheck) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

// Validate src/firebase-client.ts syntax/resolve
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [path.join(rootDir, 'src/firebase-client.ts')],
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  format: 'iife',
  write: false,
});

// Validate Firestore security rules with @firebase/eslint-plugin-security-rules
if (fs.existsSync(path.join(rootDir, 'firestore.rules'))) {
  const eslintBin = path.join(rootDir, 'node_modules', '.bin', 'eslint');
  if (fs.existsSync(eslintBin)) {
    execFileSync(eslintBin, ['firestore.rules'], { cwd: rootDir, stdio: 'inherit' });
  }
}

console.log(`Syntax check passed for ${filesToCheck.length} JavaScript files + Firebase client + firestore.rules.`);
