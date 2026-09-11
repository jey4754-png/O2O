const foregroundQueue = [];
const backgroundQueue = [];

let draining = false;
let drainScheduled = false;

function scheduleDrain() {
  if (
    draining
    || drainScheduled
    || (foregroundQueue.length === 0 && backgroundQueue.length === 0)
  ) return;

  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    void drainQueue();
  });
}
async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (foregroundQueue.length > 0 || backgroundQueue.length > 0) {
      const entry = foregroundQueue.shift() || backgroundQueue.shift();
      try {
        entry.resolve(await entry.operation());
      } catch (error) {
        entry.reject(error);
      }
    }
  } finally {
    draining = false;
    scheduleDrain();
  }
}

export function runCentralMutation(operation, { priority = 'foreground' } = {}) {
  if (typeof operation !== 'function') {
    return Promise.reject(new TypeError('central_mutation_operation_required'));
  }

  const queue = priority === 'background' ? backgroundQueue : foregroundQueue;
  const request = new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
  });
  scheduleDrain();
  return request;
}
