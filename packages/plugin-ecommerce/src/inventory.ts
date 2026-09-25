import type { DurableObject } from 'cloudflare:workers';

/**
 * InventoryDO
 * 
 * A Cloudflare Durable Object responsible for serializing stock reservation 
 * requests to prevent overselling during high-concurrency scenarios (e.g., flash sales).
 * 
 * Each Durable Object instance manages the inventory for a single product.
 */
export class InventoryDO {
  ctx: any;
  env: any;
  /**
   * Maximum allowed reserved stock for the item. In a production scenario, 
   * this would be initialized from D1, but we cache it in the DO's storage for fast synchronous checks.
   */
  private totalStock: number = 0;
  
  /**
   * The currently reserved stock quantity.
   */
  private reservedStock: number = 0;
  
  private isInitialized = false;

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
    // ctx.storage is available for persistence across DO restarts
  }

  /**
   * Ensures the DO has loaded the stock numbers from storage into memory.
   */
  private async ensureInitialized() {
    if (this.isInitialized) return;

    this.totalStock = (await this.ctx.storage.get('totalStock')) || 0;
    this.reservedStock = (await this.ctx.storage.get('reservedStock')) || 0;
    
    this.isInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    
    const url = new URL(request.url);
    
    // API: POST /reserve
    if (request.method === 'POST' && url.pathname === '/reserve') {
      const data = await request.json() as { quantity: number };
      const { quantity } = data;
      
      if (typeof quantity !== 'number' || quantity <= 0) {
        return Response.json({ error: 'Invalid quantity' }, { status: 400 });
      }

      const availableStock = this.totalStock - this.reservedStock;

      if (availableStock >= quantity) {
        // Reserve the stock memory update synchronously
        this.reservedStock += quantity;
        
        // Persist to storage asynchronously to complete the request faster
        this.ctx.storage.put('reservedStock', this.reservedStock);
        
        return Response.json({ 
          success: true, 
          reservedStock: this.reservedStock, 
          remainingStock: this.totalStock - this.reservedStock 
        });
      }

      // Not enough stock
      return Response.json({ 
        success: false, 
        error: 'Insufficient stock', 
        remainingStock: availableStock 
      }, { status: 409 });
    }

    // API: POST /set-stock
    // Used by the CMS when a product's stock is updated in the Admin panel
    if (request.method === 'POST' && url.pathname === '/set-stock') {
       const data = await request.json() as { totalStock: number };
       
       this.totalStock = data.totalStock;
       
       // Ensure we don't end up with negative available stock logic, though that might be conceptually alright.
       this.ctx.storage.put('totalStock', this.totalStock);
       
       return Response.json({ success: true, totalStock: this.totalStock });
    }

    // API: GET /stock
    if (request.method === 'GET' && url.pathname === '/stock') {
        const availableStock = this.totalStock - this.reservedStock;
        return Response.json({ 
          totalStock: this.totalStock, 
          reservedStock: this.reservedStock,
          availableStock
        });
    }

    return new Response('Not found', { status: 404 });
  }
}
