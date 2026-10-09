import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { z, ZodError } from 'zod';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { readCartSessionToken, readOrderAccess } from '../cookies';
import { readBoundedJson } from '../request-body';
import { CommerceOperationsConflict } from '../email-recovery';
import { ShopperError } from '../shopper-errors';
const id=z.string().trim().min(1).max(128);
export const ALL:APIRoute=async({request,cookies})=>{
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(!['GET','POST'].includes(request.method))return Response.json({error:'Method not allowed'},{status:405,headers:{...headers,Allow:'GET, POST'}});
  if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Same-origin request required'},{status:403,headers});
  try {
    const body=request.method==='POST'?z.object({action:z.enum(['request','cancel']),data:z.record(z.unknown())}).strict().parse(await readBoundedJson(request,32768)):null;
    const orderId=id.parse(body?body.data.orderId:new URL(request.url).searchParams.get('order'));
    const {env}=await import('cloudflare:workers');const runtimeEnv=env as unknown as TalismanEnv;
    const customer=await findCustomerSession(runtimeEnv,cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    const owner={sessionToken:readCartSessionToken(cookies),customerId:customer?.id,orderAccessToken:readOrderAccess(cookies,orderId)};
    const api=bindCommerceApi({env:runtimeEnv});
    const result=body?(body.action==='request'?await api.returns.request(body.data,owner):await api.returns.cancel(body.data,owner)):await api.returns.read(orderId,owner);
    if(!result)return Response.json({error:'Order not found'},{status:404,headers});
    return Response.json(result,{headers});
  }catch(error){
    if(error instanceof ZodError || error instanceof SyntaxError)return Response.json({error:'Check the return quantities and details.'},{status:400,headers});
    if(error instanceof ShopperError)return Response.json({error:error.message},{status:error.status,headers});
    if(error instanceof CommerceOperationsConflict)return Response.json({error:error.message},{status:409,headers});
    console.error('[commerce] Return request failed',{name:error instanceof Error?error.name:typeof error});
    return Response.json({error:'Return requests are temporarily unavailable. Please try again.'},{status:503,headers});
  }
};
