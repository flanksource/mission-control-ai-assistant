import jwt from 'jsonwebtoken';

type Options = {
  teamId?: string;
  enterpriseId?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  json?: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--team' || arg === '--team-id') {
      options.teamId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--enterprise' || arg === '--enterprise-id') {
      options.enterpriseId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--iss' || arg === '--issuer') {
      options.issuer = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--aud' || arg === '--audience') {
      options.audience = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--exp' || arg === '--expires') {
      options.expiresIn = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
  }
  return options;
}

function usage(): never {
  console.error(
    [
      'Usage: bun run scripts/gen-tenant-jwt.ts --team <team-id> [--enterprise <enterprise-id>] [--iss <issuer>] [--aud <audience>] [--exp <expires>]',
      'Environment:',
      '  PROXY_JWT_SECRET  (required)',
      '  PROXY_JWT_ISSUER  (optional default issuer)',
      '  PROXY_JWT_AUDIENCE (optional default audience)',
      'Examples:',
      '  PROXY_JWT_SECRET=secret bun run scripts/gen-tenant-jwt.ts --team T0123456789',
      '  PROXY_JWT_SECRET=secret bun run scripts/gen-tenant-jwt.ts --enterprise E0123456789 --iss control-plane --aud slack-proxy --exp 30d',
    ].join('\n'),
  );
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
if (!options.teamId && !options.enterpriseId) {
  usage();
}

const secret = process.env.PROXY_JWT_SECRET;
if (!secret) {
  console.error('Missing PROXY_JWT_SECRET');
  process.exit(1);
}

const issuer = options.issuer ?? process.env.PROXY_JWT_ISSUER;
const audience = options.audience ?? process.env.PROXY_JWT_AUDIENCE;
const expiresIn = (options.expiresIn ?? '30d') as jwt.SignOptions['expiresIn'];

const payload: Record<string, unknown> = {};
if (options.teamId) {
  payload.team_id = options.teamId;
}
if (options.enterpriseId) {
  payload.enterprise_id = options.enterpriseId;
}

if (issuer) payload.iss = issuer;
if (audience) payload.aud = audience;

const token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn });

if (options.json) {
  const decoded = jwt.decode(token, { complete: true });
  console.log(JSON.stringify(decoded, null, 2));
} else {
  console.log(token);
}
