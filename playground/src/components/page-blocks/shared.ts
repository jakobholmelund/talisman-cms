export function getBlockSettings(block: any) {
  return block?._settings || {};
}

export function getSectionClass(block: any, baseClass: string, withBorder = false, index = 0) {
  const settings = getBlockSettings(block);
  const borderClass = withBorder && index > 0 ? ' border-t border-gray-100' : '';
  return `${baseClass}${borderClass}${settings.className ? ` ${settings.className}` : ''}`;
}

export function getContainerClass(block: any, defaultClass: string) {
  const settings = getBlockSettings(block);
  return settings.containerClassName || defaultClass;
}

export function getTheme(block: any) {
  return getBlockSettings(block).dataTheme || undefined;
}

export function getProductImage(product: any) {
  const firstImage = Array.isArray(product?.data?.images) ? product.data.images[0] : null;
  return typeof firstImage === 'string' ? firstImage : firstImage?.url ?? null;
}

export function getProductHref(product: any, fallbackHref = '/shop') {
  if (!product?.id) return fallbackHref;
  return `/shop/${product.id}`;
}
