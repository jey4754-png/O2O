// The customer's order history is read by the phone number they are logged in
// with before any key is checked, so a reconnection only shows up on a device
// logged in with the order's own number. The operator needs that number's
// tail to tell the customer which login to use; the full number stays hidden.
export function maskedOrderPhone(order) {
  const digits = String(order?.customerPhone || '').replace(/\D/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '';
}
