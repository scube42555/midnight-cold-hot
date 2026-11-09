// Stops a hot-machine script early when cold-public.json belongs to a different network than this run.
// cold-public.json is read only if it exists, from the current folder or from COLD_PUBLIC_FILE.
// This runs before anything touches the network, so a wrong MIDNIGHT_NETWORK never starts a sync.
import { existsSync, readFileSync } from 'node:fs';

export const checkColdPublicNetwork = (
  network: string,
  file: string = process.env.COLD_PUBLIC_FILE ?? 'cold-public.json',
): void => {
  if (!existsSync(file)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} exists but is not valid JSON.`);
  }
  const fileNetwork =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).network : undefined;
  if (typeof fileNetwork !== 'string') throw new Error(`${file} has no "network" field.`);

  if (fileNetwork !== network) {
    throw new Error(
      `${file} is for network "${fileNetwork}" but MIDNIGHT_NETWORK is "${network}". ` +
        `Stopping before any network traffic. Set MIDNIGHT_NETWORK=${fileNetwork}, or point COLD_PUBLIC_FILE at the right file.`,
    );
  }
};
