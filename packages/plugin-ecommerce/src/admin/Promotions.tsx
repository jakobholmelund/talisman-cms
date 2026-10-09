import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { fromMinorUnits } from '@talisman-cms/plugin-ecommerce/money';
import { adminRequest, amountInput, CommerceAdmin, errorText, Feedback, Field, formAmount, money, Panel, Stat, storeCurrency } from './common';

type CodeType = 'amount' | 'percent' | 'credit';
type Code = {
  code: string; description: string | null; type: CodeType; value: number; remainingCents: number | null;
  maxDiscountCents: number | null; minOrderCents: number; eligibleProductIds: string[];
  maxUses: number | null; maxUsesPerCustomer: number | null; firstOrderOnly: boolean;
  updatedAt: string; startsAt: string | null; expiresAt: string | null; active: boolean;
};
type PromotionsData = {
  referralRevision: number | null;
  referral: { enabled: boolean; switchedOn: boolean; termsError: string | null; source: 'saved' | 'settings';
    rewardCents: number; minOrderCents: number; attributionDays: number;
    holdDays: number; maxPerPeriod: number; periodDays: number };
  referralLinks: Array<{ code: string; email: string; active: boolean }>;
  codes: Code[]; usage: Array<{ code: string; status: string; uses: number }>;
};
// The server's limits in the store currency's minor units (referralSettingsSchema and
// discountCodeSchema in promotions.ts).
const limits = {
  reward: { min: 1, max: 100_000 },
  referralMinimum: { min: 1, max: 10_000_000 },
  value: { min: 1, max: 1_000_000 },
  maxDiscount: { min: 1, max: 1_000_000 },
  minOrder: { min: 0, max: 10_000_000 },
};
// Percent codes store basis points: 1 is 0.01% and 10,000 is 100%.
const percentInput = { min: 0.01, max: 100, step: 0.01 };
const basisPoints = (value: FormDataEntryValue | null) => Math.round(Number(value || 0) * 100);
const optionalNumber = (value: FormDataEntryValue | null) => String(value || '').trim() ? Number(value) : null;
const optionalDate = (value: FormDataEntryValue | null) => value ? Math.floor(new Date(String(value)).getTime() / 1000) : null;
const localDate = (value: string | null) => value
  ? new Date(value).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 16) : '';

