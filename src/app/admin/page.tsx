import { redirect } from 'next/navigation';
import { AdminView } from '@/components/AdminView';
import { currentUser } from '@/server/http';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/');
  if (user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="text-lg font-semibold">Acesso restrito</h1>
        <p className="mt-1.5 text-sm text-muted">Esta página é só para administradores.</p>
        <a href="/" className="mt-5 inline-block text-sm font-medium text-accent-ink underline underline-offset-2">Voltar ao chat</a>
      </main>
    );
  }
  return <AdminView />;
}
