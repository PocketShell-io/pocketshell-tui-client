import { describe, expect, it } from 'vitest';
import * as core from '../src/clientCore.js';
import * as broker from '../src/account/broker.js';
import { HostClient } from '../src/hostClient.js';
import { openConnection } from '../src/transport/index.js';
import { parseHostKey } from '../src/gateway/pins.js';
import { deviceLogin } from '../src/account/device.js';

describe('public client core entrypoint', () => {
  it('exports the same implementations used by psc, without alternate protocols', () => {
    expect(core.startDevice).toBe(broker.startDevice);
    expect(core.pollDevice).toBe(broker.pollDevice);
    expect(core.getSession).toBe(broker.getSession);
    expect(core.logout).toBe(broker.logout);
    expect(core.mintGatewayToken).toBe(broker.mintGatewayToken);
    expect(core.HostClient).toBe(HostClient);
    expect(core.openConnection).toBe(openConnection);
    expect(core.parseHostKey).toBe(parseHostKey);
    expect(core.deviceLogin).toBe(deviceLogin);
  });
  it('runs shared device primitives with the existing wire contract', async () => {
    const fetch: typeof globalThis.fetch = async (url, init) => {
      expect(String(url)).toBe('https://broker.example.com/auth/device/start');
      expect(JSON.parse(init?.body as string)).toEqual({ label: 'MCP test' });
      return new Response(JSON.stringify({ device_code: 'synthetic_device_code_123456789', user_code: 'BCDF-GHJK', verification_uri: 'https://approval.example.com/device', expires_in: 600, interval: 5 }), { status: 200 });
    };
    const pending = await core.startDevice('https://broker.example.com', 'MCP test', { fetch });
    expect(pending.userCode).toBe('BCDF-GHJK');
    expect(pending.interval).toBe(5);
  });
});
