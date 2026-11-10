import { NextResponse } from 'next/server';
import { listConnections } from '@/server/connectors/google/oauth';
import { config } from '@/server/config';
import { requireUser, route } from '@/server/http';

export const GET = route(async () => {
  const user = await requireUser();
  const { env } = config();
  return NextResponse.json({
    connections: await listConnections(user.id),
    googleConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  });
});