export default function Promotions() {
  const [data, setData] = useState<PromotionsData | null>(null);
  const [referralSnapshot, setReferralSnapshot] = useState<Pick<PromotionsData, 'referral' | 'referralRevision'> | null>(null);
  const [conflict, setConflict] = useState<'code' | 'referral' | null>(null);
  const referralSaved = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Code | null>(null);
  const [type, setType] = useState<CodeType>('amount');
  const [search, setSearch] = useState('');
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [codeDirty, setCodeDirty] = useState(false);
  const [referralDirty, setReferralDirty] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const [codeVersion, setCodeVersion] = useState(0);
  const [referralVersion, setReferralVersion] = useState(0);
  const codeForm = useRef<HTMLFormElement>(null);
  const referralForm = useRef<HTMLFormElement>(null);
  const codeBaseline = useRef('');
  const referralBaseline = useRef('');
  const draftDirty = useRef({ code: false, referral: false });
  const pendingCreation = useRef<Record<string, unknown> | null>(null);
  const writing = useRef(false);
  const loading = useRef(false);
  const failedRead = useRef(false);
  const activePage = useRef(true);
  const latest = useRef(0);
  const feedback = useRef<HTMLDivElement>(null);
  const blocked = busy || reading || readFailed;
  const cannotWrite = () => writing.current || loading.current || failedRead.current;
  const cannotChange = () => cannotWrite() || Boolean(pendingCreation.current);
  const snapshot = (form: HTMLFormElement | null) => JSON.stringify(form ? Array.from(form.elements)
    .flatMap(element => element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? [[element.name, element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : element.value]] : []) : []);
  function changed(which: 'code' | 'referral') {
    const dirty = snapshot(which === 'code' ? codeForm.current : referralForm.current) !== (which === 'code' ? codeBaseline.current : referralBaseline.current);
    draftDirty.current[which] = dirty;
    (which === 'code' ? setCodeDirty : setReferralDirty)(dirty);
  }
  useEffect(() => { codeBaseline.current = snapshot(codeForm.current); }, [Boolean(data), editing, codeVersion]);
  useEffect(() => { referralBaseline.current = snapshot(referralForm.current); }, [Boolean(data), referralVersion]);
  useEffect(() => { if (message) feedback.current?.focus({ preventScroll: true }); }, [message]);
  useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname
      && Boolean(writing.current || pendingCreation.current || draftDirty.current.code || draftDirty.current.referral)
      && !window.confirm(pendingCreation.current
        ? 'This promotion creation has not been confirmed. Leaving loses its retry key; a code may already have been created. Leave promotions?'
        : writing.current ? 'A promotion change is still running. Leave promotions?'
          : 'You have unsaved promotion changes. Leave promotions?'),
    enableBeforeUnload: busy || creationPending || codeDirty || referralDirty,
  });
  const currency = storeCurrency();
  const currencyCode = currency.toUpperCase();
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  async function reload() {
    const request = ++latest.current;
    loading.current = true; setReading(true);
    try {
      const result = await adminRequest<PromotionsData>('promotions');
      if (request !== latest.current) return false;
      setData(result);
      const adoptReferral = referralSaved.current;
      setReferralSnapshot(previous => !previous || adoptReferral ? { referral: result.referral, referralRevision: result.referralRevision } : previous);
      if (referralSaved.current) { referralSaved.current = false; setReferralVersion(value => value + 1); }
      failedRead.current = false; setReadFailed(false);
      return true;
    } catch (cause) {
      if (request === latest.current) {
        failedRead.current = true; setReadFailed(true);
        show(`Could not load promotions: ${errorText(cause)}. Retry loading before making another change.`, true);
      }
      return false;
    } finally {
      if (request === latest.current) { loading.current = false; setReading(false); }
    }
  }
  useEffect(() => {
    activePage.current = true; void reload();
    return () => { activePage.current = false; ++latest.current; };
  }, []);
  async function act(task: () => Promise<string>, formKind?: 'code' | 'referral') {
    if (cannotWrite()) return;
    writing.current = true; setBusy(true); show('');
    try {
      const outcome = await task();
      if (!activePage.current) return;
      const refreshed = await reload();
      if (activePage.current) show(refreshed ? outcome : `${outcome} The promotion list could not refresh. Retry loading before making another change.`, !refreshed);
    } catch (cause) {
      if (activePage.current && formKind && (cause as { status?: number })?.status === 409) setConflict(formKind);
      if (activePage.current) show(`${errorText(cause)}${pendingCreation.current ? ' Creation has not been confirmed. Retry the same creation to recover its code.' : ''}`, true);
    } finally {
      writing.current = false;
      if (activePage.current) setBusy(false);
    }
  }
  async function saveReferral(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cannotChange() || conflict === 'referral' || !event.currentTarget.reportValidity()) return;
    const values = new FormData(event.currentTarget);
    await act(async () => {
      const response = await adminRequest<{ result: PromotionsData['referral'] }>('promotions', { action: 'saveReferral', data: {
        expectedVersion: referralSnapshot?.referralRevision, enabled: values.has('enabled'), rewardCents: formAmount(values.get('reward'), currency),
        minOrderCents: formAmount(values.get('minimum'), currency), attributionDays: Number(values.get('days')) } });
      if (activePage.current) {
        setData(previous => previous ? { ...previous, referral: response.result } : previous);
        referralSaved.current = true;
        setReferralSnapshot(previous => previous ? { ...previous, referral: response.result } : previous);
        draftDirty.current.referral = false; setReferralDirty(false); setReferralVersion(value => value + 1);
      }
      return 'Referral settings saved.';
    }, 'referral');
  }
  async function toggleReferral(code: string, active: boolean) {
    if (cannotChange()) return;
    await act(async () => {
      await adminRequest('promotions', { action: 'setReferralCodeActive', code, data: { active } });
      return `${code} updated.`;
    });
  }
  function chooseCode(code: Code | null) {
    if (cannotChange()) return;
    if (draftDirty.current.code && !window.confirm('Discard the unsaved code changes?')) return;
    draftDirty.current.code = false; setCodeDirty(false);
    setConflict(previous => previous === 'code' ? null : previous);
    setEditing(code); setType(code?.type || 'amount'); setCodeVersion(value => value + 1);
    if (code) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function cancelCreation() {
    if (writing.current || loading.current) return;
    if (!window.confirm('Stop retrying this creation? A code may already exist. This does not undo it; check Existing codes before creating another.')) return;
    pendingCreation.current = null; setCreationPending(false);
    changed('code');
    show('Creation retry cancelled. Your draft is kept. Check Existing codes before creating another.');
  }

  async function saveCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cannotWrite() || conflict === 'code' || (!pendingCreation.current && !event.currentTarget.reportValidity())) return;
    const values = new FormData(event.currentTarget);
    const code = editing?.code || String(values.get('code') || '').trim().toUpperCase();
    const input = {
      code, type, description: String(values.get('description') || '').trim() || null,
      value: editing ? editing.value : type === 'percent' ? basisPoints(values.get('value')) : formAmount(values.get('value'), currency),
      maxDiscountCents: editing ? editing.maxDiscountCents : type === 'percent' && values.get('maxDiscount') ? formAmount(values.get('maxDiscount'), currency) : null,
      minOrderCents: editing ? editing.minOrderCents : formAmount(values.get('minOrder'), currency),
      eligibleProductIds: editing ? editing.eligibleProductIds : String(values.get('products') || '').split(',').map(value => value.trim()).filter(Boolean),
      maxUses: optionalNumber(values.get('maxUses')),
      maxUsesPerCustomer: optionalNumber(values.get('perCustomer')),
      firstOrderOnly: editing ? editing.firstOrderOnly : values.has('firstOrderOnly'),
      startsAt: optionalDate(values.get('startsAt')), expiresAt: optionalDate(values.get('expiresAt')),
      active: values.has('active'),
    };
    const updating = Boolean(editing);
    if (!updating && !pendingCreation.current) {
      pendingCreation.current = { ...input, requestKey: crypto.randomUUID() }; setCreationPending(true);
    }
    await act(async () => {
      const result = await adminRequest<{ result?: { code?: string } }>('promotions', {
        action: updating ? 'updateCode' : 'createCode', code: editing?.code,
        data: updating ? { ...input, expectedVersion: Math.floor(Date.parse(editing!.updatedAt) / 1000) } : pendingCreation.current });
      if (!result.result?.code) throw new Error('The save response did not include its code');
      if (activePage.current) {
        pendingCreation.current = null; setCreationPending(false);
        draftDirty.current.code = false; setCodeDirty(false);
        setEditing(null); setType('amount'); setCodeVersion(value => value + 1);
      }
      return `${result.result.code} saved.`;
    }, 'code');
  }

  async function loadLatest() {
    if (cannotWrite() || !conflict) return;
    if (!window.confirm('Discard this form’s unsaved changes and load the latest saved version?')) return;
    loading.current = true; setReading(true);
    const result = await adminRequest<PromotionsData>('promotions').catch(cause => { show(errorText(cause), true); return null; })
      .finally(() => { loading.current = false; if (activePage.current) setReading(false); });
    if (!result || !activePage.current) return;
    setData(result);
    if (conflict === 'referral') {
      setReferralSnapshot({ referral: result.referral, referralRevision: result.referralRevision });
      draftDirty.current.referral = false; setReferralDirty(false); setReferralVersion(value => value + 1);
    } else {
      const code = result.codes.find(code => code.code === editing?.code) ?? null;
      draftDirty.current.code = false; setCodeDirty(false); setEditing(code); setType(code?.type || 'amount'); setCodeVersion(value => value + 1);
    }
    setConflict(null); show('Latest saved version loaded.');
  }
  const referral = referralSnapshot?.referral ?? data?.referral;
  const codes = data?.codes || [];
  const visible = codes.filter(code => `${code.code} ${code.description || ''} ${code.type}`.toLowerCase().includes(search.trim().toLowerCase()));
  const fixed = Boolean(editing);
  return <CommerceAdmin current="promotions">
    <p className="ecom-admin__intro">Manage referral rewards, discounts, and promotional credit. Changes affect future checkouts; pending orders keep their saved amounts.</p>
    <div className="ecom-admin__stats"><Stat label="Active codes" value={codes.filter(code => code.active).length} detail="Available to shoppers" /><Stat label="Paused codes" value={codes.filter(code => !code.active).length} detail="Kept for reference" /><Stat label="Referral links" value={data?.referralLinks.length ?? '—'} detail="Created by shoppers" /></div>
    <div ref={feedback} tabIndex={-1}><Feedback message={message} error={error} /></div>
    {(reading || busy) && <p role="status">{busy ? 'Saving promotion changes…' : 'Loading promotions…'}</p>}
    {readFailed && <button type="button" aria-disabled={busy || reading} onClick={() => { if (!writing.current && !loading.current) void reload().then(ok => { if (ok && activePage.current) show('Promotions loaded.'); }); }}>Retry loading promotions</button>}
    {conflict && <p role="alert">Another save changed this {conflict === 'code' ? 'code' : 'referral policy'}. Your draft is kept. <button type="button" aria-disabled={blocked} onClick={() => void loadLatest()}>Load latest {conflict === 'code' ? 'code' : 'referral settings'}</button></p>}
    {data && referral && <>
      <Panel title="Referral program" label="Referral program">
        <p className="ecom-admin__muted">Referrals are off until they are enabled here, or by the <code>TALISMAN_COMMERCE_REFERRALS_ENABLED</code> Worker setting while nothing is saved. {referral.source === 'settings' ? 'Nothing is saved yet, so the Worker settings apply.' : 'The saved settings apply.'} The reward can be at most half the minimum first order.</p>
        {referral.termsError && <Feedback message={`New referrals are paused. ${referral.termsError}.`} error />}
        <form ref={referralForm} key={referralVersion} onChange={() => changed('referral')} onSubmit={event => void saveReferral(event)}>
          <fieldset className="ecom-admin__fields" disabled={busy || reading || creationPending}>
          <label className="ecom-admin__check"><input type="checkbox" name="enabled" defaultChecked={referral.switchedOn} /> Enable new referral awards</label>
          <div className="ecom-admin__grid"><Field label={`Reward per shopper (${currencyCode})`}><input name="reward" type="number" {...amountInput(currency, limits.reward)} defaultValue={fromMinorUnits(referral.rewardCents, currency)} required /></Field><Field label={`Minimum first order (${currencyCode})`}><input name="minimum" type="number" {...amountInput(currency, limits.referralMinimum)} defaultValue={fromMinorUnits(referral.minOrderCents, currency)} required /></Field><Field label="Referral window (days)"><input name="days" type="number" min="1" max="90" step="1" defaultValue={referral.attributionDays} required /></Field></div>
          </fieldset>
          <div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked || creationPending || conflict === 'referral'}>Save referral settings</button></div>
        </form>
        <p className="ecom-admin__muted">Awards stay pending for {referral.holdDays} days after payment and are then released by the scheduled job, unless the order was refunded below the minimum or disputed. Each shopper can refer at most {referral.maxPerPeriod} new shoppers in {referral.periodDays} days. These limits are Worker settings.</p>
        <h3>Shopper links</h3>
        {data.referralLinks.length ? data.referralLinks.map(link => <div className="ecom-admin__row" key={link.code}><span><strong>{link.code}</strong><small>{link.email} · {link.active ? 'Active' : 'Paused'}</small></span><button className="ecom-admin__secondary" type="button" aria-disabled={blocked || creationPending} onClick={() => void toggleReferral(link.code, !link.active)}>{link.active ? 'Pause' : 'Resume'}</button></div>) : <p className="ecom-admin__muted">No shopper links yet.</p>}
      </Panel>
      <Panel title={editing ? `Edit ${editing.code}` : 'Create discount or credit code'} label={editing ? `Edit ${editing.code}` : 'Create discount or credit code'}>
        <p className="ecom-admin__muted">Financial terms are fixed after creation. Pause a code and create a new one to change its value or eligibility.</p>
        {creationPending && <p className="ecom-admin__muted">Keep these details unchanged while retrying. A code may already have been created.</p>}
        <form ref={codeForm} key={`${editing?.code || 'new'}-${codeVersion}`} onChange={() => changed('code')} onSubmit={event => void saveCode(event)}>
          <fieldset className="ecom-admin__fields" disabled={busy || reading || creationPending}>
          <div className="ecom-admin__grid">
            <Field label="Code"><input name="code" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" maxLength={32} defaultValue={editing?.code || ''} disabled={fixed || type === 'credit'} required={!fixed && type !== 'credit'} placeholder={type === 'credit' ? 'Generated when saved' : ''} /></Field>
            <Field label="Type"><select aria-label="Type" name="type" value={type} disabled={fixed} onChange={event => setType(event.target.value as CodeType)}><option value="amount">Fixed amount</option><option value="percent">Percentage</option><option value="credit">Promotional credit voucher</option></select></Field>
            <Field label="Description"><input name="description" maxLength={200} defaultValue={editing?.description || ''} /></Field>
            <Field label={type === 'percent' ? 'Value (%)' : `Value (${currencyCode})`}><input name="value" type="number" {...(type === 'percent' ? percentInput : amountInput(currency, limits.value))} defaultValue={editing ? (type === 'percent' ? editing.value / 100 : fromMinorUnits(editing.value, currency)) : ''} disabled={fixed} required /></Field>
            <Field label={`Maximum percentage discount (${currencyCode})`}><input name="maxDiscount" type="number" {...amountInput(currency, limits.maxDiscount)} defaultValue={editing?.maxDiscountCents ? fromMinorUnits(editing.maxDiscountCents, currency) : ''} disabled={fixed || type !== 'percent'} /></Field>
            <Field label={`Minimum order (${currencyCode})`}><input name="minOrder" type="number" {...amountInput(currency, limits.minOrder)} defaultValue={editing ? fromMinorUnits(editing.minOrderCents, currency) : 0} disabled={fixed} required /></Field>
            <Field label="Eligible product IDs (comma separated)"><input name="products" defaultValue={editing?.eligibleProductIds.join(', ') || ''} disabled={fixed} /></Field>
            <Field label="Maximum uses"><input name="maxUses" type="number" min="1" step="1" defaultValue={editing?.maxUses ?? ''} /></Field>
            <Field label="Uses per shopper"><input name="perCustomer" type="number" min="1" step="1" defaultValue={editing?.maxUsesPerCustomer ?? ''} /></Field>
            <Field label="Starts at"><input name="startsAt" type="datetime-local" defaultValue={localDate(editing?.startsAt || null)} /></Field>
            <Field label="Expires at"><input name="expiresAt" type="datetime-local" defaultValue={localDate(editing?.expiresAt || null)} /></Field>
          </div>
          <div className="ecom-admin__actions"><label className="ecom-admin__check"><input name="firstOrderOnly" type="checkbox" defaultChecked={editing?.firstOrderOnly || false} disabled={fixed} /> First purchase only</label><label className="ecom-admin__check"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} /> Active</label></div>
          </fieldset>
          <div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked || conflict === 'code'}>{editing ? 'Save code' : creationPending ? 'Retry creation' : 'Create code'}</button>{creationPending ? <button type="button" className="ecom-admin__secondary" aria-disabled={busy || reading} onClick={cancelCreation}>Cancel creation retry</button> : (editing || codeDirty) && <button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={() => chooseCode(null)}>{editing ? 'Cancel edit' : 'Discard code draft'}</button>}</div>
        </form>
      </Panel>
      <Panel title="Existing codes" label="Existing codes">
        <Field label="Find a code"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Code or description" /></Field>
        {visible.length ? visible.map(code => {
          const uses = data.usage.filter(item => item.code === code.code && ['reserved', 'confirmed'].includes(item.status)).reduce((total, item) => total + item.uses, 0);
          return <div className="ecom-admin__row" key={code.code}><span><strong>{code.code} · {code.type === 'percent' ? `${code.value / 100}%` : money(code.value, currency)}</strong><small>{code.active ? 'Active' : 'Paused'} · {uses}{code.maxUses ? ` / ${code.maxUses}` : ''} uses{code.type === 'credit' ? ` · ${money(code.remainingCents || 0, currency)} remaining` : ''}{code.description ? ` · ${code.description}` : ''}</small></span><button type="button" className="ecom-admin__secondary" aria-disabled={blocked || creationPending} onClick={() => chooseCode(code)}>Edit</button></div>;
        }) : <p className="ecom-admin__muted">{codes.length ? 'No codes match this search.' : 'No codes yet.'}</p>}
      </Panel>
    </>}
  </CommerceAdmin>;
}
