import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Servidor HTTP local para testes; o host:porta é liberado explicitamente no SSRF guard. */
export async function startHttpServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  allowHost(`localhost:${port}`);
  return { url: `http://localhost:${port}`, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function allowHost(hostPort: string) {
  const set = new Set((process.env.SSRF_ALLOW_HOSTS ?? '').split(',').filter(Boolean));
  set.add(hostPort);
  process.env.SSRF_ALLOW_HOSTS = [...set].join(',');
}

/** Sobe o servidor MCP de demonstração como processo separado. */
export async function startMcpDemo(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp-demo/server.ts'], {
    env: { ...process.env, MCP_DEMO_PORT: String(port), MCP_DEMO_TOKEN: 'segredo-demo' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('MCP demo não subiu')), 15_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('MCP demo em')) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`MCP demo saiu com código ${code}`)));
  });
  allowHost(`localhost:${port}`);
  return child;
}

export const stopProcess = (child: ChildProcess) =>
  new Promise<void>((r) => {
    child.once('exit', () => r());
    child.kill();
  });

/** PNG mínimo válido (1x1). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
