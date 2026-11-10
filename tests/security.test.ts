import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGmailBody } from '@/server/connectors/google/tools';
import { decrypt, encrypt } from '@/server/security/crypto';
import { assertUrlAllowed, isPublicAddress, safeFetch, SsrfBlockedError } from '@/server/security/ssrf';
import { sniffMime } from '@/server/storage/attachments';
import { startHttpServer, TINY_PNG } from './fixtures';

describe('SSRF guard', () => {
  it('aceita somente unicast público', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejeita esquemas, credenciais, hosts internos e portas fora do padrão', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'http://user:pw@example.com', 'http://localhost/', 'http://metadata.google.internal/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://example.com:6379/']) {
      expect(() => assertUrlAllowed(u), u).toThrow(SsrfBlockedError);
    }
    expect(assertUrlAllowed('https://example.com/a').hostname).toBe('example.com');
  });

  describe('redirects', () => {
    let srv: Awaited<ReturnType<typeof startHttpServer>>;
    beforeAll(async () => {
      srv = await startHttpServer((req, res) => {
        if (req.url === '/to-metadata') res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
        else if (req.url === '/to-other') res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end();
        else if (req.url === '/big') res.end('x'.repeat(5000));
        else res.end(`auth=${req.headers.authorization ?? ''}`);
      });
    });
    afterAll(() => srv.close());

    it('bloqueia redirect para metadata antes de conectar', async () => {
      await expect(safeFetch(`${srv.url}/to-metadata`)).rejects.toThrow(SsrfBlockedError);
    });

    it('bloqueia redirect para IP privado', async () => {
      await expect(safeFetch(`${srv.url}/to-other`)).rejects.toThrow(SsrfBlockedError);
    });

    it('limita bytes lidos', async () => {
      const r = await safeFetch(`${srv.url}/big`, { maxBytes: 1000 });
      expect(r.body.length).toBe(1000);
      expect(r.truncated).toBe(true);
    });
  });
});

describe('utilitários', () => {
  it('cifra e decifra com autenticação', () => {
    const c = encrypt('token-secreto');
    expect(c).not.toContain('token-secreto');
    expect(decrypt(c)).toBe('token-secreto');
    const tampered = c.slice(0, -2) + (c.endsWith('A') ? 'B' : 'A') + c.slice(-1);
    expect(() => decrypt(tampered)).toThrow();
  });

  it('detecta tipo pelos bytes', () => {
    expect(sniffMime(TINY_PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from('%PDF-1.7\n...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
  });

  it('decodifica MIME do Gmail preferindo text/plain e listando anexos', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const body = extractGmailBody({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64('Requisitos: 3 notebooks, 2 monitores.') } },
          { mimeType: 'text/html', body: { data: b64('<p>HTML</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'escopo.pdf', body: { attachmentId: 'x' } },
      ],
    });
    expect(body.text).toBe('Requisitos: 3 notebooks, 2 monitores.');
    expect(body.attachments).toEqual(['escopo.pdf']);
  });

  it('usa HTML sanitizado quando não há text/plain e não carrega imagens remotas', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const body = extractGmailBody({
      mimeType: 'text/html',
      body: { data: b64('<p>Olá <b>equipe</b></p><img src="https://rastreador.example/pixel.gif" alt=""><script>x()</script>') },
    });
    expect(body.text).toContain('Olá **equipe**');
    expect(body.text).not.toContain('rastreador');
    expect(body.text).not.toContain('x()');
  });
});
