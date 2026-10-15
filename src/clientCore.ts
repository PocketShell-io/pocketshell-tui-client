/**
 * Reusable PocketShell client core. The terminal client and remote adapters
 * use these exact implementations; adapters must not implement a second SSH,
 * host trust, device grant or aplexer protocol.
 *
 * Account broker methods take an explicit broker URL, bearer and transport.
 * DeviceLogin owns the interactive polling/saving flow. Headless OAuth bridges
 * use startDevice/pollDevice/parseDeviceToken/getSession/logout at the same
 * boundary, retaining the upstream device approval contract.
 *
 * Host operations retain the existing per-process config paths. A multi-user
 * server must run them in isolated processes/config directories; never mutate
 * process.env across concurrent users. No mutable ambient state is added here.
 */
export {
  startDevice, pollDevice, parseDeviceToken, getSession, logout,
  mintGatewayToken, request, errorCode, describeFailure,
  type DeviceStart, type DeviceToken, type SessionInfo, type HttpOptions,
} from './account/broker.js';
export { deviceLogin, pendingDeviceLogin, rewriteVerificationUri, USER_CODE_RE, validateLabel, type PendingLogin } from './account/device.js';
export { validateBrokerUrl, sameOrigin } from './account/config.js';
export { fetchDevices, type DeviceInfo } from './gateway/devices.js';
export { resolveEndpoint, type GatewayEndpoint } from './gateway/endpoint.js';
export { loadPins, requirePinEntry, parseHostKey, fingerprint } from './gateway/pins.js';
export { HostClient, pickSession, encodeSendPayload } from './hostClient.js';
export { openConnection } from './transport/index.js';
export { validateHostEntry, pickHost, type HostEntry } from './hosts/store.js';
