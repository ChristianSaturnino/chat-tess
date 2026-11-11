'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { IconX } from './icons';
import { Badge, btn, btnGhost, btnPrimary, card as box, input, label } from './ui';

type Connection = { id: string; service: 'drive' | 'gmail'; status: string; externalEmail: string | null; lastError: string | null };
type HttpTool = { id: string; name: string; description: string; method: string; url: string; sideEffect: boolean; hasSecrets: boolean };
type McpServer = { id: string; name: string; url: string; status: string; lastError: string | null; tools: { name: string; description: string }[]; hasToken: boolean };
type Notice = { scope: string; tone: 'ok' | 'error'; text: string } | null;

/** Resultado de uma ação, exibido junto dela e trazido para a área visível do diálogo. */
function NoticeLine({ notice, scope }: { notice: Notice; scope: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const visible = notice?.scope === scope;
  useEffect(() => {
    if (visible) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [visible, notice]);
  if (!visible) return null;
  return (
    <p
      ref={ref}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg px-3 py-2 text-sm ${notice.tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent-ink'}`}
    >
      {notice.text}
    </p>
  );
}

export function Connectors({ onClose }: { onClose: () => void }) {
  const [conns, setConns] = useState<Connection[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [tools, setTools] = useState<HttpTool[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
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
    load().catch((e) => setNotice({ scope: 'top', tone: 'error', text: e.message }));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const err = new URLSearchParams(window.location.search).get('connect_error');
    if (err) setNotice({ scope: 'google', tone: 'error', text: `Conexão Google: ${err}` });
    return () => window.removeEventListener('keydown', onKey);
  }, [load, onClose]);

  const act: Act = async (scope, fn, ok) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice({ scope, tone: 'ok', text: ok });
      await load();
    } catch (e) {
      setNotice({ scope, tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:py-12" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface shadow-pop" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Conectores">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Conectores</h2>
            <p className="mt-0.5 text-xs text-muted">Fontes e ferramentas que você pode habilitar em cada conversa.</p>
          </div>
          <button onClick={onClose} className={`${btnGhost} -mr-1 h-8 w-8 p-0`} aria-label="Fechar">
            <IconX />
          </button>
        </div>
        <div className="space-y-7 px-5 py-5">
        <NoticeLine notice={notice} scope="top" />

        <section className="space-y-2.5">
          <h3 className={label}>Google</h3>
          {!googleConfigured && <p className="text-xs text-muted">OAuth Google não configurado no servidor.</p>}
          {(['drive', 'gmail'] as const).map((service) => {
            const c = conns.find((x) => x.service === service);
            const active = c?.status === 'active';
            return (
              <div key={service} className={`${box} flex items-center justify-between gap-2`}>
                <div className="text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    {service === 'drive' ? 'Google Drive' : 'Gmail'}
                    <Badge tone={active ? 'accent' : c?.status === 'reconnect_required' ? 'warn' : 'neutral'}>{active ? 'conectado' : c?.status === 'reconnect_required' ? 'reconectar' : 'somente leitura'}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {active ? `Conectado: ${c?.externalEmail ?? ''}` : c?.status === 'reconnect_required' ? `Reconexão necessária${c.lastError ? `: ${c.lastError}` : ''}` : 'Não conectado'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {googleConfigured && (
                    <a className={active ? btn : `${btnPrimary} px-2.5 py-1 text-xs`} href={`/api/connections/google/start?service=${service}`}>{active ? 'Reautorizar' : 'Conectar'}</a>
                  )}
                  {c && c.status !== 'revoked' && (
                    <button disabled={busy} className={btn} onClick={() => act('google', () => api(`/api/connections/${c.id}`, { method: 'DELETE' }), 'Conexão revogada.')}>Desconectar</button>
                  )}
                </div>
              </div>
            );
          })}
          <NoticeLine notice={notice} scope="google" />
        </section>

        <McpSection servers={servers} busy={busy} act={act} notice={notice} />
        <HttpSection tools={tools} busy={busy} act={act} notice={notice} />
        </div>
      </div>
    </div>
  );
}

type Act = (scope: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function McpSection({ servers, busy, act, notice }: { servers: McpServer[]; busy: boolean; act: Act; notice: Notice }) {
  const [form, setForm] = useState({ name: '', url: '', bearerToken: '' });
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className={label}>Servidores MCP</h3>
        <p className="mt-0.5 text-xs text-muted">Streamable HTTP, token bearer opcional.</p>
      </div>
      {servers.map((s) => (
        <div key={s.id} className={box}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm">
              <div className="flex items-center gap-2 font-medium">{s.name} <Badge tone={s.status === 'active' ? 'accent' : 'danger'}>{s.status === 'active' ? 'ativo' : s.status === 'error' ? 'erro' : s.status}</Badge></div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted">{s.url}</div>
            </div>
            <div className="flex gap-2">
              <button disabled={busy} className={btn} onClick={() => act(`mcp:${s.id}`, () => api(`/api/mcp-servers/${s.id}/sync`, { method: 'POST' }), 'Catálogo sincronizado.')}>Sincronizar</button>
              <button disabled={busy} className={btn} onClick={() => act(`mcp:${s.id}`, () => api(`/api/mcp-servers/${s.id}`, { method: 'DELETE' }))}>Remover</button>
            </div>
          </div>
          {s.lastError && <p className="mt-2 text-xs text-danger">{s.lastError}</p>}
          {s.tools.length > 0 && <p className="mt-2 text-xs text-muted">Tools: {s.tools.map((t) => t.name).join(', ')}</p>}
          <div className="mt-2 empty:hidden">
            <NoticeLine notice={notice} scope={`mcp:${s.id}`} />
          </div>
        </div>
      ))}
      <div className={`${box} grid gap-2 border-dashed bg-subtle/40 sm:grid-cols-3`}>
        <input className={input} placeholder="nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={input} placeholder="https://servidor/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className={input} placeholder="token (opcional)" type="password" value={form.bearerToken} onChange={(e) => setForm({ ...form, bearerToken: e.target.value })} />
        <button
          disabled={busy || !form.name || !form.url}
          className={`${btnPrimary} py-1.5 sm:col-span-3`}
          onClick={() =>
            act('mcp-new', async () => {
              await api('/api/mcp-servers', { method: 'POST', body: JSON.stringify({ name: form.name, url: form.url, bearerToken: form.bearerToken || undefined }) });
              setForm({ name: '', url: '', bearerToken: '' });
            }, 'Servidor cadastrado. Habilite-o na conversa pelo menu Ferramentas.')
          }
        >
          Adicionar servidor MCP
        </button>
        <div className="empty:hidden sm:col-span-3">
          <NoticeLine notice={notice} scope="mcp-new" />
        </div>
      </div>
    </section>
  );
}

const exampleSchema = '{\n  "type": "object",\n  "properties": { "moeda": { "type": "string" } },\n  "required": ["moeda"]\n}';

function HttpSection({ tools, busy, act, notice }: { tools: HttpTool[]; busy: boolean; act: Act; notice: Notice }) {
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', url: '', parameters: exampleSchema, authorization: '' });
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className={label}>Tools HTTP</h3>
        <p className="mt-0.5 text-xs text-muted">Secrets ficam no servidor, fora do prompt.</p>
      </div>
      {tools.map((t) => (
        <div key={t.id} className={box}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm">
              <div className="flex flex-wrap items-center gap-1.5 font-medium">
                {t.name} <Badge>{t.method}</Badge>
                {t.sideEffect && <Badge tone="warn">efeito externo</Badge>}
                {t.hasSecrets && <Badge>com secret</Badge>}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted">{t.url}</div>
            </div>
            <button disabled={busy} className={btn} onClick={() => act(`http:${t.id}`, () => api(`/api/tools/${t.id}`, { method: 'DELETE' }))}>Remover</button>
          </div>
          <div className="mt-2 flex gap-2">
            <input className={input} placeholder='argumentos de teste, ex.: {"moeda":"USD"}' value={testArgs[t.id] ?? ''} onChange={(e) => setTestArgs({ ...testArgs, [t.id]: e.target.value })} />
            <button
              disabled={busy}
              className={btn}
              onClick={() =>
                act(`http:${t.id}`, async () => {
                  const r = await api<{ ok: boolean; preview: string; durationMs: number }>(`/api/tools/${t.id}/test`, { method: 'POST', body: testArgs[t.id] || '{}' });
                  setTestResult({ ...testResult, [t.id]: `${r.ok ? 'OK' : 'Falhou'} em ${r.durationMs} ms\n${r.preview}` });
                })
              }
            >
              Testar
            </button>
          </div>
          <div className="mt-2 empty:hidden">
            <NoticeLine notice={notice} scope={`http:${t.id}`} />
          </div>
          {testResult[t.id] && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-subtle p-2 font-mono text-xs text-muted">{testResult[t.id]}</pre>}
        </div>
      ))}
      <div className={`${box} space-y-2 border-dashed bg-subtle/40`}>
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
          className={`${btnPrimary} w-full py-1.5`}
          onClick={() =>
            act('http-new', async () => {
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
              setForm({ name: '', description: '', method: 'GET', url: '', parameters: exampleSchema, authorization: '' });
            }, 'Tool cadastrada. Habilite-a na conversa pelo menu Ferramentas.')
          }
        >
          Cadastrar tool HTTP
        </button>
        <NoticeLine notice={notice} scope="http-new" />
      </div>
    </section>
  );
}
