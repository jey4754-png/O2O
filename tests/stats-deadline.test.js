import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/stats.js';

for (const mode of ['collector', 'proxy']) {
  for (const slowSuccess of [true, false]) {
    test(`stats ${mode}: ${slowSuccess ? '35-second response survives shared 30-second deadline' : 'unresponsive upstream returns bounded 504'}`, async (t) => {
      const settings = {
        O2O_DATA_API_ORIGIN: mode === 'proxy' ? 'https://data.example.test' : '',
        O2O_DATA_API_TOKEN: mode === 'proxy' ? 'synthetic-service-token' : '',
        GOOGLE_SHEETS_COLLECTOR_URL: 'https://collector.example.test/exec',
        GOOGLE_SHEETS_COLLECTOR_TOKEN: 'synthetic-collector-token',
        O2O_UPSTREAM_TIMEOUT_MS: '30000',
      };
      const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
      Object.assign(process.env, settings);
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.mock.method(AbortSignal, 'timeout', (delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), delay);
        return controller.signal;
      });
      let calls = 0;
      t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
        calls += 1;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (slowSuccess) setTimeout(() => resolve({
            ok: true, status: 200,
            async json() { return { ok: true, stats: { totalEvents: 42 } }; },
          }), 35000);
        });
      });
      const response = {
        statusCode: 0, body: null,
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      const pending = handler({ method: 'GET' }, response);
      // The direct collector branch awaits the absent proxy before fetching.
      await Promise.resolve();
      t.mock.timers.tick(slowSuccess ? 35000 : 50000);
      await pending;
      assert.equal(calls, 1, 'do not duplicate an expensive aggregate read');
      assert.equal(response.statusCode, slowSuccess ? 200 : 504);
      assert.deepEqual(response.body, slowSuccess
        ? { ok: true, stats: { totalEvents: 42 } }
        : { ok: false, error: 'upstream_timeout' });
    });
  }
}
