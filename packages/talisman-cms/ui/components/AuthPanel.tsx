import { useEffect, useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';

export function AuthPanel({ adminBasePath }: { adminBasePath: string }) {
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupToken, setSetupToken] = useState('');

  useEffect(() => {
    fetch(`${adminBasePath}/api/auth/setup`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => response.ok ? response.json() : null)
      .then((data: any) => setSetupRequired(data?.required === true))
      .catch(() => {});
  }, [adminBasePath]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const url = setupRequired ? `${adminBasePath}/api/auth/setup` : `${adminBasePath}/api/auth/sign-in/email`;
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(setupRequired ? { 'X-Talisman-Setup-Token': setupToken } : {}),
        },
        body: JSON.stringify(setupRequired ? { email, name, password } : { email, password }),
      });
      if (!response.ok) {
        const payload: any = await response.json().catch(() => ({}));
        throw new Error(payload.message || payload.error || 'Sign in failed');
      }
      if (setupRequired) {
        setSetupRequired(false);
        setSetupToken('');
        setPassword('');
      } else {
        window.location.reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4 text-zinc-100">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-8 shadow-2xl space-y-5">
        <Lock className="text-indigo-400" size={32} />
        <div>
          <h1 className="text-2xl font-semibold">{setupRequired ? 'Create the first admin' : 'Sign in to Talisman CMS'}</h1>
          <p className="mt-2 text-sm text-zinc-400">{setupRequired ? 'Use the setup token configured on the Worker.' : 'Enter your CMS account credentials.'}</p>
        </div>
        {setupRequired && <label className="block text-sm">Name<input required autoComplete="name" value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-zinc-950 px-3 py-2" /></label>}
        <label className="block text-sm">Email<input required type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-zinc-950 px-3 py-2" /></label>
        <label className="block text-sm">Password<input required type="password" minLength={setupRequired ? 12 : undefined} autoComplete={setupRequired ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-zinc-950 px-3 py-2" /></label>
        {setupRequired && <label className="block text-sm">Setup token<input required type="password" autoComplete="off" value={setupToken} onChange={event => setSetupToken(event.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-zinc-950 px-3 py-2" /></label>}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button disabled={loading} type="submit" className="w-full rounded-lg bg-indigo-500 px-4 py-2.5 font-medium text-white hover:bg-indigo-400 disabled:opacity-50">{loading ? 'Working…' : setupRequired ? 'Create admin' : 'Sign in'}</button>
      </form>
    </div>
  );
}
