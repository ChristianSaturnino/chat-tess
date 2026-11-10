import type { Db } from '@/db/client';
import { conversationHasPrivateData, knownWebUrls, normalizeUrl } from '../sources/sources';
import type { ToolFunction } from './types';

export type PolicyDecision = { allowed: true } | { allowed: false; code: string; message: string };

/**
 * Política contra exfiltração. Não depende de o modelo "obedecer": é aplicada antes da execução.
 * Com dado privado no contexto, tools de destino aberto só podem acessar URLs já obtidas como
 * fonte nesta conversa (ex.: resultados de busca), nunca um destino novo escolhido pelo modelo.
 */
export async function evaluateEgress(d: Db, fn: ToolFunction, args: Record<string, unknown>, conversationId: string): Promise<PolicyDecision> {
  if (fn.egress !== 'open') return { allowed: true };
  if (!(await conversationHasPrivateData(d, conversationId))) return { allowed: true };
  const url = typeof args.url === 'string' ? normalizeUrl(args.url) : null;
  if (url && (await knownWebUrls(d, conversationId)).has(url)) return { allowed: true };
  return {
    allowed: false,
    code: 'egress_blocked',
    message:
      'bloqueado pela política: a conversa contém dados privados (anexos, Drive ou Gmail) e o destino não é uma fonte já consultada. ' +
      'Peça ao usuário para abrir a página em outra conversa ou confirmar a fonte.',
  };
}
