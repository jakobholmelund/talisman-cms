import {useAttentionTarget} from './attention-target';
import { ExchangeHandoff } from './Recoveries';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {listReturnsQueue,readReturnRequestAdmin,readOrderWarehouse} from '@talisman-cms/plugin-ecommerce/operations';
import {CommerceAdmin,CommerceCaseLink,SelectedCase,Panel,Field,money,adminRequest,errorText} from './common';
import {useOperationsRead,OperationsReadStatus,OperationsPagination,dateTime} from './operations-common';
import {useWarehouseWrite} from './warehouse-write';
import ReturnInspection from './ReturnInspection';
type Queue=Awaited<ReturnType<typeof listReturnsQueue>>;
type Request=Awaited<ReturnType<typeof readReturnRequestAdmin>>;
type Warehouse=Awaited<ReturnType<typeof readOrderWarehouse>>;
const valid=(v:unknown):v is Queue=>!!v&&Array.isArray((v as Queue).rows)&&Number.isFinite((v as Queue).total);
function useDetail<T>(action:string,data:Record<string,string>,validate:(value:T)=>boolean){
  const [snapshot,setSnapshot]=useState<T|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');const sequence=useRef(0),unavailable=useRef(true);const payload=JSON.stringify(data);
  const load=useCallback(async()=>{const run=++sequence.current;unavailable.current=true;setLoading(true);setError('');try{const result=await adminRequest<T>('operations',{action,data:JSON.parse(payload)});if(!validate(result))throw new Error('Incomplete return details. Refresh before continuing.');if(run===sequence.current){setSnapshot(result);unavailable.current=false;}}catch(cause){if(run===sequence.current)setError(errorText(cause));}finally{if(run===sequence.current)setLoading(false);}},[action,payload,validate]);
  useEffect(()=>{void load();return()=>{sequence.current++;unavailable.current=true;};},[load]);return{snapshot,loading,error,load,unavailable};
}
const validRequest=(r:Request)=>!!r&&typeof r.version==='string'&&Array.isArray(r.items)&&Array.isArray(r.events);
const validWarehouse=(r:Warehouse)=>!!r&&Array.isArray(r.lines)&&Array.isArray(r.returns);
function RequestDetail({requestId,refreshQueue,dirtyChanged}:{requestId:string;refreshQueue:()=>Promise<unknown>;dirtyChanged:(dirty:boolean)=>void}) {
  const [exchangeDirty,setExchangeDirty]=useState(false);
  const read=useDetail<Request>('returnRequestRead',{requestId},validRequest),[status,setStatus]=useState('approved'),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[conditions,setConditions]=useState<Record<number,string>>({}),[restock,setRestock]=useState<Record<number,boolean>>({});const form=useRef<HTMLFormElement>(null);
  const write=useWarehouseWrite(async()=>{await read.load();await refreshQueue();});
  useEffect(()=>{dirtyChanged(write.dirty||!!write.pending||exchangeDirty);return()=>dirtyChanged(false);},[write.dirty,write.pending,exchangeDirty]);
  useEffect(()=>{if(read.snapshot&&!read.unavailable.current){write.loaded();setStatus(current=>read.snapshot?.status==='pending'&&['approved','declined'].includes(current)?current:read.snapshot?.status==='pending'?'approved':'closed');}},[read.snapshot]);
  const r=read.snapshot,locked=write.busy||!!write.pending||read.loading||!!read.error||write.needsReload||exchangeDirty;
  const reset=()=>{setReason('');setMessage('');setConditions({});setRestock({});form.current?.reset();write.setDirty(false);};
  return <section className="ecom-admin__aftercare" aria-label={`Return request ${requestId}`}>{write.feedback}<OperationsReadStatus loading={read.loading} error={read.error} reload={()=>void read.load()}/>
    {r&&<><div className="ecom-admin__case-heading"><span className="ecom-admin__badge" data-tone={r.status==='pending'?'warning':'neutral'}>{r.status === 'pending' ? 'Needs review' : r.status === 'approved' ? 'Approved' : r.status === 'closed' ? 'Closed' : 'Declined'}</span><p className="ecom-admin__muted">Order <code>{r.orderId}</code> · Requested {dateTime(r.createdAt)}</p></div><div className="ecom-admin__notice"><strong>{r.status==='pending'?'Review the customer’s request':r.status==='approved'&&r.items.some(i=>i.received<i.quantity)?'Next: receive and inspect the returned goods':'Review the outcome and any exchange follow-up'}</strong><p>Customer reason: {r.reason}</p></div>{r.exchangePreference&&<section aria-label="Requested exchange"><h3>Requested exchange</h3><p>Preferred replacement: {r.exchangePreference.name}{r.exchangePreference.sku?` · ${r.exchangePreference.sku}`:''} · Indicative unit price {money(r.exchangePreference.priceMinor,r.exchangePreference.currency)}</p><p>Approval provides return instructions. It does not reserve the preference or agree a final price. After intake and inspection, use the exchange handoff below; review current catalog stock and any price difference with the customer.</p>{r.receipts.map(x=><p key={x.receiptId}>Exchange intake receipt: {x.receiptId}</p>)}</section>}<ul>{r.items.map(i=><li key={i.lineIndex}>{i.quantity} × {i.name} · {i.received} received</li>)}</ul>
      <details><summary>Decision history</summary><ul>{r.events.map(e=><li key={e.id}>{dateTime(e.createdAt)} · {e.actorName} · {e.status} · Staff reason: {e.reason}<p>Customer message: {e.customerMessage}</p></li>)}</ul></details>
      {['pending','approved'].includes(r.status)&&<details className="ecom-admin__return-decision" open={r.status==='pending'}><summary>{r.status==='pending'?'Review and respond':'Close this request'}</summary><form aria-label="Return decision" onChange={()=>write.setDirty(true)} onSubmit={e=>{e.preventDefault();if(write.blocked()||read.unavailable.current)return;void write.send({path:'operations',body:{action:'returnDecision',data:{requestId,requestKey:crypto.randomUUID(),expectedVersion:r.version,status,reason:reason.trim(),customerMessage:message.trim()}},receipt:'eventId',success:'Return decision recorded. The customer can read your message on their order page.'},reset);}}>
        <Field label="Return decision"><select aria-label="Return decision" value={status} disabled={locked} onChange={e=>setStatus(e.target.value)}>{r.status==='pending'?<><option value="approved">Approve return</option><option value="declined">Decline return</option></>:<option value="closed">Close request</option>}</select></Field>
        <Field label="Internal reason"><input required minLength={8} maxLength={500} disabled={locked} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
        <Field label="Message and instructions for customer"><textarea required minLength={8} maxLength={1000} disabled={locked} value={message} onChange={e=>setMessage(e.target.value)}/></Field>
        <p>This message is visible to the customer. Closing releases any unreceived requested quantities; it does not record a refund or receive goods.</p><button disabled={locked}>Record return decision</button>
      </form></details>}
      {r.status==='approved'&&r.items.some(i=>i.received<i.quantity)&&<form ref={form} aria-label="Receive approved return" onChange={()=>write.setDirty(true)} onSubmit={e=>{e.preventDefault();if(write.blocked()||read.unavailable.current)return;const f=new FormData(e.currentTarget),items=r.items.map(i=>({lineIndex:i.lineIndex,quantity:Number(f.get(`quantity-${i.lineIndex}`)),condition:String(f.get(`condition-${i.lineIndex}`)),restock:f.has(`restock-${i.lineIndex}`)})).filter(i=>i.quantity>0);if(!items.length)return;void write.send({path:'operations',body:{action:'receiveReturn',data:{orderId:r.orderId,returnRequestId:requestId,requestKey:crypto.randomUUID(),reason:String(f.get('reason')).trim(),items}},receipt:'receiptId',success:'Approved returned goods received and linked to this request.'},reset);}}>
        <h3>Receive approved returned goods</h3>{r.items.filter(i=>i.received<i.quantity).map(i=><fieldset key={i.lineIndex} disabled={locked}><legend>{i.name} · {i.quantity-i.received} still expected</legend><Field label={`Units received — ${i.name}`}><input type="number" min="0" max={i.quantity-i.received} step="1" defaultValue="0" name={`quantity-${i.lineIndex}`}/></Field><Field label={`Received condition — ${i.name}`}><select aria-label={`Received condition — ${i.name}`} name={`condition-${i.lineIndex}`} value={conditions[i.lineIndex]??'inspection'} onChange={e=>setConditions(c=>({...c,[i.lineIndex]:e.target.value}))}><option value="inspection">Awaiting inspection</option><option value="sellable">Sellable</option><option value="damaged">Damaged</option></select></Field><label><input type="checkbox" name={`restock-${i.lineIndex}`} checked={conditions[i.lineIndex]==='sellable'&&!!restock[i.lineIndex]} disabled={!i.restockMapped||conditions[i.lineIndex]!=='sellable'} onChange={e=>setRestock(c=>({...c,[i.lineIndex]:e.target.checked}))}/> Add selected sellable units to stock</label></fieldset>)}
        <Field label="Reason for receiving approved goods"><input name="reason" required minLength={8} maxLength={500} disabled={locked}/></Field><button disabled={locked}>Record approved return intake</button>
      </form>}
      {r.exchangePreference&&<ExchangeHandoff requestId={requestId} reloadKey={`${r.version}:${r.receipts.map(x=>x.receiptId).join(',')}`} blocked={write.dirty||write.busy||!!write.pending||read.loading||!!read.error} refresh={async()=>{await read.load();await refreshQueue();}} dirtyChanged={setExchangeDirty}/>}
      {write.dirty&&!write.pending&&<button type="button" disabled={write.busy} onClick={reset}>Discard return draft</button>}
    </>}
  </section>;
}
function InspectionDetail({receiptId,orderId,refreshQueue,dirtyChanged}:{receiptId:string;orderId:string;refreshQueue:()=>Promise<unknown>;dirtyChanged:(dirty:boolean)=>void}) {
  const read=useDetail<Warehouse>('warehouseRead',{orderId},validWarehouse),[version,setVersion]=useState(0),forms=useRef<HTMLElement>(null);const write=useWarehouseWrite(async()=>{await read.load();await refreshQueue();});
  useEffect(()=>{dirtyChanged(write.dirty||!!write.pending);return()=>dirtyChanged(false);},[write.dirty,write.pending]);useEffect(()=>{if(read.snapshot&&!read.unavailable.current)write.loaded();},[read.snapshot]);
  const receipt=read.snapshot?.returns.find(r=>r.id===receiptId),locked=write.busy||!!write.pending||read.loading||!!read.error||write.needsReload;
  const reset=()=>{setVersion(n=>n+1);forms.current?.querySelectorAll('form').forEach(f=>f.reset());write.setDirty(false);};
  return <section ref={forms} aria-label={`Inspection ${receiptId}`} onChange={()=>write.setDirty(true)}>{write.feedback}<OperationsReadStatus loading={read.loading} error={read.error} reload={()=>void read.load()}/>{receipt&&read.snapshot&&<><p>Order {orderId} · Intake: {receipt.reason}</p><ReturnInspection key={version} receipt={receipt} lines={read.snapshot.lines} disabled={locked} submit={(form)=>{if(write.blocked()||read.unavailable.current)return;const f=new FormData(form),items=receipt.inspectionPending.map(i=>({lineIndex:i.lineIndex,quantity:Number(f.get(`inspected-${i.lineIndex}`)),disposition:String(f.get(`disposition-${i.lineIndex}`)),restock:f.has(`inspection-restock-${i.lineIndex}`)})).filter(i=>i.quantity>0);if(!items.length)return;void write.send({path:'operations',body:{action:'inspectReturn',data:{orderId,receiptId,requestKey:crypto.randomUUID(),reason:String(f.get('reason')).trim(),items}},receipt:'inspectionId',success:'Inspection decision recorded.'},reset);}}/>{!receipt.inspectionPending.some(i=>i.quantity>0)&&<div className="ecom-admin__notice"><strong>Inspection complete</strong><p>Stock decisions are recorded. Review the refund or exchange outcome next.</p><CommerceCaseLink tool="refunds" kind="refund" id={receiptId} orderId={orderId}>Review return refund →</CommerceCaseLink></div>}{write.dirty&&!write.pending&&<button disabled={write.busy} onClick={reset}>Discard inspection draft</button>}</>}</section>;
}
const queues = { active: 'Active cases', pending: 'Needs review', waiting_goods: 'Awaiting goods', inspection: 'To inspect', arrange_exchange: 'Arrange exchange', approved: 'Approved', all: 'All cases' };
export default function Returns(){
  const [filters,setFilters]=useState({filter:'active',orderId:'',offset:'0'});
  const [search,setSearch]=useState('');
  const [selected,setSelected]=useState<Pick<Queue['rows'][number],'kind'|'id'|'orderId'>|null>(null),[blocked,setBlocked]=useState(false);
  const read=useOperationsRead<Queue>(new URLSearchParams({view:'returns',...filters}).toString(),valid);
  const {hash,target}=useAttentionTarget();
  useEffect(()=>{if(target?.kind==='request'||target?.kind==='inspection')setSelected({kind:target.kind,id:target.id,orderId:target.orderId});else if(!hash)setSelected(null);},[hash]);
  const chooseQueue = (filter: string) => { if (blocked) return; setSelected(null); setFilters(current => ({...current,filter,offset:'0'})); };
  return <CommerceAdmin current="returns">
    <p className="ecom-admin__intro">Review requests, receive goods, and arrange the next step. The oldest cases come first; refunds are tracked separately.</p>
    <div className="ecom-admin__views" role="group" aria-label="Return views">{Object.entries(queues).map(([key,label])=><button type="button" key={key} disabled={blocked} aria-pressed={filters.filter===key} onClick={()=>chooseQueue(key)}>{label}</button>)}</div>
    <Panel title="Find returns" label="Return filters"><form className="ecom-admin__toolbar ecom-admin__order-search" onSubmit={e=>{e.preventDefault();if(blocked)return;setSelected(null);setFilters(current=>({...current,orderId:search.trim(),offset:'0'}));}}>
      <Field label="Exact order ID"><input type="search" name="orderId" maxLength={128} placeholder="Find returns for an order" value={search} onChange={event=>setSearch(event.target.value)} disabled={blocked}/></Field><button disabled={blocked||read.loading}>Find returns</button>
      {filters.orderId&&<button type="button" className="ecom-admin__secondary" disabled={blocked} onClick={()=>{setSearch('');setSelected(null);setFilters(current=>({...current,orderId:'',offset:'0'}));}}>Clear search</button>}
    </form></Panel>
    <OperationsReadStatus loading={read.loading} error={read.error} reload={()=>void read.load()}/>
    <div className={selected?'ecom-admin__returns-layout':'ecom-admin__returns-layout ecom-admin__returns-layout--queue'}>
      {read.data&&<Panel title="Returns queue" label="Returns queue"><p className="ecom-admin__muted" role="status">{read.data.total} {read.data.total===1?'case':'cases'} · {queues[filters.filter as keyof typeof queues]} · Oldest first</p>
        {!read.data.rows.length?<div className="ecom-admin__empty"><h3>No cases need your attention here</h3><p>Try another queue or clear the order search.</p>{filters.filter!=='all'&&<button type="button" className="ecom-admin__secondary" disabled={blocked} onClick={()=>chooseQueue('all')}>View all cases</button>}</div>:<ul className="ecom-admin__case-list">{read.data.rows.map(r=><li key={`${r.kind}:${r.id}`} data-selected={selected?.id===r.id}>
          <div className="ecom-admin__case-row-heading"><span className="ecom-admin__badge" data-tone={r.status==='pending'||r.kind==='inspection'?'warning':'neutral'}>{r.kind==='inspection'?'To inspect':r.status==='pending'?'Needs review':r.status==='approved'?'Approved':r.status==='closed'?'Closed':'Declined'}</span><time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time></div>
          <p className="ecom-admin__case-order" title={r.orderId}>Order {r.orderId}</p><p className="ecom-admin__case-reason">{r.reason}</p><p className="ecom-admin__muted">{r.pendingUnits} {r.kind==='request'?'units still expected':'units awaiting inspection'}</p>
          <button type="button" className="ecom-admin__secondary" aria-label={`Open ${r.kind==='request'?'request':'inspection'} · ${r.id}`} aria-pressed={selected?.id===r.id} disabled={blocked||read.loading||!!read.error} onClick={()=>setSelected(r)}>{r.kind==='request'?'Review request':'Inspect goods'} →</button>
        </li>)}</ul>}
        <OperationsPagination offset={read.data.offset} total={read.data.total} loading={read.loading||blocked} change={offset=>{setSelected(null);setFilters(f=>({...f,offset:String(offset)}));}}/>
      </Panel>}
      {selected&&<SelectedCase key={`${selected.kind}:${selected.id}`}><Panel title={selected.kind==='request'?'Review return request':'Inspect received goods'} label="Selected return">
        <button type="button" className="ecom-admin__secondary" disabled={blocked} onClick={()=>setSelected(null)}>Close details</button>
        {selected.kind==='request'?<RequestDetail key={selected.id} requestId={selected.id} refreshQueue={read.load} dirtyChanged={setBlocked}/>:<InspectionDetail key={selected.id} receiptId={selected.id} orderId={selected.orderId} refreshQueue={read.load} dirtyChanged={setBlocked}/>}
      </Panel></SelectedCase>}
    </div>
  </CommerceAdmin>;
}
