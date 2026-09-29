import '../env';
import { getConfiguredPdpToken, loadGatewayConfig } from './config';
import { PdpClient, type PdpTokenProvider } from './pdp-client';
import { GatewayProxy } from './proxy';
import { runHttpGateway, runStdioGateway } from './server';

/**
 * Managed-identity token for the cloud control plane when AGENT_GATEWAY_PDP_AUDIENCE is set
 * (the Entra API app id / `api://…` URI). Tokens are cached until 2 minutes before expiry.
 */
function managedIdentityProvider(): PdpTokenProvider | undefined {
  const audience = process.env.AGENT_GATEWAY_PDP_AUDIENCE;
  if (!audience) return undefined;
  const scope = `${audience.replace(/\/+$/, '')}/.default`;
  let cached: { token: string; expires: number } | undefined;
  let credential: import('@azure/identity').TokenCredential | undefined;
  return async () => {
    if (cached && cached.expires - Date.now() > 120_000) return cached.token;
    if (!credential) {
      const { DefaultAzureCredential } = await import('@azure/identity');
      credential = new DefaultAzureCredential();
    }
    const t = await credential.getToken(scope);
    if (!t) return undefined;
    cached = { token: t.token, expires: t.expiresOnTimestamp };
    return t.token;
  };
}

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const pdp = new PdpClient(config, managedIdentityProvider() ?? getConfiguredPdpToken(config));
  const proxy = new GatewayProxy(config, pdp);

  if (process.argv.includes('--stdio')) {
    await runStdioGateway(proxy);
    return;
  }

  const server = await runHttpGateway(proxy, config);
  const address = server.address();
  const bind = typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address);
  console.log(`Governance MCP gateway listening on http://${bind}/mcp`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
