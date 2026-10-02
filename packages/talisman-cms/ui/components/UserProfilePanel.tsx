import React, { useEffect, useRef, useState } from 'react';

type Profile = { user: { id: string; name: string; email: string }; version: string; editable: boolean };
type Session = { id: string; current: boolean; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; authMethod: string | null };

export function UserProfilePanel({ userId, base, onClose, onChanged }: {
  userId: string; base: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [requestedEmail, setRequestedEmail] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (requestedEmail) codeInput.current?.focus(); }, [requestedEmail]);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const sessionTrigger = useRef<HTMLButtonElement | null>(null);
  async function action<T>(path: string, values: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${base}/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, ...values }), signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'The request could not be completed.';
      throw new Error(message);
    }
    return data as T;
  }
  async function loadSessions(offset = 0, signal?: AbortSignal) {
    const page = await action<{ sessions: Session[]; nextOffset: number | null }>('list-user-sessions', { offset }, signal);
    if (signal?.aborted) return;
    setSessions(current => offset ? [...current, ...page.sessions] : page.sessions); setNextOffset(page.nextOffset); setSessionsLoaded(true);
  }
  async function loadProfile(signal?: AbortSignal) {
    const data = await action<Profile>('get-user-profile', {}, signal);
    if (signal?.aborted) return;
    setProfile(data); setName(data.user.name); setEmail(data.user.email); setRequestedEmail(''); setCode('');
  }
  useEffect(() => {
    heading.current?.focus();
    const controller = new AbortController();
    Promise.all([loadProfile(controller.signal), loadSessions(0, controller.signal)])
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, base]);
  useEffect(() => { if (pendingSession) confirmHeading.current?.focus(); }, [pendingSession]);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The request failed.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="user-profile-heading" className="space-y-6 rounded-xl border border-white/10 bg-zinc-900/70 p-6">
    <div className="flex justify-between gap-4"><h2 id="user-profile-heading" ref={heading} tabIndex={-1} className="text-lg font-medium focus:outline-none">Profile and CMS sessions{profile ? ` · ${profile.user.email}` : ''}</h2>
      <button type="button" disabled={busy} onClick={onClose} className="text-zinc-400">Close</button></div>
    <p role="alert" className={error ? 'text-red-300' : 'sr-only'}>{error}</p>
    <p role="status" className={notice ? 'text-green-300' : 'sr-only'}>{notice || (loading ? 'Loading profile and sessions…' : busy ? 'Working…' : '')}</p>
    {error && <button type="button" disabled={busy} onClick={() => void run(async () => { await loadProfile(); await loadSessions(); setLoading(false); })} className="text-indigo-300 underline">Reload profile and sessions (replace edits)</button>}
    {profile && !profile.editable && <p className="text-zinc-400">This profile is managed through its sign-in provider or shopper account. CMS sessions can still be ended below.</p>}
    {profile?.editable && <>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await action<{ version: string }>('update-user-profile', { name, version: profile.version });
        setProfile({ ...profile, user: { ...profile.user, name: name.trim() }, version: result.version });
        setNotice('Profile name saved.'); await onChanged();
      }); }}>
        <label className="block text-sm">Profile name<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} className="mt-1 block w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
        <button disabled={busy || !name.trim()} className="text-indigo-300 underline disabled:opacity-50">Save profile name</button>
      </form>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await action<{ message: string }>('request-email-change', { email, version: profile.version });
        setRequestedEmail(email.trim().toLowerCase()); setCode(''); setNotice(result.message);
      }); }}>
        <label className="block text-sm">New sign-in email<input required type="email" maxLength={254} disabled={Boolean(requestedEmail)} value={email} onChange={event => setEmail(event.target.value)} className="mt-1 block w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2" /></label>
        <p className="text-sm text-zinc-400">The new address must be confirmed. The existing address is notified. Confirming ends existing CMS and linked shopper sessions while preserving the account and its orders.</p>
        {!requestedEmail && <button disabled={busy || email.trim().toLowerCase() === profile.user.email.toLowerCase()} className="text-indigo-300 underline disabled:opacity-50">Send confirmation code</button>}
      </form>
      {requestedEmail && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await action<{ currentSessionEnded: boolean; message: string }>('confirm-email-change', { code: code.trim() });
        if (result.currentSessionEnded) { window.location.assign(base.replace(/\/api\/auth\/admin$/, '') || '/'); return; }
        await loadProfile(); await loadSessions(); setNotice(result.message); await onChanged();
      }); }}>
        <label className="block text-sm">Confirmation code from {requestedEmail}<input ref={codeInput} required autoComplete="off" spellCheck={false} maxLength={48} value={code} onChange={event => setCode(event.target.value)} className="mt-1 block w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-2 font-mono" /></label>
        <button disabled={busy || code.trim().length !== 48} className="text-indigo-300 underline disabled:opacity-50">Confirm email change</button>
        <button type="button" disabled={busy} onClick={() => { setRequestedEmail(''); setCode(''); }} className="ml-4 text-zinc-400">Use another address</button>
      </form>}
    </>}
    <div className="space-y-3"><h3 className="font-medium">Active CMS sessions</h3>
      <p className="text-sm text-zinc-400">Ending a session requires that browser to sign in again. Cloudflare Access and shopper sessions are managed separately.</p>
      {sessionsLoaded && !loading && !error && sessions.length === 0 && <p className="text-sm text-zinc-400">No active CMS sessions.</p>}
      <ul className="space-y-3">{sessions.map(session => <li key={session.id} className="space-y-1 rounded-md border border-white/10 p-3 text-sm">
        <p className="break-words">{session.userAgent || 'Unknown device'}{session.current ? ' · Current session' : ''}</p>
        <p className="text-zinc-400">{session.ipAddress || 'IP unavailable'} · {session.authMethod === 'cloudflare' ? 'Cloudflare SSO' : 'CMS sign-in'}</p>
        <p className="text-zinc-400">Started {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</p>
        <button type="button" disabled={busy} onClick={event => { sessionTrigger.current = event.currentTarget; setPendingSession(session); }} className="text-amber-300 underline">End session<span className="sr-only"> started {session.createdAt}</span></button>
      </li>)}</ul>
      {nextOffset !== null && <button type="button" disabled={busy} onClick={() => void run(() => loadSessions(nextOffset))} className="text-indigo-300 underline">Load more sessions</button>}
      {pendingSession && <div className="space-y-3 rounded-md border border-amber-500/30 p-4" role="group" aria-labelledby="end-session-heading">
        <h4 id="end-session-heading" ref={confirmHeading} tabIndex={-1} className="font-medium focus:outline-none">End this CMS session?</h4>
        <p className="text-sm text-zinc-400">{pendingSession.current ? 'This is your current session. You will be signed out.' : 'That browser will need to sign in again.'}</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await action<{ currentSessionEnded: boolean }>('revoke-user-session', { sessionId: pendingSession.id });
          if (result.currentSessionEnded) { window.location.assign(base.replace(/\/api\/auth\/admin$/, '') || '/'); return; }
          setPendingSession(null); await loadSessions(); setNotice('CMS session ended.'); heading.current?.focus();
        })} className="text-amber-300 underline">Confirm end session</button>
        <button type="button" disabled={busy} onClick={() => { setPendingSession(null); sessionTrigger.current?.focus(); }} className="ml-4 text-zinc-400">Cancel</button>
      </div>}
    </div>
  </section>;
}
