import { X509Certificate, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Pki {
  key: string
  cert: string
  /** base64 SHA-256 of the certificate's public key: the value of Chrome's --ignore-certificate-errors-spki-list. */
  spki: string
}

// One self-signed certificate for every local fake that speaks TLS: *.zoom.us (Chrome trusts it by its public-key hash,
// a flag only the test passes) and localhost (the ASR socket, trusted by the test process alone).
export function makePki(): Pki {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tm-e2e-pki-'))
  try {
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=tm-e2e'],
        ...['-addext', 'subjectAltName=DNS:*.zoom.us,DNS:zoom.us,DNS:localhost,IP:127.0.0.1'],
        ...['-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]
      ],
      { stdio: 'pipe' }
    )
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    const der = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert,
      spki: createHash('sha256').update(der).digest('base64')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
