export interface CartItem {
  key: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
  productName: string;
  variantLabel?: string | null;
  imageUrl?: string | null;
  unitPrice: number;
  lineTotal: number;
  type: string;
  isPhysical?: boolean;
  availableQuantity?: number | null;
  unavailable?: boolean;
  stockLabel: string;
  href: string;
}
