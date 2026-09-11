export function createClientCapability(prefix, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
    const error = new Error('secure_random_unavailable');
    error.code = 'secure_random_unavailable';
    throw error;
  }
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${String(prefix || 'capability')}-${token}`;
}
