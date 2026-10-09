/**
 * Test stand-in for `pocketshell-client gateway proxy` used as the
 * ProxyCommand in the end-to-end gateway test: same argv shape
 * (`gateway proxy <id> [--server X] [--insecure-dev] [--status-file P]`),
 * same runProxy, but a fixed token instead of the account layer.
 * PSC_TEST_GATEWAY_TOKEN_ERROR makes the token mint fail the way the
 * account layer does on a broker 401 (NotLoggedIn).
 */
import { NotLoggedIn } from '../../src/account/errors.js';
import { resolveEndpoint } from '../../src/gateway/endpoint.js';
import { runProxy } from '../../src/gateway/proxy.js';

const args = process.argv.slice(2);
if (args[0] !== 'gateway' || args[1] !== 'proxy' || !args[2]) {
  process.stderr.write('usage: gateway proxy <id> [--server X] [--insecure-dev] [--status-file P]\n');
  process.exit(2);
}
const deviceId = args[2];
const valueOf = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const endpoint = resolveEndpoint(valueOf('--server'), args.includes('--insecure-dev'));
const statusFile = valueOf('--status-file');
const code = await runProxy({
  deviceId,
  endpoint,
  tokenProvider: async () => {
    const failure = process.env.PSC_TEST_GATEWAY_TOKEN_ERROR;
    if (failure) throw new NotLoggedIn(failure);
    return process.env.PSC_TEST_GATEWAY_TOKEN ?? 'test-token';
  },
  stdin: process.stdin,
  stdout: process.stdout,
  ...(statusFile ? { statusFile } : {}),
});
process.exit(code);
