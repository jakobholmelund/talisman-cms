import {getOrderStatus} from '@talisman-cms/plugin-ecommerce/browser';
import {formatMoney} from '@talisman-cms/plugin-ecommerce/money';
import {orderProgress} from '@talisman-cms/plugin-ecommerce/components/order-progress.ts';
function setupReceipt() {
  const root=document.querySelector<HTMLElement>('[data-order-receipt]');
  if(!root||root.dataset.bound)return;
  root.dataset.bound='true';
  root.querySelector('[data-print-order]')?.addEventListener('click',()=>window.print());
  const button=root.querySelector<HTMLButtonElement>('[data-refresh-order]');
  if(!button)return;
  const message=root.querySelector<HTMLElement>('[data-order-update]')!;
  let busy=false,stopped=false,attempts=0;
  const text=(selector:string,value:string)=>{const el=root.querySelector(selector);if(el)el.textContent=value;};
  async function refresh() {
    if(busy||stopped)return;
    busy=true;button!.disabled=true;attempts++;
    message.textContent='Checking your order…';
    try {
      const order=await getOrderStatus(root!.dataset.orderId!);
      if(stopped)return;
      // Pending receipts have no aftercare forms yet. Mount them only after confirmed payment.
      if(root!.dataset.orderStatus==='pending'&&order.status!=='pending'){window.location.reload();return;}
      const progress=orderProgress(order.status,order.paymentUnderReview);
      root!.dataset.orderStatus=order.status;
      text('[data-receipt-title]',progress.title);
      text('[data-receipt-detail]',order.status==='refunded'&&order.paymentProvider==='gift_card'?'Your gift card payment has been restored. Your delivery and return history remain below.':progress.detail);
      text('[data-receipt-status]',order.status.replaceAll('_',' '));
      document.title=`${progress.title} | Talisman`;
      const mark=root!.querySelector<HTMLElement>('[data-receipt-mark]');
      if(mark){mark.dataset.tone=progress.tone;mark.textContent=progress.tone==='paid'?'✓':progress.tone==='pending'?'◷':'—';}
      for(const [kind,amount] of [['gift',order.giftCardRefundedCents],['provider',order.providerRefundedCents],['credit',order.status==='refunded'?order.creditApplied:0]] as const){
        const row=root!.querySelector<HTMLElement>(`[data-${kind}-refund-row]`);if(row)row.hidden=!amount;
        text(`[data-${kind}-refund]`,formatMoney(amount,order.currency));
      }
      message.textContent=order.status==='pending'?'Payment is still being checked. You don’t need to pay again.':'Payment details are up to date.';
    }catch{message.textContent='We couldn’t refresh your payment details. Displayed details may be out of date; please try again.';}
    finally{busy=false;button!.disabled=false;}
  }
  button.addEventListener('click',()=>{void refresh();document.dispatchEvent(new CustomEvent('talisman:refresh-order',{detail:{orderId:root.dataset.orderId}}));});
  const aftercareUpdated=(event:Event)=>{if((event as CustomEvent).detail?.orderId===root.dataset.orderId)void refresh();};
  document.addEventListener('talisman:aftercare-updated',aftercareUpdated);
  const timer=window.setInterval(()=>{if(attempts>=12||root.dataset.orderStatus!=='pending'){clearInterval(timer);return;}if(document.visibilityState==='visible')void refresh();},5000);
  document.addEventListener('astro:before-swap',()=>{stopped=true;clearInterval(timer);document.removeEventListener('talisman:aftercare-updated',aftercareUpdated);},{once:true});
}
document.addEventListener('astro:page-load',setupReceipt);setupReceipt();
