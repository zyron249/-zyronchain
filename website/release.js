(() => {
  'use strict';

  const RELEASE_REF = 'b8049e1ddd4081e4bc6ea783e8b0f3e45c0c9b9f';
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