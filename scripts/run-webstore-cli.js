#!/usr/bin/env node
// Loads .env.local (if present) into process.env, then runs chrome-webstore-upload-cli.
// Wired this way so `npm run webstore:*` works whether or not the calling shell/tool
// already sourced .env.local (e.g. an IDE-triggered release action).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const EXTENSION_ID = 'ollnhakcihdpbakabcdgagaciipklehd';

const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

const [subcommand, ...extraArgs] = process.argv.slice(2);
if (subcommand !== 'upload' && subcommand !== 'publish') {
  console.error('Usage: node scripts/run-webstore-cli.js <upload|publish> [...args]');
  process.exit(1);
}

const missing = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'PUBLISHER_ID'].filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`ERROR: missing credentials in .env.local: ${missing.join(', ')}`);
  process.exit(1);
}

const args = [subcommand, '--extension-id', EXTENSION_ID, ...extraArgs];

if (subcommand === 'upload') {
  // scripts/package.mjs names the ZIP from the manifest version, so the source
  // path has to be derived rather than hardcoded — a stale literal would
  // silently upload the previous release after a bump.
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const zip = path.join(root, 'dist', `dsa-templates-${version}.zip`);
  if (!fs.existsSync(zip)) {
    console.error(`ERROR: ${path.relative(root, zip)} does not exist. Run \`npm run package\` first.`);
    process.exit(1);
  }
  args.push('--source', zip);
}

const result = spawnSync('npx', ['chrome-webstore-upload-cli', ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
