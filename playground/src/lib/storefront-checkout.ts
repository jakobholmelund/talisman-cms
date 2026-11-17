import { startCheckout, shippingOptionsFor, type ShippingRate } from '@talisman-cms/plugin-ecommerce/browser';
import { formatMoney } from '@talisman-cms/plugin-ecommerce/money';
import { estimatedPayment } from '@talisman-cms/plugin-ecommerce/components/delivery-options.ts';

function setupCheckout() {
  const form = document.querySelector<HTMLFormElement>('#checkout-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  const feedback = document.querySelector<HTMLElement>('#checkout-feedback')!;
  const fields = form.querySelector<HTMLFieldSetElement>('[data-checkout-fields]')!;
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const applyButton = form.querySelector<HTMLButtonElement>('[data-apply-codes]')!;
  const codeFeedback = form.querySelector<HTMLElement>('[data-code-feedback]')!;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
  const value = (name: string) => input(name)?.value.trim() || '';
  const state = JSON.parse(document.querySelector('[data-delivery-state]')?.textContent || '{}') as {currency:string; subtotal:number; rates:ShippingRate[];deliveryCountries:string[]|null;taxMode:string};
  const physical = form.dataset.requiresShipping === 'true';
  const enabled = form.dataset.checkoutEnabled === 'true';
  const summary = document.querySelector<HTMLDetailsElement>('[data-checkout-summary]');
  if (summary) summary.open = !matchMedia('(max-width:850px)').matches;
  let busy = false;
  let applied = '';
  let reductions = {discountAmount:0, creditApplied:0, giftCardApplied:0};
  let selectedRate = '';
  const codeKey = () => JSON.stringify([value('discountCode'), value('giftCardCode'), value('shippingCountry'), selectedRate]);
  const rates = () => physical ? shippingOptionsFor({shippingRates:state.rates, deliveryCountries:state.deliveryCountries},value('shippingCountry'),state.subtotal-reductions.discountAmount) : [];
  const setText = (selector:string, text:string) => { const node = document.querySelector(selector); if (node) node.textContent = text; };
  const actionLabel = () => value('giftCardCode') ? 'Place order or continue to payment →' : 'Continue to secure payment →';
  function updateTotals() {
    const rate = rates().find(rate => rate.id === selectedRate);
    const known = !physical || !state.rates.length || Boolean(rate);
    setText('[data-shipping-summary]', !physical ? 'Not required' : rate ? rate.amount ? formatMoney(rate.amount,state.currency) : 'Free' : !state.rates.length ? 'Free' : value('shippingCountry') ? 'Unavailable' : 'Choose your country');
    const due = estimatedPayment(state.subtotal,rate?.amount ?? 0,reductions);
    const covered = known && applied === codeKey() && reductions.giftCardApplied > 0 && due === 0 && state.taxMode === 'none';
    if (!busy) button.textContent = covered ? 'Place order · paid with gift card →' : actionLabel();
    setText('[data-checkout-reassurance]', value('giftCardCode') ? 'Placing your order uses your gift card. If a balance remains, you’ll complete it at secure payment.' : 'You’ll review the final amount before paying. Your details stay here if anything needs correcting.');
    const total = formatMoney(due,state.currency);
    setText('[data-estimated-total]',total); setText('[data-mobile-total]',total);
    for (const [name, amount] of [['discount',reductions.discountAmount],['credit',reductions.creditApplied],['gift',reductions.giftCardApplied]] as const) {
      const row = document.querySelector<HTMLElement>(`[data-${name}-row]`); if(row) row.hidden = !amount;
      setText(`[data-${name}-summary]`,`−${formatMoney(amount,state.currency)}`);
    }
    setText('[data-total-note]', `${known ? 'Includes your selected delivery.' : 'Delivery is not included yet.'} ${state.taxMode === 'stripe-exclusive' ? 'Tax is calculated before payment. ' : ''}Availability, codes and any credit are checked when you continue.`);
  }
  function showRates() {
    const list = form!.querySelector('[data-delivery-rates]');
    const options = rates(); selectedRate = options.some(rate => rate.id === selectedRate) ? selectedRate : options[0]?.id || '';
    if (list) {
      list.replaceChildren();
      const placeholder = form!.querySelector<HTMLElement>('[data-delivery-placeholder]');
      if (placeholder) { placeholder.hidden = options.length > 0; placeholder.textContent = value('shippingCountry') ? 'Delivery is unavailable for this country.' : 'Choose your country to see delivery options.'; }
      for(const rate of options) {
        const label = document.createElement('label'); const radio = document.createElement('input');
        radio.type='radio'; radio.name='shippingRateId'; radio.value=rate.id; radio.required=true; radio.checked=rate.id===selectedRate;
        const text = document.createElement('span'); text.textContent=rate.label;
        if(rate.description){const estimate=document.createElement('small');estimate.textContent=rate.description;text.appendChild(estimate);}
        const cost = document.createElement('strong');cost.textContent=rate.amount ? formatMoney(rate.amount,state.currency) : 'Free';
        radio.addEventListener('change',()=>{selectedRate=rate.id;invalidateEstimate();showRates();});label.appendChild(radio);label.appendChild(text);label.appendChild(cost);list.appendChild(label);
      }
    }
    updateTotals();
  }
  function invalidateEstimate() {
    applied=''; reductions={discountAmount:0,creditApplied:0,giftCardApplied:0};
    if(value('discountCode')||value('giftCardCode')) codeFeedback.textContent='Apply your codes again to update the estimate for this delivery.';
  }
  function announce(message:string,error=false){feedback.textContent=message;feedback.setAttribute('role',error?'alert':'status');if(error)feedback.focus();}
  function setBusy(value:boolean){busy=value;fields.disabled=value;button.disabled=value||!enabled;applyButton.disabled=value||!enabled;form!.setAttribute('aria-busy',String(value));if(!value)updateTotals();}
  async function validateCodes() {
    const key = codeKey();
    if (!value('discountCode') && !value('giftCardCode')) {applied=key;reductions={discountAmount:0,creditApplied:0,giftCardApplied:0};showRates();return true;}
    if (applied === key) return true;
    codeFeedback.textContent='Checking your codes…';codeFeedback.setAttribute('role','status');
    try {
      const response=await fetch('/api/ecommerce/discount',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value('discountCode')||undefined,giftCardCode:value('giftCardCode')||undefined,shippingCountry:physical?value('shippingCountry')||undefined:undefined,shippingRateId:physical?selectedRate||undefined:undefined})});
      const result=await response.json() as {error?:string;discountAmount:number;creditApplied:number;giftCardApplied:number};if(!response.ok)throw new Error(result.error||'Could not check your codes. Please try again.');
      if(![result.discountAmount,result.creditApplied,result.giftCardApplied].every(amount=>Number.isSafeInteger(amount)&&amount>=0))throw new Error('Could not confirm the code estimate. Please try again.');
      reductions={discountAmount:result.discountAmount||0,creditApplied:result.creditApplied||0,giftCardApplied:result.giftCardApplied||0};applied=key;
      codeFeedback.textContent='Codes applied to your estimate. Delivery is included when selected. Eligibility is checked when you continue.';showRates();return true;
    }catch(error){codeFeedback.setAttribute('role','alert');codeFeedback.textContent=error instanceof Error?error.message:'Could not check your codes. Please try again.';return false;}
  }
  const country=input('shippingCountry') as HTMLSelectElement|null;
  try{const saved=sessionStorage.getItem('talisman:delivery-country');if(country&&saved&&Array.from(country.options).some(option=>option.value===saved))country.value=saved;}catch{}
  country?.addEventListener('change',()=>{try{sessionStorage.setItem('talisman:delivery-country',country.value);}catch{}invalidateEstimate();showRates();});
  ['discountCode','giftCardCode'].forEach(name=>input(name)?.addEventListener('input',()=>{applied='';reductions={discountAmount:0,creditApplied:0,giftCardApplied:0};codeFeedback.textContent='Apply your changes to update the estimate.';showRates();}));
  applyButton.addEventListener('click',async()=>{if(busy||!enabled)return;setBusy(true);try{await validateCodes();}finally{setBusy(false);}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!enabled||!form.reportValidity())return;
    if(physical&&state.rates.length&&!selectedRate){announce('Choose an available delivery method.',true);return;}
    // Read values before disabling the controls; disabled controls are excluded from FormData.
    const address=form.dataset.needsAddress==='true'?{name:value('shippingName'),line1:value('shippingLine1'),line2:value('shippingLine2'),city:value('shippingCity'),state:value('shippingState'),postalCode:value('shippingPostalCode'),country:value('shippingCountry')}:undefined;
    const payload={customerEmail:value('customerEmail'),shippingAddress:physical?address:undefined,billingAddress:address,discountCode:value('discountCode')||undefined,giftCardCode:value('giftCardCode')||undefined};
    setBusy(true);button.textContent='Preparing your order…';announce('Checking availability and preparing your order…');
    try{
      if(!await validateCodes()){announce('Please check your discount or gift card code, or remove it to continue.',true);setBusy(false);updateTotals();return;}
      const result=await startCheckout({...payload,shippingRateId:selectedRate||undefined});
      if(!result.redirectUrl)throw new Error('Payment could not be opened. Please try again.');
      window.location.assign(result.redirectUrl);
    }catch(error){setBusy(false);updateTotals();announce(error instanceof Error?error.message:'Could not open payment. Please try again.',true);}
  });
  showRates();setBusy(false);
}
document.addEventListener('astro:page-load',setupCheckout);
setupCheckout();
