module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  setupFiles: ["<rootDir>/.jest/setEnvVars.ts"],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  verbose: true
}