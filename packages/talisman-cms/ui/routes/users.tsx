import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';

type CmsAccount = { id: string; name: string; email: string; role: string; banned?: boolean };

export const Route = createFileRoute('/users')({ component: UsersPage });

function UsersPage() {
  const { context } = useRouter().options;
  const base = `${context.adminBasePath}/api/auth/admin`;
  const [users, setUsers] = useState<CmsAccount[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'editor' | 'admin'>('editor');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetUser, setResetUser] = useState<CmsAccount | null>(null);
  const [newPassword, setNewPassword] = useState('');

  async function loadUsers() {
    const response = await fetch(`${base}/list-users?limit=100`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load CMS users');
    const payload: any = await response.json();
    setUsers(Array.isArray(payload.users) ? payload.users : []);
  }

  useEffect(() => { if (!context.isDevAuth && !context.isAccessAuth) loadUsers().catch(cause => setError(String(cause))); }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${base}/create-user`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role }),
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || 'Could not create user');
      setNotice(`${email} can now sign in.`);
      setName(''); setEmail(''); setPassword(''); setRole('editor');
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetUser) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`${base}/set-user-password`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: resetUser.id, newPassword }),
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || 'Could not reset password');
      setNotice(`Password updated for ${resetUser.email}; existing sessions were revoked.`);
      setResetUser(null); setNewPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  if (context.isDevAuth) return <p>Local user management is unavailable with the development auth adapter.</p>;
  if (context.isAccessAuth) return <p>CMS access is managed through Cloudflare Access and the Worker email allowlist.</p>;
  if (context.user?.role !== 'admin') return <p>Admin access required.</p>;
  return <div className="max-w-4xl space-y-8">
    <div><h1 className="text-3xl font-semibold">CMS users</h1><p className="mt-2 text-zinc-400">Create local accounts for editors and admins.</p></div>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {notice && <p role="status" className="text-green-400">{notice}</p>}
    <form onSubmit={createUser} className="grid gap-4 rounded-xl border border-white/10 bg-zinc-900/70 p-6 md:grid-cols-2">
      <h2 className="text-lg font-medium md:col-span-2">Add user</h2>
      <label className="text-sm">Name<input required value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Temporary password<input required type="password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Role<select value={role} onChange={event => setRole(event.target.value as 'editor' | 'admin')} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2"><option value="editor">Editor</option><option value="admin">Admin</option></select></label>
      <button disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 md:col-span-2">{busy ? 'Creating…' : 'Create user'}</button>
    </form>
    <div className="overflow-hidden rounded-xl border border-white/10">
      <table className="w-full text-left text-sm"><thead className="bg-white/5 text-zinc-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Action</th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-t border-white/10"><td className="px-4 py-3">{user.name}</td><td className="px-4 py-3">{user.email}</td><td className="px-4 py-3 capitalize">{user.role}</td><td className="px-4 py-3"><button onClick={() => setResetUser(user)} className="text-indigo-300 hover:text-indigo-200">Reset password</button></td></tr>)}</tbody></table>
    </div>
    {resetUser && <form onSubmit={resetPassword} className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/70 p-6"><h2 className="text-lg font-medium">Reset password for {resetUser.email}</h2><label className="block text-sm">New password<input required type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label><div className="flex gap-3"><button disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm text-white disabled:opacity-50">Reset password</button><button type="button" onClick={() => setResetUser(null)} className="text-sm text-zinc-400">Cancel</button></div></form>}
  </div>;
}
