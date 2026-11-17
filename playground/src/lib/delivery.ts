import { COUNTRY_CODES, readStoreSettings } from '@talisman-cms/plugin-ecommerce';

export function deliveryDetails(settings: ReturnType<typeof readStoreSettings>, physical = true) {
  const names = new Intl.DisplayNames(['en'], {type: 'region'});
  const countries = (physical ? settings.deliveryCountries ?? COUNTRY_CODES : COUNTRY_CODES)
    .filter(code => !physical || !settings.shippingRates.length || settings.shippingRates.some(rate => !rate.countries || rate.countries.includes(code)))
    .map(code => ({code, name: names.of(code) ?? code})).sort((a,b) => a.name.localeCompare(b.name));
  return {rates: settings.shippingRates, deliveryCountries: settings.deliveryCountries, countries, taxMode: settings.tax.mode};
}
