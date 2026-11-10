import { redirect } from 'next/navigation';
import { AdminView } from '@/components/AdminView';
import { currentUser } from '@/server/http';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/');
  if (user.role !== 'admin') {
    return <main className="mx-auto max-w-xl px-4 py-16 text-center text-sm">Acesso restrito a administradores.</main>;
  }
  return <AdminView />;
}
