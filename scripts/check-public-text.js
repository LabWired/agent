#!/usr/bin/env node
'use strict';

const fs = require('fs');

function decodeText(data) {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return data.subarray(2).toString('utf16le');
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.alloc(data.length - 2);
    for (let i = 2; i + 1 < data.length; i += 2) {
      swapped[i - 2] = data[i + 1];
      swapped[i - 1] = data[i];
    }
    return swapped.toString('utf16le');
  }

  const sample = data.subarray(0, Math.min(data.length, 4096));
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2) oddNul++;
      else evenNul++;
    }
  }
  const pairs = Math.max(1, Math.floor(sample.length / 2));
  if (oddNul / pairs > 0.3 && evenNul / pairs < 0.05)
    return data.toString('utf16le');
  if (evenNul / pairs > 0.3 && oddNul / pairs < 0.05) {
    const swapped = Buffer.alloc(data.length);
    for (let i = 0; i + 1 < data.length; i += 2) {
      swapped[i] = data[i + 1];
      swapped[i + 1] = data[i];
    }
    return swapped.toString('utf16le');
  }

  if (sample.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    let controls = 0;
    for (const char of text.slice(0, 4096)) {
      const code = char.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls++;
    }
    return controls / Math.max(1, Math.min(text.length, 4096)) > 0.02 ? null : text;
  } catch {
    return null;
  }
}

function scanText(text, file, report) {
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const assignments = /"?(DEEPINFRA_API_KEY|LABWIRED_ACCESS_TOKEN)"?\s*(?:=(?!=)|:(?![-+?=0-9]))\s*(?:"([^"]*)"|'([^']*)'|(\$\{\{.*?\}\})|([^\s,;#`]+))/g;
  const dynamic = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{\{[^}]+\}\}|\$\(.+\)|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/;
  text.split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    if (line.includes('/' + 'Users/')) report(file, number, 'private local path');
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(line)) report(file, number, 'private key header');
    for (const match of line.matchAll(email)) {
      if (match[0].toLowerCase() !== 'example@example.com') report(file, number, 'real email address');
    }
    for (const match of line.matchAll(assignments)) {
      const value = match[2] ?? match[3] ?? match[4] ?? match[5];
      const placeholder = value === 'test-token' || (match[1] === 'DEEPINFRA_API_KEY' && value === '…');
      if (!placeholder && !dynamic.test(value)) report(file, number, `assigned ${match[1]} secret value`);
    }
  });
}

function scanBuffer(data, file, report) {
  const text = decodeText(data);
  if (text !== null) scanText(text, file, report);
}

function selfTest() {
  const key = 'DEEPINFRA_API_' + 'KEY';
  const token = 'LABWIRED_ACCESS_' + 'TOKEN';
  const begin = '-----Be' + 'GiN OpEnSsH PrIvAtE KeY-----';
  const rejected = [
    Buffer.from(`${key}=sk-live(secret)`),
    Buffer.from(`${token}=actual$key`),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${key}=utf16-secret`, 'utf16le')]),
    Buffer.from(begin),
    Buffer.from(`"${token}"` + ': "json-secret",'),
    Buffer.from(`${key}` + ': yaml-secret'),
  ];
  const allowed = [
    `${key}=…`, `${token}=test-token`, `${key}=$KEY`,
    `${token}=\${TOKEN}`, `${key}=$(load_key)`, `${token}={env:TOKEN}`,
    `"${token}"` + ': "test-token",', `${key}` + ': …',
    `"${key}"` + ': "$KEY"', `${token}` + ': {env:TOKEN}',
  ].map(value => Buffer.from(value));
  for (const [index, fixture] of rejected.entries()) {
    let failures = 0;
    scanBuffer(fixture, `negative-${index}`, () => failures++);
    if (!failures) throw new Error(`negative scanner fixture ${index} was accepted`);
  }
  for (const [index, fixture] of allowed.entries()) {
    let failures = 0;
    scanBuffer(fixture, `allowed-${index}`, () => failures++);
    if (failures) throw new Error(`allowed scanner fixture ${index} was rejected`);
  }
  process.stdout.write('ok   public text scanner fixtures\n');
}

module.exports = { decodeText, scanBuffer, scanText };
if (require.main === module && process.argv.includes('--self-test')) selfTest();
