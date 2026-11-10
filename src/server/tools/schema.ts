import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '../errors';
import { ToolError } from './types';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

/** Valida que o schema compila (cadastro de tool). */
export function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const hit = cache.get(schema);
  if (hit) return hit;
  try {
    const fn = ajv.compile(schema);
    cache.set(schema, fn);
    return fn;
  } catch (err) {
    throw new AppError(400, 'invalid_schema', `JSON Schema inválido: ${(err as Error).message}`);
  }
}

/** Argumentos vindos do modelo são validados antes de qualquer execução. */
export function validateArgs(schema: Record<string, unknown>, args: unknown) {
  let fn: ValidateFunction;
  try {
    fn = compileSchema(schema);
  } catch {
    throw new ToolError('invalid_schema', 'schema da tool não compila');
  }
  if (!fn(args)) {
    const msg = (fn.errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message}`).join('; ');
    throw new ToolError('invalid_arguments', `argumentos inválidos: ${msg}`);
  }
}
