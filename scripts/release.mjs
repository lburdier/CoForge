/**
 * Publie une nouvelle version de CoForge sur GitHub (release lue par les mises à jour automatiques).
 *
 *   npm run release              publie la version de package.json
 *   npm run release -- 0.3.1     fixe d'abord la version (package.json + package-lock.json)
 *
 * Étapes : vérifications (version jamais publiée, jeton GitHub), build complet, puis
 * electron-builder --publish always : installateur, .blockmap et latest.yml envoyés dans la
 * release vX.Y.Z (créée en brouillon par electron-builder puis publiée ici). Les applications
 * installées la trouvent à leur prochaine vérification (au démarrage puis toutes les 4 h).
 *
 * Jeton : GH_TOKEN s'il est défini, sinon celui de la GitHub CLI (`gh auth token`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

function fail(msg) {
  console.error(`\nPublication annulée : ${msg}`);
  process.exit(1);
}

function run(cmd, args, env = process.env) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: win && cmd !== 'gh' });
  if (r.status !== 0) fail(`« ${cmd} ${args[0]} » a échoué (code ${r.status}).`);
}

function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: win && cmd !== 'gh' }).trim();
  } catch {
    return '';
  }
}

const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const owner = builder.match(/^\s*owner:\s*(\S+)/m)?.[1];
const repo = builder.match(/^\s*repo:\s*(\S+)/m)?.[1];
if (!owner || !repo) fail('section « publish » (owner, repo) introuvable dans electron-builder.yml.');
const slug = `${owner}/${repo}`;

// 1. Version
const wanted = process.argv[2];
if (wanted) {
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) fail(`version « ${wanted} » invalide (attendu : X.Y.Z).`);
  run('npm', ['version', wanted, '--no-git-tag-version', '--allow-same-version']);
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

// 2. Jeton et release existante
const token = process.env.GH_TOKEN || capture('gh', ['auth', 'token']);
if (!token) fail('aucun jeton GitHub : définissez GH_TOKEN ou connectez la GitHub CLI (gh auth login).');
const existing = capture('gh', ['release', 'view', tag, '-R', slug, '--json', 'isDraft', '-q', '.isDraft']);
if (existing === 'false') fail(`la release ${tag} est déjà publiée sur ${slug} : augmentez la version (npm run release -- X.Y.Z).`);

console.log(`Publication de CoForge ${version} sur https://github.com/${slug}/releases/tag/${tag}`);

// 3. Brouillon créé d'avance : sinon electron-builder crée la release une fois par fichier, en
// parallèle, et la seconde création échoue (422) en laissant une release publiée incomplète.
if (!existing) run('gh', ['release', 'create', tag, '-R', slug, '--draft', '--target', 'main', '--title', `CoForge ${version}`, '--notes', `CoForge ${version}`]);

// 4. Build et envoi
run('npm', ['run', 'build']);
run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'always'], { ...process.env, GH_TOKEN: token });

// 5. Publication du brouillon pour que les mises à jour le voient.
const draft = capture('gh', ['release', 'view', tag, '-R', slug, '--json', 'isDraft', '-q', '.isDraft']);
if (draft === 'true') run('gh', ['release', 'edit', tag, '-R', slug, '--draft=false', '--latest', '--title', `CoForge ${version}`]);
const assets = capture('gh', ['release', 'view', tag, '-R', slug, '--json', 'assets', '-q', '[.assets[].name] | join(", ")']);
if (!assets.includes('latest.yml')) fail(`latest.yml absent de la release ${tag} : les mises à jour automatiques ne la verront pas.`);
console.log(`\nCoForge ${version} publié (${assets}).`);
console.log('Pensez à committer et pousser le changement de version (package.json, package-lock.json).');
