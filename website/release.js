(() => {
  'use strict';

  const RELEASE_REF = 'b4eb699e8d3f3395e308b28d2d6f7eb922ae4974';
  if (!/^[0-9a-f]{40}$/.test(RELEASE_REF)) {
    throw new Error('Invalid ZyronChain canonical release reference');
  }

  Object.defineProperty(globalThis, 'ZYRON_RELEASE_REF', {
    value: RELEASE_REF,
    writable: false,
    configurable: false,
    enumerable: false
  });
})();