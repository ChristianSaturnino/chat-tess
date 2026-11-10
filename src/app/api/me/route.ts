import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { balance } from '@/server/credits/credits';
import { requireUser, route } from '@/server/http';

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ user, credits: await balance(db(), user.id) });
});
