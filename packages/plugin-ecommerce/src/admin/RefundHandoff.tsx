import React, {useEffect,useRef} from 'react';
import type {readRefundCase} from '@talisman-cms/plugin-ecommerce/operations';
import {CommerceCaseLink, money} from './common';
import {useAftercareRead} from './aftercare-read';
import {OperationsReadStatus} from './operations-common';
type Case = Awaited<ReturnType<typeof readRefundCase>>;
const valid = (v:unknown):v is Case => !!v && typeof (v as Case).orderId==='string' && Number.isSafeInteger((v as Case).giftCardRemainingMinor);
/** Receipt ID is only a navigation hint. Prefill from the protected server read, never the URL. */
export function RefundHandoff({receiptId,onLoaded,refreshToken}:{receiptId:string;refreshToken:string;onLoaded:(orderId:string,amount:number)=>void}) {
  const read=useAftercareRead('refundRead',{receiptId},valid),r=read.data,root=useRef<HTMLDivElement>(null),focused=useRef(false);
  useEffect(()=>{if(r&&!read.unavailable.current){onLoaded(r.orderId,r.status==='needed'?Math.min(r.amountMinor,r.giftCardRemainingMinor):0);if(!focused.current){focused.current=true;root.current?.focus({preventScroll:true});root.current?.scrollIntoView({block:'start'});}}},[r]);
  useEffect(()=>{if(refreshToken)void read.load();},[refreshToken]);
  return <div ref={root} tabIndex={-1} aria-label="Selected return refund" className="ecom-admin__notice"><OperationsReadStatus loading={read.loading} error={read.error} reload={()=>void read.load()}/>{r&&<><strong>Return refund · {r.items.map(i=>`${i.quantity} × ${i.name}`).join(', ')}</strong><p>Order {r.orderId} · Planned {money(r.amountMinor,r.currency)} · Gift card payment still refundable {money(r.giftCardRemainingMinor,r.currency)}</p><p>After the refund is confirmed, return to this case to allocate the payment and complete follow-up.</p><CommerceCaseLink tool="refunds" kind="refund" id={receiptId} orderId={r.orderId}>Return to refund follow-up →</CommerceCaseLink></>}</div>;
}
