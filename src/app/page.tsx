import { Chat } from '@/components/Chat';
import { Login } from '@/components/Login';
import { currentUser } from '@/server/http';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Login />;
  return <Chat user={{ name: user.name, kind: user.kind }} />;
}
