#!/usr/bin/env node
/**
 * Pre-commit secret scan.
 *
 * The EIAAW deploy contract says every secret lives in Infisical and is
 * referenced as a `secret://` handle. This blocks the failure mode that
 * contract exists to prevent: a live credential reaching git history, where
 * removing it means rewriting history and rotating the key anyway.
 *
 * Runs on the staged diff only, so it is fast and cannot be tripped by an
 * untracked local .env.
 *
 * Written in Node rather than as a shell one-liner because lefthook's shell
 * differs across Windows and Linux, and a security gate that silently fails
 * open on one platform is worse than no gate.
 */
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9]{24,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'Stripe secret key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
];

/** Files whose contents are allowed to look key-shaped. */
const ALLOWED_PATHS = [/^scripts\/scan-secrets\.mjs$/, /^package-lock\.json$/];

let diff = '';
try {
  diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  process.exit(0); // nothing staged, or not a repo
}

const findings = [];
let currentFile = '';

for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6).trim();
    continue;
  }
  // Only added lines matter.
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (ALLOWED_PATHS.some((re) => re.test(currentFile))) continue;

  for (const { name, re } of PATTERNS) {
    if (re.test(line)) {
      findings.push({ file: currentFile, name });
      break;
    }
  }
}

if (findings.length > 0) {
  console.error('\nBLOCKED: a live-looking credential is staged.\n');
  for (const f of findings) {
    console.error(`  ${f.file} — ${f.name}`);
  }
  console.error(
    '\nEIAAW deploy contract: secrets live in Infisical and are referenced as\n' +
      '`secret://<project>/<env>/<NAME>` handles. Only the three INFISICAL_*\n' +
      'bootstrap credentials are ever raw, and they belong in Railway env, not git.\n',
  );
  process.exit(1);
}

process.exit(0);
