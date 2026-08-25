const PRODUCTION_ORIGIN = 'https://o2o-ten.vercel.app';

export function dataApiOrigin() {
  const origin = String(process.env.O2O_DATA_API_ORIGIN || '').replace(/\/$/, '');
  const token = String(process.env.O2O_DATA_API_TOKEN || '');
  return origin && token ? origin : '';
}

export async function callDataApi(path, options = {}) {
  const origin = dataApiOrigin();
  if (!origin) return null;
  return fetch(`${origin}${path}`, {
    ...options,
    headers: {
      Origin: PRODUCTION_ORIGIN,
      ...(options.headers || {}),
    },
  });
}
