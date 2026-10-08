/** `gateway devices|pin|unpin|proxy`: the gateway client side. (Being implemented.) */
import type { Command } from 'commander';

export function registerGateway(program: Command): void {
  program.command('gateway').description('gateway devices, host-key pins, and the ssh proxy');
}
