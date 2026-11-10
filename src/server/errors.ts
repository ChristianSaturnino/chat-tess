export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'recurso') => new AppError(404, 'not_found', `${what} não encontrado`);
export const forbidden = () => new AppError(403, 'forbidden', 'acesso negado');
export const unauthorized = () => new AppError(401, 'unauthorized', 'sessão necessária');
