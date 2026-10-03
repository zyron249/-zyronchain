(() => {
  'use strict';

  const RELEASE_REF = 'bf27fa0e27c51389fccf6e9d76799a199d3d29fa';
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