(() => {
  'use strict';

  const RELEASE_REF = 'c3737bd80eb6a3bccb9a4468ba48618a20c51730';
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