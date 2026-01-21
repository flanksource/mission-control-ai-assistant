export function requireEnv(names: string[]) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length === 0) {
    return;
  }

  const label = missing.length === 1 ? 'env var' : 'env vars';
  throw new Error(`Missing required ${label}: ${missing.join(', ')}`);
}
