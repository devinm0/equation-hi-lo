/** @type {import('jest').Config} */
const config = {
  globals: {
    'ts-jest': {
      useESM: true,
      tsconfig: {
        inlineSourceMap: true,
        inlineSources: true
      }
    }
  },  
  testEnvironment: 'node',
  transform: {
      '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

export default config;

