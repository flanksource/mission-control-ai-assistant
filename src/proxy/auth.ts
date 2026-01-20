import jwt from 'jsonwebtoken';

export type TenantClaims = {
  tenant_id: string;
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

  if (!claims.tenant_id) {
    throw new Error('JWT missing tenant_id');
  }

  return claims;
}
