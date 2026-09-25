export function getPrimaryProductImage(product: { images?: unknown[] | null } | null | undefined) {
  if (!Array.isArray(product?.images)) return null;

  for (const image of product.images) {
    if (typeof image === 'string' && image.trim()) return image;
    if (image && typeof image === 'object' && typeof (image as { url?: unknown }).url === 'string' && (image as { url: string }).url.trim()) {
      return (image as { url: string }).url;
    }
  }

  return null;
}
