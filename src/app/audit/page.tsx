import { redirect } from 'next/navigation';
import { AuditView } from '@/components/AuditView';
import { currentUser } from '@/server/http';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const user = await currentUser();
  if (!user) redirect('/');
  return <AuditView isAdmin={user.role === 'admin'} />;
}
