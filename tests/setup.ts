/**
 * Suite-wide proxy hermeticity.
 *
 * Broker tests talk to local fake brokers on 127.0.0.1. An inherited
 * `NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY` (e.g. a corporate laptop or the
 * hostile-env CI step) must not change what those tests observe: the default
 * broker transport would otherwise route loopback traffic into the proxy or
 * fail closed. Policy tests pass `env` explicitly, so deleting the ambient
 * variables here loses no coverage — the hostile environment is exercised
 * deterministically in `tests/brokerTransport.test.ts`.
 */
for (const name of [
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'PSC_TRUSTED_PROXY',
] as const) {
  delete process.env[name];
}
