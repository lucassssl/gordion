import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { loadCertificate } from '../src/mail/token-provider.js';

it('loads matching ephemeral RSA credentials and rejects a different private key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gordion-certificate-test-'));
  const key = join(directory, 'key.pem');
  const certificate = join(directory, 'certificate.pem');
  const otherKey = join(directory, 'other.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=Gordion-ephemeral-test', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    execFileSync('openssl', ['genrsa', '-out', otherKey, '2048'], { stdio: 'ignore' });
    const loaded = loadCertificate(certificate, key);
    expect(loaded.thumbprintSha256).toMatch(/^[A-F0-9]{64}$/);
    expect(loaded.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(() => loadCertificate(certificate, otherKey)).toThrow('do not match');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
