import { previewCustomerSignIn, readCustomerSignInToken, requestCustomerEmailSignIn, signOutCustomerAccount, verifyCustomerEmailSignIn, customerOrderDestination } from '@talisman-cms/plugin-ecommerce/browser';

type Turnstile = { render: (element: HTMLElement, options: Record<string,unknown>) => string; reset: (id: string) => void };
declare global { interface Window { turnstile?: Turnstile } }
const errorText = (error: unknown) => error instanceof Error ? error.message : 'We couldn’t connect. Please try again.';
function feedback(element: HTMLElement | null, message: string, tone = 'error') {
  if (element) { element.textContent = message; element.dataset.tone = tone; }
}

async function setupSignIn(form: HTMLFormElement) {
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const message = form.querySelector<HTMLElement>('[data-signin-feedback]');
  let widget: string | undefined, botToken = '', busy = false, cooldown = 0;
  const label = () => { button.disabled = busy || cooldown > 0 || Boolean(form.dataset.sitekey && !botToken); button.textContent = busy ? 'Sending your link…' : cooldown > 0 ? `Send another link in ${cooldown}s` : 'Email me a sign-in link →'; };
  if (form.dataset.sitekey) {
    label();
    try {
      if (!window.turnstile) await new Promise<void>((resolve,reject) => {
        const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
        script.onload = () => resolve(); script.onerror = () => reject(new Error('The security check couldn’t load. Please reload this page to try again.')); document.head.appendChild(script);
      });
      widget = window.turnstile!.render(form.querySelector<HTMLElement>('[data-signin-botcheck]')!, { sitekey: form.dataset.sitekey, action: form.dataset.turnstileAction,
        callback: (token: string) => { botToken = token; label(); }, 'expired-callback': () => { botToken = ''; label(); }, 'error-callback': () => { botToken = ''; label(); feedback(message,'The security check couldn’t finish. Please reload this page to try again.'); } });
    } catch (error) { feedback(message,errorText(error)); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (button.disabled || busy) return;
    busy = true; label(); feedback(message,'');
    try {
      await requestCustomerEmailSignIn(String(new FormData(form).get('email') || ''), { ...(botToken ? {turnstileToken:botToken} : {}), ...(form.dataset.orderId ? {orderId:form.dataset.orderId} : {}) });
      feedback(message, 'Check your inbox. If a link can be sent to this address, it will arrive shortly. Check spam too, or correct your email and try again.', 'success');
      cooldown = 60; const timer = window.setInterval(() => { cooldown--; label(); if(cooldown<=0) window.clearInterval(timer); },1000);
    } catch (error) { feedback(message,errorText(error)); }
    finally { busy = false; if (widget !== undefined) { botToken = ''; window.turnstile?.reset(widget); } label(); }
  });
}

async function setupVerify(root: HTMLElement) {
  // Capture only an allowlisted order ID before the helper scrubs the credential from the URL.
  const order = customerOrderDestination(new URLSearchParams(location.hash.slice(1)).get('order'));
  const token = readCustomerSignInToken();
  const form = root.querySelector<HTMLFormElement>('[data-verify-form]')!;
  const detail = root.querySelector<HTMLElement>('[data-verify-detail]')!;
  const message = root.querySelector<HTMLElement>('[data-verify-feedback]');
  const newLink = root.querySelector<HTMLAnchorElement>('[data-new-signin]')!;
  newLink.href = order ? `/account?order=${encodeURIComponent(order)}` : '/account';
  if (!token) { detail.textContent = 'This link is missing or has already been opened. Request a fresh link to continue.'; return; }
  try { const preview = await previewCustomerSignIn(token); detail.textContent = `Sign in as ${preview.email}?`; form.hidden = false; }
  catch(error) { detail.textContent = 'Let’s get you a fresh start.'; feedback(message,errorText(error)); return; }
  let busy = false;
  form.addEventListener('submit',async event => {
    event.preventDefault(); if(busy)return; busy=true;
    const button = form.querySelector<HTMLButtonElement>('button')!; button.disabled=true; button.textContent='Opening your account…';
    try { await verifyCustomerEmailSignIn(token); location.replace(order ? `/account?order=${encodeURIComponent(order)}` : '/account'); }
    catch(error) { feedback(message,errorText(error)); button.disabled=false; button.textContent='Try signing in again'; busy=false; }
  });
}

async function accountAction(action: 'export' | 'revoke') {
  const response = await fetch('/api/ecommerce/account',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  const data = await response.json() as {error?: string}; if(!response.ok)throw new Error(data.error || 'Your account request could not be completed.'); return data;
}

const signIn = document.querySelector<HTMLFormElement>('[data-account-signin]');
if (signIn) void setupSignIn(signIn);
const verification = document.querySelector<HTMLElement>('[data-account-verify]');
if (verification) void setupVerify(verification);
const accountButtons = document.querySelectorAll<HTMLButtonElement>('[data-account-signout],[data-account-export],[data-account-revoke]');
accountButtons.forEach(button=>button.addEventListener('click',async()=>{
  const message = document.querySelector<HTMLElement>('[data-account-feedback]');
  const revoke = button.hasAttribute('data-account-revoke');
  if (revoke && !window.confirm('Sign out of your Talisman account on every device? You can sign in again with a fresh email link.'))return;
  accountButtons.forEach(b=>b.disabled=true); feedback(message,'');
  try {
    if (button.hasAttribute('data-account-export')) {
      const data = await accountAction('export'); const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const link=document.createElement('a'); link.href=url; link.download='talisman-account.json'; link.click(); window.setTimeout(()=>URL.revokeObjectURL(url),10000); feedback(message,'Your account data is ready to download.','success');
    } else { if(revoke)await accountAction('revoke'); await signOutCustomerAccount(); location.replace('/account'); }
  } catch(error) { feedback(message,errorText(error)); }
  finally { accountButtons.forEach(b=>b.disabled=false); }
}));
// Private pages must re-check the session when restored from browser history.
window.addEventListener('pageshow', event => { if(event.persisted) location.reload(); });
