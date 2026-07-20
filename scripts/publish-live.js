#!/usr/bin/env node
// Full live-release pipeline: verify clean tree, bump version, run checks, build,
// upload + publish to the Chrome Web Store, then commit and tag the version bump.
// Usage: node scripts/publish-live.js [patch|minor|major]   (prompts if omitted and a TTY is attached)
//
// This IS what `npm run release` runs. Publishing pushes an auto-update to every
// existing install of ollnhakcihdpbakabcdgagaciipklehd — there is no build-only,
// side-effect-free variant of this command.

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.join(__dirname, '..');

function run(command) {
  console.log(`\n$ ${command}`);
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${command}`);
  }
}

function promptBumpType() {
  console.log('Which kind of release is this?');
  console.log('  [1] patch  -> 0.0.X  bug fixes, small internal changes, no new features, nothing breaks');
  console.log('  [2] minor  -> 0.X.0  new features, backwards compatible');
  console.log('  [3] major  -> X.0.0  breaking changes (rare for an extension: e.g. dropped permissions/features)');
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Enter 1, 2, or 3 (or type patch/minor/major): ', answer => {
      rl.close();
      const map = { '1': 'patch', '2': 'minor', '3': 'major', patch: 'patch', minor: 'minor', major: 'major' };
      const bumpType = map[answer.trim().toLowerCase()];
      if (!bumpType) {
        console.error(`Unrecognized choice "${answer}". Expected patch, minor, or major.`);
        process.exit(1);
      }
      resolve(bumpType);
    });
  });
}

async function main() {
  const argType = process.argv[2];
  if (!['patch', 'minor', 'major'].includes(argType) && !process.stdin.isTTY) {
    console.error('No bump type given and no interactive terminal is attached — refusing to hang waiting for input.');
    console.error('Re-run with an explicit type: npm run release -- patch   (or minor / major)');
    process.exit(1);
  }
  const bumpType = ['patch', 'minor', 'major'].includes(argType) ? argType : await promptBumpType();

  // Guard: working tree must be clean, so the version-bump commit only contains the bump.
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
  if (status.trim()) {
    console.error('Working tree has uncommitted changes:\n' + status);
    throw new Error('Commit or stash your changes before publishing a live release.');
  }

  console.log(`\nPublishing a ${bumpType} release...`);

  run(`node scripts/bump-version.js ${bumpType}`);
  const newVersion = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).version;

  try {
    run('npm test');
    run('npm run test:chrome');
    run('npm run package');
    run('npm run webstore:upload');
    run('npm run webstore:publish');
  } catch (error) {
    console.error(`\n${error.message}`);
    console.error(`extension/manifest.json / package.json were bumped to ${newVersion} but nothing was committed.`);
    console.error('Check `git status` — you can revert the bump (git checkout -- extension/manifest.json package.json) or fix the failure and re-run.');
    process.exit(1);
  }

  run('git add extension/manifest.json package.json');
  run(`git commit -m "v${newVersion}"`);
  run(`git tag v${newVersion}`);

  console.log(`\nPublished v${newVersion} (${bumpType}). Don't forget to run: git push --follow-tags`);
}

main().catch(error => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
