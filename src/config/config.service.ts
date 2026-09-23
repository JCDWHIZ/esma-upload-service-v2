import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  readonly port: number = parseInt(process.env.PORT ?? '7030', 10);
  readonly nodeEnv: string = (
    process.env.NODE_ENV ?? 'development'
  ).toLowerCase();
  readonly trustProxy: string = process.env.TRUST_PROXY ?? 'loopback';
  readonly identityJwksUri: string =
    process.env.IDENTITY_JWKS_URI ??
    'https://api.esma.elsoft.ng/identity/oauth2/jwks';
  readonly identityIssuer: string =
    process.env.IDENTITY_ISSUER ?? 'http://esma-identity-service:7071/identity';
  readonly swaggerEnabled: boolean = process.env.SWAGGER_ENABLED === 'true';

  isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
