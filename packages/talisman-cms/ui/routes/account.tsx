import { useState, type FormEvent } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';

export const Route = createFileRoute('/account')({ component: AccountPage });

function AccountPage() {
  const { context } = useRouter().options;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(''); setError('');
    const response = await fetch(`${context.adminBasePath}/api/auth/change-password`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) { setError(payload.message || payload.error || 'Password change failed'); return; }
    setCurrentPassword(''); setNewPassword(''); setNotice('Password changed. Other sessions were revoked.');
  }

  if (context.isDevAuth) return <p>Account settings are unavailable with the development auth adapter.</p>;
  if (context.isAccessAuth) return <p>Your account is managed through Cloudflare Access.</p>;
  if (context.isHybridAuth && context.user?.role === 'admin') return <p>Your admin sign-in is managed through Cloudflare Access.</p>;
  return <div className="max-w-xl space-y-6"><div><h1 className="text-3xl font-semibold">Account</h1><p className="mt-2 text-zinc-400">{context.user?.email}</p></div>
    <form onSubmit={changePassword} className="space-y-4 rounded-xl border border-white/10 bg-zinc-900/70 p-6">
      <h2 className="text-lg font-medium">Change password</h2>
      <label className="block text-sm">Current password<input required type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      <label className="block text-sm">New password<input required type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-1 w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
      {error && <p role="alert" className="text-red-400">{error}</p>}{notice && <p role="status" className="text-green-400">{notice}</p>}
      <button className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white">Change password</button>
    </form>
  </div>;
}
