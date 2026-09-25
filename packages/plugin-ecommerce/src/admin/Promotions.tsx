import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel, Stat } from './common';

type CodeType = 'amount' | 'percent' | 'credit';
type Code = {
  code: string; description: string | null; type: CodeType; value: number; remainingCents: number | null;
  maxDiscountCents: number | null; minOrderCents: number; eligibleProductIds: string[];
  maxUses: number | null; maxUsesPerCustomer: number | null; firstOrderOnly: boolean;
  startsAt: string | null; expiresAt: string | null; active: boolean;
};
type PromotionsData = {
  referral: { enabled: boolean; rewardCents: number; minOrderCents: number; attributionDays: number };
  referralLinks: Array<{ code: string; email: string; active: boolean }>;
  codes: Code[]; usage: Array<{ code: string; status: string; uses: number }>;
};
const cents = (value: FormDataEntryValue | null) => Math.round(Number(value || 0) * 100);
const optionalNumber = (value: FormDataEntryValue | null) => String(value || '').trim() ? Number(value) : null;
const optionalDate = (value: FormDataEntryValue | null) => value ? Math.floor(new Date(String(value)).getTime() / 1000) : null;
const localDate = (value: string | null) => value
  ? new Date(value).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 16) : '';

export default function Promotions() {
  const [data, setData] = useState<PromotionsData | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Code | null>(null);
  const [type, setType] = useState<CodeType>('amount');
  const [search, setSearch] = useState('');
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  async function reload() { setData(await adminRequest<PromotionsData>('promotions')); }
  useEffect(() => { void reload().catch(cause => show(errorText(cause), true)); }, []);

  async function saveReferral(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true);
    try {
      await adminRequest('promotions', { action: 'saveReferral', data: {
        enabled: values.has('enabled'), rewardCents: cents(values.get('reward')),
        minOrderCents: cents(values.get('minimum')), attributionDays: Number(values.get('days')) } });
      await reload(); show('Referral settings saved.');
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  async function toggleReferral(code: string, active: boolean) {
    setBusy(true);
    try { await adminRequest('promotions', { action: 'setReferralCodeActive', code, data: { active } }); await reload(); show(`${code} updated.`); }
    catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  async function saveCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true);
    const code = editing?.code || String(values.get('code') || '').trim().toUpperCase();
    const input = {
      code, type, description: String(values.get('description') || '').trim() || null,
      value: editing ? editing.value : cents(values.get('value')),
      maxDiscountCents: editing ? editing.maxDiscountCents : type === 'percent' && values.get('maxDiscount') ? cents(values.get('maxDiscount')) : null,
      minOrderCents: editing ? editing.minOrderCents : cents(values.get('minOrder')),
      eligibleProductIds: editing ? editing.eligibleProductIds : String(values.get('products') || '').split(',').map(value => value.trim()).filter(Boolean),
      maxUses: optionalNumber(values.get('maxUses')),
      maxUsesPerCustomer: optionalNumber(values.get('perCustomer')),
      firstOrderOnly: editing ? editing.firstOrderOnly : values.has('firstOrderOnly'),
      startsAt: optionalDate(values.get('startsAt')), expiresAt: optionalDate(values.get('expiresAt')),
      active: values.has('active'),
    };
    try {
      const result = await adminRequest<{ result?: { code?: string } }>('promotions', {
        action: editing ? 'updateCode' : 'createCode', code: editing?.code, data: input });
      setEditing(null); setType('amount'); await reload(); show(`${result.result?.code || code} saved.`);
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  const codes = data?.codes || [];
  const visible = codes.filter(code => `${code.code} ${code.description || ''} ${code.type}`.toLowerCase().includes(search.trim().toLowerCase()));
  const fixed = Boolean(editing);
  return <CommerceAdmin current="promotions">
    <p className="ecom-admin__intro">Manage referral rewards, discounts, and promotional credit. Changes affect future checkouts; pending orders keep their saved amounts.</p>
    <div className="ecom-admin__stats"><Stat label="Active codes" value={codes.filter(code => code.active).length} detail="Available to shoppers" /><Stat label="Paused codes" value={codes.filter(code => !code.active).length} detail="Kept for reference" /><Stat label="Referral links" value={data?.referralLinks.length ?? '—'} detail="Created by shoppers" /></div>
    <Feedback message={message} error={error} />
    {data && <>
      <Panel title="Referral program">
        <form key={`${data.referral.enabled}-${data.referral.rewardCents}-${data.referral.minOrderCents}-${data.referral.attributionDays}`} onSubmit={event => void saveReferral(event)}>
          <label className="ecom-admin__check"><input type="checkbox" name="enabled" defaultChecked={data.referral.enabled} /> Enable new referral awards</label>
          <div className="ecom-admin__grid"><Field label="Reward per shopper (USD)"><input name="reward" type="number" min="0.01" max="1000" step="0.01" defaultValue={data.referral.rewardCents / 100} required /></Field><Field label="Minimum first order (USD)"><input name="minimum" type="number" min="0.01" max="100000" step="0.01" defaultValue={data.referral.minOrderCents / 100} required /></Field><Field label="Referral window (days)"><input name="days" type="number" min="1" max="90" step="1" defaultValue={data.referral.attributionDays} required /></Field></div>
          <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Save referral settings</button></div>
        </form>
        <h3>Shopper links</h3>
        {data.referralLinks.length ? data.referralLinks.map(link => <div className="ecom-admin__row" key={link.code}><span><strong>{link.code}</strong><small>{link.email} · {link.active ? 'Active' : 'Paused'}</small></span><button className="ecom-admin__secondary" type="button" disabled={busy} onClick={() => void toggleReferral(link.code, !link.active)}>{link.active ? 'Pause' : 'Resume'}</button></div>) : <p className="ecom-admin__muted">No shopper links yet.</p>}
      </Panel>
      <Panel title={editing ? `Edit ${editing.code}` : 'Create discount or credit code'}>
        <p className="ecom-admin__muted">Financial terms are fixed after creation. Pause a code and create a new one to change its value or eligibility.</p>
        <form key={editing?.code || 'new'} onSubmit={event => void saveCode(event)}>
          <div className="ecom-admin__grid">
            <Field label="Code"><input name="code" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" maxLength={32} defaultValue={editing?.code || ''} disabled={fixed || type === 'credit'} required={!fixed && type !== 'credit'} placeholder={type === 'credit' ? 'Generated when saved' : ''} /></Field>
            <Field label="Type"><select name="type" value={type} disabled={fixed} onChange={event => setType(event.target.value as CodeType)}><option value="amount">Fixed amount</option><option value="percent">Percentage</option><option value="credit">Promotional credit voucher</option></select></Field>
            <Field label="Description"><input name="description" maxLength={200} defaultValue={editing?.description || ''} /></Field>
            <Field label={type === 'percent' ? 'Value (%)' : 'Value (USD)'}><input name="value" type="number" min="0.01" max={type === 'percent' ? '100' : '10000'} step="0.01" defaultValue={editing ? editing.value / 100 : ''} disabled={fixed} required /></Field>
            <Field label="Maximum percentage discount (USD)"><input name="maxDiscount" type="number" min="0.01" step="0.01" defaultValue={editing?.maxDiscountCents ? editing.maxDiscountCents / 100 : ''} disabled={fixed || type !== 'percent'} /></Field>
            <Field label="Minimum order (USD)"><input name="minOrder" type="number" min="0" step="0.01" defaultValue={editing ? editing.minOrderCents / 100 : 0} disabled={fixed} required /></Field>
            <Field label="Eligible product IDs (comma separated)"><input name="products" defaultValue={editing?.eligibleProductIds.join(', ') || ''} disabled={fixed} /></Field>
            <Field label="Maximum uses"><input name="maxUses" type="number" min="1" step="1" defaultValue={editing?.maxUses ?? ''} /></Field>
            <Field label="Uses per shopper"><input name="perCustomer" type="number" min="1" step="1" defaultValue={editing?.maxUsesPerCustomer ?? ''} /></Field>
            <Field label="Starts at"><input name="startsAt" type="datetime-local" defaultValue={localDate(editing?.startsAt || null)} /></Field>
            <Field label="Expires at"><input name="expiresAt" type="datetime-local" defaultValue={localDate(editing?.expiresAt || null)} /></Field>
          </div>
          <div className="ecom-admin__actions"><label className="ecom-admin__check"><input name="firstOrderOnly" type="checkbox" defaultChecked={editing?.firstOrderOnly || false} disabled={fixed} /> First purchase only</label><label className="ecom-admin__check"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} /> Active</label></div>
          <div className="ecom-admin__actions"><button type="submit" disabled={busy}>{editing ? 'Save code' : 'Create code'}</button>{editing && <button type="button" className="ecom-admin__secondary" onClick={() => { setEditing(null); setType('amount'); }}>Cancel edit</button>}</div>
        </form>
      </Panel>
      <Panel title="Existing codes">
        <Field label="Find a code"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Code or description" /></Field>
        {visible.length ? visible.map(code => {
          const uses = data.usage.filter(item => item.code === code.code && ['reserved', 'confirmed'].includes(item.status)).reduce((total, item) => total + item.uses, 0);
          return <div className="ecom-admin__row" key={code.code}><span><strong>{code.code} · {code.type === 'percent' ? `${code.value / 100}%` : money(code.value)}</strong><small>{code.active ? 'Active' : 'Paused'} · {uses}{code.maxUses ? ` / ${code.maxUses}` : ''} uses{code.type === 'credit' ? ` · ${money(code.remainingCents || 0)} remaining` : ''}{code.description ? ` · ${code.description}` : ''}</small></span><button type="button" className="ecom-admin__secondary" onClick={() => { setEditing(code); setType(code.type); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button></div>;
        }) : <p className="ecom-admin__muted">{codes.length ? 'No codes match this search.' : 'No codes yet.'}</p>}
      </Panel>
    </>}
  </CommerceAdmin>;
}
