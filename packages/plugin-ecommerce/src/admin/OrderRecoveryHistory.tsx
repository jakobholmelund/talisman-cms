import React,{useState} from 'react';
import type {readOrderRecoveryHistory} from '@talisman-cms/plugin-ecommerce/operations';
import {useAftercareRead} from './aftercare-read';
import {OperationsReadStatus,OperationsPagination,dateTime} from './operations-common';
import {money} from './common';
type History=Awaited<ReturnType<typeof readOrderRecoveryHistory>>;
const valid=(v:unknown):v is History=>!!v&&Array.isArray((v as History).rows)&&Number.isFinite((v as History).total);
const labels:Record<string,string>={case_created:'Case recorded',case_note:'Staff note',case_tracking:'Tracking corrected',case_resolve:'Case resolved',case_reopen:'Case reopened',replacement_shipment:'Replacement dispatched',replacement_receipt:'Replacement returned',replacement_inspection:'Replacement inspected',upgrade_payment:'Upgrade payment verified',upgrade_refunded:'Upgrade payment refund reported',upgrade_disputed:'Upgrade payment disputed',upgrade_lost:'Upgrade dispute lost',upgrade_won:'Upgrade dispute won',exchange_refund_decision:'Exchange refund decision',exchange_requested:'Exchange requested',exchange_request_decision:'Exchange request decision'};
function HistoryPage({orderId}:{orderId:string}){
 const [offset,setOffset]=useState(0),read=useAftercareRead('orderRecoveryHistory',{orderId,offset},valid),h=read.data;
 return <section aria-label="Replacement and exchange history"><OperationsReadStatus loading={read.loading} error={read.error} reload={()=>void read.load()}/>{h&&<>
 <p>All recorded replacement and exchange work, in chronological pages. Original purchase amounts stay separate.</p>{h.total?<ul>{h.rows.map(r=><li key={r.record_id}><strong>{labels[r.kind]??r.kind.replaceAll('_',' ')}</strong> · {dateTime(r.created_at_utc)} · {r.target_name}{r.quantity!==null?` · ${r.quantity} units`:''}{r.recorded_status?` · ${r.recorded_status}`:''}<p>{r.reason}{r.actorName?` · ${r.actorName}`:''}</p>
 {r.case_id&&<p>Case {r.case_id}</p>}{r.request_id&&<p>Request {r.request_id}</p>}{r.shipment_id&&<p>Parcel {r.shipment_id}</p>}{r.receipt_id&&<p>Receipt {r.receipt_id}</p>}
 {r.adjustment_minor!==null&&<p>Agreed adjustment: {money(r.adjustment_minor,r.currency)}</p>}{r.amount_minor!==null&&<p>Recorded amount: {money(r.amount_minor,r.currency)}</p>}{r.disposition&&<p>{r.disposition} · {r.restock?'Restocked':'Stock unchanged'}</p>}{(r.carrier||r.tracking_number)&&<p>{r.carrier} · {r.tracking_number}</p>}
 {r.emailStatus&&<p>Notice: {r.emailStatus} · {r.emailAttempts} attempts{r.emailError?` · ${r.emailError}`:''}{r.emailNext?` · Next attempt ${dateTime(r.emailNext)}`:''}</p>}</li>)}</ul>:<p>No replacement or exchange activity recorded.</p>}
 <OperationsPagination offset={h.offset} total={h.total} loading={read.loading} change={setOffset}/></>}</section>;
}
export default function OrderRecoveryHistory({orderId}:{orderId:string}){
 const [open,setOpen]=useState(false);return <details className="ecom-admin__aftercare ecom-admin__recovery-history" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Replacement and exchange history</summary>{open&&<HistoryPage orderId={orderId}/>}</details>;
}
