import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import {
  AlreadyClaimedError,
  FileInfectedError,
  ForbiddenError,
  NotFoundError,
  ScanUnavailableError,
  ValidationError,
} from '../core/errors/app-error.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';
import { DomainEventPublisher } from '../events/domain-event.publisher.js';
import { toManifest, type UploadManifestResponse } from '../core/manifest.js';

export interface ClaimRequestDto {
  ownerType: string;
  ownerId: string;
  kind?: string;
}

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly dbService: DatabaseService,
    private readonly configService: AppConfigService,
    private readonly outboxWriter: OutboxWriter,
    @Optional()
    private readonly domainEventPublisher?: DomainEventPublisher,
  ) {}

  /**
   * Claims a file for an owning business entity (UR-30).
   * Service principals only. Idempotent for same owner, 409 already_claimed for different owner.
   */
  async claim(
    ctx: RequestContext,
    fileId: string,
    body: ClaimRequestDto,
  ): Promise<UploadManifestResponse> {
    // 1. Service principals only (UR-30.1)
    if (ctx.actor.type !== 'service') {
      throw new ForbiddenError('Only service principals may claim files');
    }

    if (!body?.ownerType || !body?.ownerId) {
      throw new ValidationError('ownerType and ownerId are required');
    }

    const file = await this.fileRepo.findById(fileId);
    if (!file || file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // Tenant boundary: other org -> 404 (UR-30.2, UR-30.4)
    if (file.tenantId !== ctx.tenantId) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // 2. Scan status checks (UR-30.2)
    if (file.status === 'QUARANTINED' || file.scanStatus === 'INFECTED') {
      throw new FileInfectedError('File is infected and cannot be claimed');
    }

    if (file.scanStatus === 'ERROR') {
      throw new ScanUnavailableError('File virus scan resulted in error');
    }

    // Note: PENDING files CAN be claimed (UR-30.2)

    const targetKind = body.kind ?? 'attachment';
    const existingOwnerType = file.attributes?.ownerType;
    const existingOwnerId = file.attributes?.ownerId;
    const existingKind = file.attributes?.kind;

    // 3. Idempotency check (UR-30.2)
    if (file.claimed) {
      const sameOwner =
        existingOwnerType === body.ownerType &&
        existingOwnerId === body.ownerId &&
        (existingKind === targetKind || (!existingKind && !body.kind));

      if (sameOwner) {
        const replicas = await this.replicaRepo.listByFile(fileId);
        const baseUrl = this.configService.get().APP_BASE_URL;
        return toManifest(file, replicas, baseUrl, {
          message: 'File claimed successfully.',
        });
      }

      // Different owner -> 409 already_claimed
      throw new AlreadyClaimedError(
        `File '${fileId}' is already claimed by owner ${String(existingOwnerType)}:${String(existingOwnerId)}`,
      );
    }

    // 4. Update file to claimed in transaction
    const db = this.dbService.getDb();
    const updatedAttributes = {
      ...(file.attributes ?? {}),
      ownerType: body.ownerType,
      ownerId: body.ownerId,
      kind: targetKind,
    };
    const now = new Date();

    let updatedFile = file;

    if (db) {
      await db.transaction().execute(async (trx) => {
        updatedFile = await this.fileRepo.updateStatus(
          file.id,
          file.version,
          {
            claimed: true,
            claimedAt: now,
            unclaimedExpiresAt: null,
            attributes: updatedAttributes,
          },
          trx,
        );

        // 5. Outbox event file.claimed.v1 (UR-30.3)
        if (this.configService.eventsEnabled) {
          const claimEnvelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_CLAIMED,
            partitionKey: file.id,
            context: ctx,
            payload: {
              fileId: file.id,
              namespace: file.namespace,
              ownerType: body.ownerType,
              ownerId: body.ownerId,
              kind: targetKind,
            },
          });
          await this.outboxWriter.enqueue(trx, claimEnvelope);

          if (this.domainEventPublisher) {
            await this.domainEventPublisher.publish(trx, {
              eventType: 'file.claimed.v1',
              organizationId: file.tenantId,
              context: ctx,
              data: {
                fileId: file.id,
                namespace: file.namespace,
                ownerType: body.ownerType,
                ownerId: body.ownerId,
                kind: targetKind,
                claimedAt: now.toISOString(),
              },
            });
          }
        }
      });
    } else {
      updatedFile = await this.fileRepo.updateStatus(file.id, file.version, {
        claimed: true,
        claimedAt: now,
        unclaimedExpiresAt: null,
        attributes: updatedAttributes,
      });
    }

    const replicas = await this.replicaRepo.listByFile(fileId);
    const baseUrl = this.configService.get().APP_BASE_URL;
    return toManifest(updatedFile, replicas, baseUrl, {
      message: 'File claimed successfully.',
    });
  }
}
