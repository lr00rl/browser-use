#!/usr/bin/env node

// Fails when a file git would publish contains data that identifies a machine, a person, or a live browser session.
// Real-browser testing produces exactly this kind of data, so the check runs in CI and before publishing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  [/\/(?:Users|home)\/(?!(?:you|me|runner|user|USER)\/)[A-Za-z0-9._-]+\//, 'absolute home directory path'],
  [/\b[A-F0-9]{32}\b/, 'Chrome target or browser context ID'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, 'email address'],
  [/(?:\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/, 'credential-like token'],
  [/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/, 'CJK text (the published project is English only)'],
];

// With arguments, check those files; otherwise check everything git would publish.
let files = process.argv.slice(2);
if (files.length === 0) {
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    console.error('check-redaction must run inside a git checkout, or be given files to check');
    process.exit(2);
  }
}

const findings = [];
for (const file of files) {
  let content;
  try { content = readFileSync(file); } catch { continue; }
  if (content.includes(0)) continue; // binary
  const lines = content.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    for (const [pattern, label] of RULES) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    }
  });
}

if (findings.length) {
  console.error(`Possible private data in ${findings.length} place(s):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`check-redaction: ${files.length} files clean`);
