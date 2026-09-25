import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';

type CmsAccount = { id: string; name: string; email: string; role: string; banned?: boolean };
type UserAction = { kind: 'role' | 'ban' | 'unban' | 'remove'; user: CmsAccount; role?: 'customer' | 'editor' | 'admin' };
const PAGE_SIZE = 50;

export const Route = createFileRoute('/users')({ component: UsersPage });

function UsersPage() {
  const { context } = useRouter().options;
  const base = `${context.adminBasePath}/api/auth/admin`;
  const [users, setUsers] = useState<CmsAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'editor' | 'admin'>('editor');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetUser, setResetUser] = useState<CmsAccount | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState<UserAction | null>(null);

  async function loadUsers(pageOffset = offset) {
    setLoading(true);
    try {
      const response = await fetch(`${base}/list-users?limit=${PAGE_SIZE}&offset=${pageOffset}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load CMS users');
      const payload = await response.json() as { users?: CmsAccount[]; total?: number };
      setUsers(Array.isArray(payload.users) ? payload.users : []);
      setTotal(typeof payload.total === 'number' ? payload.total : 0);
    } finally { setLoading(false); }
  }

  useEffect(() => { if (!context.isDevAuth && !context.isAccessAuth && context.user?.role === 'admin') loadUsers(offset).catch(cause => setError(String(cause))); }, [offset]);

  async function postAction(action: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/${action}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || `Could not ${action.replaceAll('-', ' ')}`);
  }

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
      if (offset === 0) await loadUsers(0);
      else setOffset(0);
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

  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const action = pending.kind === 'role' ? 'set-role' : pending.kind === 'ban' ? 'ban-user'
        : pending.kind === 'unban' ? 'unban-user' : 'remove-user';
      await postAction(action, { userId: pending.user.id, ...(pending.kind === 'role' ? { role: pending.role } : {}) });
      setNotice(`${pending.user.email}: ${pending.kind === 'role' ? `role changed to ${pending.role}` : pending.kind === 'ban' ? 'access disabled' : pending.kind === 'unban' ? 'access restored' : 'account removed'}.`);
      setPending(null);
      if (pending.kind === 'remove' && users.length === 1 && offset > 0) setOffset(offset - PAGE_SIZE);
      else await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  if (context.isDevAuth) return <p>Local user management is unavailable with the development auth adapter.</p>;
  if (context.isAccessAuth) return <p>CMS access is managed through Cloudflare Access and the Worker email allowlist.</p>;
  if (context.user?.role !== 'admin') return <p>Admin access required.</p>;
  return <div className="max-w-4xl space-y-8">
    <div><h1 className="text-3xl font-semibold">Users</h1><p className="mt-2 text-zinc-400">{context.isHybridAuth ? 'Shopper and editor accounts share an email identity. Editors use a CMS password; admins use Cloudflare.' : 'Create local accounts for editors and admins.'}</p></div>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {notice && <p role="status" className="text-green-400">{notice}</p>}
    <form onSubmit={createUser} className="grid gap-4 rounded-xl border border-white/10 bg-zinc-900/70 p-6 md:grid-cols-2">
      <h2 className="text-lg font-medium md:col-span-2">{context.isHybridAuth ? 'Add editor' : 'Add user'}</h2>
      <p className="text-sm text-zinc-400 md:col-span-2">If this email already belongs to a verified shopper, their existing identity gains editor access.</p>
      <label className="text-sm">Name<input required value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Temporary password<input required type="password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="text-sm">Role<select value={role} onChange={event => setRole(event.target.value as 'editor' | 'admin')} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2"><option value="editor">Editor</option>{!context.isHybridAuth && <option value="admin">Admin</option>}</select></label>
      <button disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 md:col-span-2">{busy ? 'Creating…' : 'Create user'}</button>
    </form>
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-white/5 text-zinc-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th></tr></thead>
        <tbody>{users.map(user => {
          const isSelf = user.id === context.user?.id;
          const isSso = context.isHybridAuth && user.role === 'admin';
          const isCustomer = user.role === 'customer';
          return <tr key={user.id} className="border-t border-white/10">
            <td className="px-4 py-3">{user.name}{isSelf && <span className="ml-2 text-xs text-zinc-500">You</span>}{isSso && <span className="ml-2 text-xs text-indigo-300">Cloudflare SSO</span>}</td>
            <td className="px-4 py-3">{user.email}</td>
            <td className="px-4 py-3">{context.isHybridAuth || isCustomer ? <span className="capitalize">{user.role}</span> : <select aria-label={`Role for ${user.email}`} disabled={busy || isSelf} value={user.role} onChange={event => { setResetUser(null); setPending({ kind: 'role', user, role: event.target.value as 'editor' | 'admin' }); }} className="rounded-md border border-white/15 bg-zinc-950 px-2 py-1 capitalize disabled:opacity-50"><option value="editor">Editor</option><option value="admin">Admin</option></select>}</td>
            <td className="px-4 py-3">{user.banned ? <span className="text-amber-300">Disabled</span> : <span className="text-green-300">Active</span>}</td>
            <td className="px-4 py-3"><div className="flex flex-wrap gap-x-3 gap-y-1">
              {isCustomer && <span className="text-zinc-500">Use {context.isHybridAuth ? 'Add editor' : 'Add user'} to grant CMS access</span>}
              {!isSso && !isCustomer && <button type="button" disabled={busy} onClick={() => { setPending(null); setResetUser(user); }} className="text-indigo-300 hover:text-indigo-200 disabled:opacity-50">Reset password</button>}
              {!isSelf && !isSso && !isCustomer && <button type="button" disabled={busy} onClick={() => { setResetUser(null); setPending({ kind: user.banned ? 'unban' : 'ban', user }); }} className="text-amber-300 hover:text-amber-200 disabled:opacity-50">{user.banned ? 'Enable' : 'Disable'}</button>}
              {!isSelf && !isSso && !isCustomer && context.isHybridAuth && <button type="button" disabled={busy} onClick={() => { setResetUser(null); setPending({ kind: 'role', user, role: 'customer' }); }} className="text-red-300 hover:text-red-200 disabled:opacity-50">Revoke CMS access</button>}
              {!isSelf && !isSso && !isCustomer && !context.isHybridAuth && <button type="button" disabled={busy} onClick={() => { setResetUser(null); setPending({ kind: 'remove', user }); }} className="text-red-300 hover:text-red-200 disabled:opacity-50">Remove</button>}
            </div></td>
          </tr>;
        })}</tbody></table>
      {!loading && users.length === 0 && <p className="p-4 text-sm text-zinc-400">No users found.</p>}
    </div>
    <div className="flex items-center justify-between gap-4 text-sm text-zinc-400">
      <span>{loading ? 'Loading…' : total ? `Showing ${offset + 1}–${offset + users.length} of ${total}` : '0 users'}</span>
      <div className="flex gap-3"><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="disabled:opacity-40">Previous</button><button type="button" disabled={loading || offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className="disabled:opacity-40">Next</button></div>
    </div>
    {pending && <form onSubmit={confirmAction} className="space-y-3 rounded-xl border border-amber-500/30 bg-zinc-900/70 p-6">
      <h2 className="text-lg font-medium">Confirm {pending.kind === 'role' ? 'role change' : pending.kind === 'ban' ? 'disable account' : pending.kind === 'unban' ? 'enable account' : 'account removal'}</h2>
      <p className="text-sm text-zinc-300">{pending.kind === 'role' ? pending.role === 'customer' ? `Revoke CMS access for ${pending.user.email}? Their CMS sessions will end. Their shopper account and orders remain.` : `Change ${pending.user.email} to ${pending.role}? Their current CMS sessions will end.` : pending.kind === 'ban' ? `Disable CMS access for ${pending.user.email}? Their current CMS sessions will end.` : pending.kind === 'unban' ? `Restore CMS access for ${pending.user.email}?` : `Permanently remove ${pending.user.email} and all of their CMS sessions? This cannot be undone.`}</p>
      <div className="flex gap-3"><button disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Working…' : 'Confirm'}</button><button type="button" onClick={() => setPending(null)} className="text-sm text-zinc-400">Cancel</button></div>
    </form>}
    {resetUser && <form onSubmit={resetPassword} className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/70 p-6"><h2 className="text-lg font-medium">Reset password for {resetUser.email}</h2><label className="block text-sm">New password<input required type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label><div className="flex gap-3"><button disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm text-white disabled:opacity-50">Reset password</button><button type="button" onClick={() => setResetUser(null)} className="text-sm text-zinc-400">Cancel</button></div></form>}
  </div>;
}
