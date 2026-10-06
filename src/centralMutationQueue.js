const foregroundQueue = [];
const backgroundQueue = [];

let foregroundActive = false;
let backgroundActive = false;
let drainScheduled = false;

function scheduleDrain() {
  if (
    drainScheduled
    || (foregroundQueue.length === 0 && backgroundQueue.length === 0)
  ) return;

  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    drainQueue();
  });
}
function drainQueue() {
  // A slow analytics/read-receipt response must not hold the user's next
  // message or payment intent. User mutations remain serial, and at most one
  // background request may overlap them. No further background work starts
  // until both lanes and the waiting foreground queue are idle.
  const priority = !foregroundActive && foregroundQueue.length > 0 ? 'foreground'
    : !foregroundActive && !backgroundActive && foregroundQueue.length === 0
      && backgroundQueue.length > 0 ? 'background' : null;
  if (!priority) return;
  const entry = (priority === 'foreground' ? foregroundQueue : backgroundQueue).shift();
  if (priority === 'foreground') foregroundActive = true;
  else backgroundActive = true;
  void Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
    if (priority === 'foreground') foregroundActive = false;
    else backgroundActive = false;
    scheduleDrain();
  });
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
