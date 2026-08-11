/**
 * No-op stand-in for the `server-only` package under Vitest.
 *
 * The real package throws on import to stop server modules being pulled into a
 * client bundle. That guard is a build-time concern; in the test runner we are
 * deliberately importing those modules directly.
 */
export {};
