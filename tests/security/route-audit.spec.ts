import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator.js';
import { AuthGuard } from '../../src/auth/guards/auth.guard.js';
import { FilesController } from '../../src/files/files.controller.js';
import { AuditController } from '../../src/observability/audit.controller.js';
import { QuotaController } from '../../src/admin/quota.controller.js';
import { DlqController } from '../../src/admin/dlq.controller.js';
import { MetricsController } from '../../src/observability/metrics.controller.js';
import { HealthController } from '../../src/observability/health.controller.js';

interface RouteAuditEntry {
  controllerName: string;
  methodName: string;
  httpMethod: string;
  path: string;
  isPublic: boolean;
  hasAuthGuard: boolean;
}

describe('Automated Route Security Audit (P6-09 / F-41 Mechanical Prevention)', () => {
  const reflector = new Reflector();

  const CONTROLLERS: Type<unknown>[] = [
    FilesController,
    AuditController,
    QuotaController,
    DlqController,
    MetricsController,
    HealthController,
  ];

  function auditControllerRoutes(
    controllerClass: Type<unknown>,
  ): RouteAuditEntry[] {
    const controllerName = controllerClass.name;
    const classGuards =
      (Reflect.getMetadata('__guards__', controllerClass) as unknown[]) || [];
    const classIsPublic =
      reflector.get<boolean>(IS_PUBLIC_KEY, controllerClass) || false;
    const classHasAuthGuard = classGuards.some(
      (g) =>
        g === AuthGuard || (typeof g === 'function' && g.name === 'AuthGuard'),
    );

    const prototype = controllerClass.prototype as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (m) => m !== 'constructor' && typeof prototype[m] === 'function',
    );

    const routes: RouteAuditEntry[] = [];

    for (const methodName of methodNames) {
      const method = prototype[methodName] as object;
      const methodGuards =
        (Reflect.getMetadata('__guards__', method) as unknown[]) || [];
      const methodIsPublic =
        reflector.get<boolean>(IS_PUBLIC_KEY, method) || false;
      const isPublic = classIsPublic || methodIsPublic;

      const methodHasAuthGuard = methodGuards.some(
        (g) =>
          g === AuthGuard ||
          (typeof g === 'function' && g.name === 'AuthGuard'),
      );
      const hasAuthGuard = classHasAuthGuard || methodHasAuthGuard;

      const path =
        (Reflect.getMetadata('path', method) as string | undefined) || '';
      const rawMethod = Reflect.getMetadata('method', method) as
        number | string | undefined;
      const httpMethod =
        rawMethod !== undefined ? String(rawMethod) : 'UNKNOWN';

      routes.push({
        controllerName,
        methodName,
        httpMethod,
        path,
        isPublic,
        hasAuthGuard,
      });
    }

    return routes;
  }

  it('verifies that 100% of routes are either protected by AuthGuard or explicitly marked @Public()', () => {
    const allRoutes: RouteAuditEntry[] = [];
    const unprotectedRoutes: RouteAuditEntry[] = [];

    for (const controller of CONTROLLERS) {
      const audited = auditControllerRoutes(controller);
      allRoutes.push(...audited);

      for (const route of audited) {
        // A route fails the audit if it is NOT @Public() and DOES NOT have AuthGuard
        if (!route.isPublic && !route.hasAuthGuard) {
          unprotectedRoutes.push(route);
        }
      }
    }

    expect(allRoutes.length).toBeGreaterThan(10);

    // Mechanically proves F-41 is impossible: zero unauthenticated routes without @Public()
    if (unprotectedRoutes.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Unprotected routes found:', unprotectedRoutes);
    }
    expect(unprotectedRoutes).toEqual([]);
  });

  it('confirms that sensitive admin endpoints are never @Public()', () => {
    const adminControllers: Type<unknown>[] = [
      AuditController,
      QuotaController,
      DlqController,
    ];

    for (const controller of adminControllers) {
      const routes = auditControllerRoutes(controller);
      for (const route of routes) {
        expect(route.isPublic).toBe(false);
        expect(route.hasAuthGuard).toBe(true);
      }
    }
  });

  it('confirms that write/upload endpoints in FilesController require AuthGuard', () => {
    const routes = auditControllerRoutes(FilesController);
    const uploadRoute = routes.find((r) => r.methodName === 'upload');
    const deleteRoute = routes.find((r) => r.methodName === 'deleteFile');
    const bulkDeleteRoute = routes.find((r) => r.methodName === 'bulkDelete');

    expect(uploadRoute).toBeDefined();
    expect(uploadRoute?.isPublic).toBe(false);
    expect(uploadRoute?.hasAuthGuard).toBe(true);

    expect(deleteRoute).toBeDefined();
    expect(deleteRoute?.isPublic).toBe(false);
    expect(deleteRoute?.hasAuthGuard).toBe(true);

    expect(bulkDeleteRoute).toBeDefined();
    expect(bulkDeleteRoute?.isPublic).toBe(false);
    expect(bulkDeleteRoute?.hasAuthGuard).toBe(true);
  });
});
