/** Types for school-os-oidc-signer.mjs (used by the backend tests). */
export interface SignerConfig {
  issuer: string;
  audience: string;
  subject: string;
  kid: string;
  privateKeyFile: string;
  tokenFile: string;
  ttlSeconds: number;
}
export function keygen(dir: string, kid: string): { keyFile: string; jwksFile: string };
export function loadConfig(file: string): SignerConfig;
export function signToken(
  config: Omit<SignerConfig, 'privateKeyFile' | 'tokenFile'>,
  privateKeyPem: string,
  now?: number,
): string;
export function writeTokenFile(file: string, token: string): void;
export function signOnce(configFile: string): string;
