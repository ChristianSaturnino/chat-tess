import type { SourceKind } from '@/db/schema';

export type SourceInput = {
  kind: SourceKind;
  /** Identificador estável no sistema de origem (URL, fileId, messageId…). */
  ref: string;
  title: string | null;
  url: string | null;
  excerpt?: string | null;
  contentHash?: string | null;
};

export type ToolResultItem = { content: string; source?: SourceInput };
export type ToolResult = { items: ToolResultItem[]; isError?: boolean };

export type ToolContext = {
  userId: string;
  conversationId: string;
  runId: string;
  signal: AbortSignal;
};

/**
 * Política de saída de dados:
 * - 'none': só lê de um sistema do próprio usuário (Drive, Gmail).
 * - 'reviewed': destino fixo cadastrado pelo dono (tool HTTP, servidor MCP).
 * - 'open': destino escolhido pelo modelo (scrape_page): bloqueado com contexto privado,
 *   exceto URLs já obtidas como fonte neste run/conversa.
 */
export type Egress = 'none' | 'reviewed' | 'open';

export type ToolFunction = {
  /** Nome enviado ao modelo: ^[a-zA-Z0-9_-]{1,64}$, único no run. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sideEffect: boolean;
  egress: Egress;
  /** Fontes produzidas por esta tool contam como privadas para a política. */
  privateData: boolean;
  timeoutMs: number;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

/** Um grupo habilitável por conversa (ex.: google:drive expõe drive_search e drive_read_file). */
export type ToolProvider = {
  key: string;
  version: string;
  label: string;
  functions: ToolFunction[];
  /** Revalidação antes de cada chamada (revogação, desconexão, exclusão). */
  stillAuthorized(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
};

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const toFunctionName = (...parts: string[]) => {
  const raw = parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return raw.slice(0, 64);
};
