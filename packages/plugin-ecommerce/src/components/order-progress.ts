/** Customer-facing copy uses payment facts; shipment progress is reported separately. */
export function orderProgress(status: string, underReview = false) {
  if (underReview) return {title:'Your payment is being reviewed.',detail:'We’re checking your payment. Please wait for an update before making another payment.',tone:'pending'};
  if (status === 'paid' || status === 'fulfilled') return {title:'It’s yours. Thank you.',detail:'Payment confirmed. Your order details and updates are all here.',tone:'paid'};
  if (status === 'partially_refunded') return {title:'Your refund update.',detail:'Part of your payment has been refunded. Your order, delivery and refund details are shown below.',tone:'closed'};
  if (status === 'disputed') return {title:'Your payment is under review.',detail:'A payment dispute is being reviewed. Check your order details below and contact the store if you need help.',tone:'closed'};
  if (status === 'draft') return {title:'Your order is not confirmed yet.',detail:'Payment has not been confirmed for this order. Return to your cart to review your checkout.',tone:'closed'};
  if (status === 'pending') return {title:'Checking your payment.',detail:'Your payment is still awaiting confirmation. You can refresh this page for an update. Please don’t pay again while we check.',tone:'pending'};
  if (status === 'cancelled') return {title:'This checkout was cancelled.',detail:'You can return to your cart to review your items and start again.',tone:'closed'};
  if (status === 'refunded') return {title:'Your order was refunded.',detail:'Your refund details are shown below. The time to receive a payment refund depends on your payment provider.',tone:'closed'};
  if (status === 'failed') return {title:'Payment wasn’t completed.',detail:'Review your cart before starting a new checkout. Your order has not been confirmed.',tone:'closed'};
  return {title:'Your order details.',detail:'Check the latest payment and delivery details below.',tone:'pending'};
}
