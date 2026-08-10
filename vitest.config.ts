import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest is wired to test the engine-agnostic game logic under
 * `assets/scripts/core/`. Cocos-coupled files (anything importing 'cc') are
 * excluded — they get manually smoke-tested in the editor.
 */
export default defineConfig({
    test: {
        include: ['tests/**/*.{test,spec}.ts'],
        exclude: [
            '**/node_modules/**',
            '**/library/**',
            '**/temp/**',
            '**/build/**',
        ],
        environment: 'node',
        globals: false,
        // Cocos auto-generated tsconfig pulls in `cc`, which Node can't resolve.
        // We point Vitest at a slim tsconfig that only knows about the `core/` layer.
        typecheck: {
            tsconfig: './tsconfig.test.json',
        },
    },
    resolve: {
        alias: {
            '@core': path.resolve(__dirname, 'assets/scripts/core'),
        },
    },
});
