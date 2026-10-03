import { SignJWT, type JWTPayload } from 'jose';

export const TEST_JWT_SECRET =
  'test-secret-at-least-32-chars-long-for-hmac-sha256-signing!';

export interface SignTokenOptions {
  secret?: string;
  alg?: string;
  expiresIn?: string | number;
  subject?: string;
  issuer?: string;
  audience?: string;
}

export async function signToken(
  payload: JWTPayload,
  options: SignTokenOptions = {},
): Promise<string> {
  const secretKey = new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET);
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .setIssuedAt();

  if (options.subject) {
    jwt.setSubject(options.subject);
  } else if (
    typeof payload.sub === 'string' ||
    typeof payload.sub === 'number'
  ) {
    jwt.setSubject(String(payload.sub));
  } else if (
    typeof payload.userId === 'string' ||
    typeof payload.userId === 'number'
  ) {
    jwt.setSubject(String(payload.userId));
  }

  if (options.issuer) {
    jwt.setIssuer(options.issuer);
  }
  if (options.audience) {
    jwt.setAudience(options.audience);
  }

  if (options.expiresIn !== undefined) {
    jwt.setExpirationTime(options.expiresIn);
  } else {
    jwt.setExpirationTime('1h');
  }

  return jwt.sign(secretKey);
}

export const tokens = {
  school(
    claims: Partial<JWTPayload> = {},
    opts?: SignTokenOptions,
  ): Promise<string> {
    return signToken(
      {
        userId: 'usr-school-test',
        schoolId: 'sch-test-01',
        organizationId: 'sch-test-01',
        role: 'school_admin',
        ...claims,
      },
      opts,
    );
  },
  branch(
    claims: Partial<JWTPayload> = {},
    opts?: SignTokenOptions,
  ): Promise<string> {
    return signToken(
      {
        userId: 'usr-branch-test',
        schoolId: 'sch-test-01',
        branchId: 'br-test-01',
        organizationId: 'sch-test-01',
        role: 'branch_admin',
        ...claims,
      },
      opts,
    );
  },
  admin(
    claims: Partial<JWTPayload> = {},
    opts?: SignTokenOptions,
  ): Promise<string> {
    return signToken(
      {
        userId: 'usr-admin-test',
        role: 'superadmin',
        ...claims,
      },
      opts,
    );
  },
  expired(
    claims: Partial<JWTPayload> = {},
    opts?: SignTokenOptions,
  ): Promise<string> {
    const past = Math.floor(Date.now() / 1000) - 3600;
    return signToken(
      {
        userId: 'usr-expired-test',
        ...claims,
      },
      {
        ...opts,
        expiresIn: past,
      },
    );
  },
  noExp(
    claims: Partial<JWTPayload> = {},
    opts?: SignTokenOptions,
  ): Promise<string> {
    const secretKey = new TextEncoder().encode(opts?.secret ?? TEST_JWT_SECRET);
    const jwt = new SignJWT({
      userId: 'usr-no-exp-test',
      ...claims,
    })
      .setProtectedHeader({ alg: opts?.alg ?? 'HS256' })
      .setIssuedAt();

    if (opts?.subject) {
      jwt.setSubject(opts.subject);
    }
    return jwt.sign(secretKey);
  },
};
