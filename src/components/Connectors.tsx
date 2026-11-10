'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Connection = { id: string; service: 'drive' | 'gmail'; status: string; externalEmail: string | null; lastError: string | null };
type HttpTool = { id: string; name: string; description: string; method: string; url: string; sideEffect: boolean; hasSecrets: boolean };
type McpServer = { id: string; name: string; url: string; status: string; lastError: string | null; tools: { name: string; description: string }[]; hasToken: boolean };

const box = 'rounded-md border border-[var(--border)] p-3';
const input = 'w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm';
const btn = 'rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50';

export function Connectors({ onClose }: { onClose: () => void }) {
  const [conns, setConns] = useState<Connection[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [tools, setTools] = useState<HttpTool[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, t, s] = await Promise.all([
      api<{ connections: Connection[]; googleConfigured: boolean }>('/api/connections'),
      api<{ tools: HttpTool[] }>('/api/tools'),
      api<{ servers: McpServer[] }>('/api/mcp-servers'),
    ]);
    setConns(c.connections);
    setGoogleConfigured(c.googleConfigured);
    setTools(t.tools);
    setServers(s.servers);
  }, []);

  useEffect(() => {
    load().catch((e) => setMsg(e.message));
    const err = new URLSearchParams(window.location.search).get('connect_error');
    if (err) setMsg(`Conexão Google: ${err}`);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl space-y-4 rounded-lg bg-[var(--panel)] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Conectores</h2>
          <button onClick={onClose} className={btn}>Fechar</button>
        </div>
        {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}

        <section className="space-y-2">
          <h3 className="font-medium">Google</h3>
          {!googleConfigured && <p className="text-xs text-[var(--muted)]">OAuth Google não configurado no servidor.</p>}
          {(['drive', 'gmail'] as const).map((service) => {
            const c = conns.find((x) => x.service === service);
            const active = c?.status === 'active';
            return (
              <div key={service} className={`${box} flex items-center justify-between gap-2`}>
                <div className="text-sm">
                  <div className="font-medium">{service === 'drive' ? 'Google Drive' : 'Gmail'} <span className="text-xs text-[var(--muted)]">(somente leitura)</span></div>
                  <div className="text-xs text-[var(--muted)]">
                    {active ? `Conectado: ${c?.externalEmail ?? ''}` : c?.status === 'reconnect_required' ? `Reconexão necessária${c.lastError ? `: ${c.lastError}` : ''}` : 'Não conectado'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {googleConfigured && (
                    <a className={btn} href={`/api/connections/google/start?service=${service}`}>{active ? 'Reautorizar' : 'Conectar'}</a>
                  )}
                  {c && c.status !== 'revoked' && (
                    <button disabled={busy} className={btn} onClick={() => act(() => api(`/api/connections/${c.id}`, { method: 'DELETE' }), 'Conexão revogada.')}>Desconectar</button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        <McpSection servers={servers} busy={busy} act={act} />
        <HttpSection tools={tools} busy={busy} act={act} />
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function McpSection({ servers, busy, act }: { servers: McpServer[]; busy: boolean; act: Act }) {
  const [form, setForm] = useState({ name: '', url: '', bearerToken: '' });
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Servidores MCP <span className="text-xs text-[var(--muted)]">(Streamable HTTP, token bearer opcional)</span></h3>
      {servers.map((s) => (
        <div key={s.id} className={box}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm">
              <div className="font-medium">{s.name} <span className="text-xs text-[var(--muted)]">{s.status}</span></div>
              <div className="truncate text-xs text-[var(--muted)]">{s.url}</div>
            </div>
            <div className="flex gap-2">
              <button disabled={busy} className={btn} onClick={() => act(() => api(`/api/mcp-servers/${s.id}/sync`, { method: 'POST' }), 'Catálogo sincronizado.')}>Sincronizar</button>
              <button disabled={busy} className={btn} onClick={() => act(() => api(`/api/mcp-servers/${s.id}`, { method: 'DELETE' }))}>Remover</button>
            </div>
          </div>
          {s.lastError && <p className="mt-1 text-xs text-red-600">{s.lastError}</p>}
          {s.tools.length > 0 && <p className="mt-1 text-xs text-[var(--muted)]">Tools: {s.tools.map((t) => t.name).join(', ')}</p>}
        </div>
      ))}
      <div className={`${box} grid gap-2 sm:grid-cols-3`}>
        <input className={input} placeholder="nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={input} placeholder="https://servidor/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className={input} placeholder="token (opcional)" type="password" value={form.bearerToken} onChange={(e) => setForm({ ...form, bearerToken: e.target.value })} />
        <button
          disabled={busy || !form.name || !form.url}
          className={`${btn} sm:col-span-3`}
          onClick={() =>
            act(async () => {
              await api('/api/mcp-servers', { method: 'POST', body: JSON.stringify({ name: form.name, url: form.url, bearerToken: form.bearerToken || undefined }) });
              setForm({ name: '', url: '', bearerToken: '' });
            }, 'Servidor cadastrado. Habilite-o na conversa pelo menu Ferramentas.')
          }
        >
          Adicionar servidor MCP
        </button>
      </div>
    </section>
  );
}

const exampleSchema = '{\n  "type": "object",\n  "properties": { "moeda": { "type": "string" } },\n  "required": ["moeda"]\n}';

function HttpSection({ tools, busy, act }: { tools: HttpTool[]; busy: boolean; act: Act }) {
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', url: '', parameters: exampleSchema, authorization: '' });
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Tools HTTP <span className="text-xs text-[var(--muted)]">(secrets ficam no servidor, fora do prompt)</span></h3>
      {tools.map((t) => (
        <div key={t.id} className={box}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm">
              <div className="font-medium">{t.name} <span className="text-xs text-[var(--muted)]">{t.method}{t.sideEffect ? ' · efeito externo' : ''}{t.hasSecrets ? ' · com secret' : ''}</span></div>
              <div className="truncate text-xs text-[var(--muted)]">{t.url}</div>
            </div>
            <button disabled={busy} className={btn} onClick={() => act(() => api(`/api/tools/${t.id}`, { method: 'DELETE' }))}>Remover</button>
          </div>
          <div className="mt-2 flex gap-2">
            <input className={input} placeholder='argumentos de teste, ex.: {"moeda":"USD"}' value={testArgs[t.id] ?? ''} onChange={(e) => setTestArgs({ ...testArgs, [t.id]: e.target.value })} />
            <button
              disabled={busy}
              className={btn}
              onClick={() =>
                act(async () => {
                  const r = await api<{ ok: boolean; preview: string; durationMs: number }>(`/api/tools/${t.id}/test`, { method: 'POST', body: testArgs[t.id] || '{}' });
                  setTestResult({ ...testResult, [t.id]: `${r.ok ? 'OK' : 'Falhou'} em ${r.durationMs} ms\n${r.preview}` });
                })
              }
            >
              Testar
            </button>
          </div>
          {testResult[t.id] && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-[var(--muted)]">{testResult[t.id]}</pre>}
        </div>
      ))}
      <div className={`${box} space-y-2`}>
        <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
          <input className={input} placeholder="nome (ex.: cotacao)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className={input} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            <option>GET</option>
            <option>POST</option>
          </select>
        </div>
        <input className={input} placeholder="descrição para o modelo" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input className={input} placeholder="https://api.exemplo.com/endpoint" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className={input} type="password" placeholder="Authorization (opcional, ex.: Bearer xyz)" value={form.authorization} onChange={(e) => setForm({ ...form, authorization: e.target.value })} />
        <textarea className={`${input} font-mono`} rows={5} value={form.parameters} onChange={(e) => setForm({ ...form, parameters: e.target.value })} />
        <button
          disabled={busy || !form.name || !form.url || !form.description}
          className={btn}
          onClick={() =>
            act(async () => {
              let parameters: unknown;
              try {
                parameters = JSON.parse(form.parameters);
              } catch {
                throw new Error('JSON Schema inválido');
              }
              await api('/api/tools', {
                method: 'POST',
                body: JSON.stringify({
                  name: form.name,
                  description: form.description,
                  method: form.method,
                  url: form.url,
                  parameters,
                  secretHeaders: form.authorization ? { Authorization: form.authorization } : undefined,
                }),
              });
              setForm({ ...form, name: '', description: '', url: '', authorization: '' });
            }, 'Tool cadastrada. Habilite-a na conversa pelo menu Ferramentas.')
          }
        >
          Cadastrar tool HTTP
        </button>
      </div>
    </section>
  );
}
