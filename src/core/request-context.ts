export type ActorType = 'user' | 'service';

export interface RequestContext {
  namespace: string;
  tenantId: string;
  subTenantId?: string;
  actor: {
    id: string;
    type: ActorType;
    roles: string[];
    scopes: string[];
    isPlatformAdmin?: boolean;
  };
  correlationId: string;
  ipAddress: string;
  userAgent?: string;
  attributes: Readonly<Record<string, string>>;
}
