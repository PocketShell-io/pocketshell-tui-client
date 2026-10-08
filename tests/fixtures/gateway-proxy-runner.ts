/**
 * Test stand-in for `pocketshell-client gateway proxy` used as the
 * ProxyCommand in the end-to-end gateway test: same argv shape
 * (`gateway proxy <id> [--server X] [--insecure-dev]`), same runProxy, but
 * a fixed token instead of the account layer.
 */
import { resolveEndpoint } from '../../src/gateway/endpoint.js';
import { runProxy } from '../../src/gateway/proxy.js';

const args = process.argv.slice(2);
if (args[0] !== 'gateway' || args[1] !== 'proxy' || !args[2]) {
  process.stderr.write('usage: gateway proxy <id> [--server X] [--insecure-dev]\n');
  process.exit(2);
}
const deviceId = args[2];
const serverAt = args.indexOf('--server');
const server = serverAt >= 0 ? args[serverAt + 1] : undefined;
const endpoint = resolveEndpoint(server, args.includes('--insecure-dev'));
const code = await runProxy({
  deviceId,
  endpoint,
  tokenProvider: async () => process.env.PSC_TEST_GATEWAY_TOKEN ?? 'test-token',
  stdin: process.stdin,
  stdout: process.stdout,
});
process.exit(code);
