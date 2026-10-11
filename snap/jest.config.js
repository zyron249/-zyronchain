module.exports = {
  preset: '@metamask/snaps-jest',
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          jsxImportSource: '@metamask/snaps-sdk',
          module: 'CommonJS',
          moduleResolution: 'Node10',
          esModuleInterop: true,
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          types: ['jest', 'node', 'react'],
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  testTimeout: 60000,
};
