import { jest } from '@jest/globals';

// Existing specs use Jest's classic global. Jest does not expose it in ESM
// tests, so bridge it while the application migrates its test runtime.
(globalThis as typeof globalThis & { jest: typeof jest }).jest = jest;
