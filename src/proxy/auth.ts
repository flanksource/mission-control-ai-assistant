import jwt from 'jsonwebtoken';

export type TenantClaims = {
  team_id?: string;
  enterprise_id?: string;
  iss?: string;
  aud?: string;
};

export function verifyTenantJwt(token: string, secret: string): TenantClaims {
  const issuer = process.env.PROXY_JWT_ISSUER;
  const audience = process.env.PROXY_JWT_AUDIENCE;

  const claims = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  }) as jwt.JwtPayload & TenantClaims;

  if (!claims.team_id && !claims.enterprise_id) {
    throw new Error('JWT missing team_id or enterprise_id');
  }

  return claims;
}
