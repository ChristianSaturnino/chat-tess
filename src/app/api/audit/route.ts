import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { listAudit } from '@/server/admin/admin';
import { requireUser, route } from '@/server/http';

const query = z.object({
  all: z.enum(['1', '0']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  action: z.string().max(60).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const events = await listAudit(user, { all: q.all === '1', before: q.before, limit: q.limit, action: q.action });
  return NextResponse.json({ events });
});
