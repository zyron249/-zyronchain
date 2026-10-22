(() => {
  'use strict';

  const RELEASE_REF = 'b5ea11bf2683a7241cd4bf819f9bda9c4e3759c7';
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