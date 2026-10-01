import { randomUUID } from "node:crypto";
import type { OrganizerAdapter } from "./types";

/**
 * Tax organizer dispatch. Per BUILD_BRIEF §5, discovery must settle on ONE
 * client-facing upload surface (Dropbox file requests vs. a dedicated
 * organizer vendor) — no second client surface next to Dropbox.
 *
 * TaxCaddy is verified client-facing and is NOT the settled provider.
 *
 * Phase 1 ships WITHOUT a vendor organizer:
 *  - `UnselectedOrganizerProvider` — throws, so any code path that requires
 *    a settled vendor fails loudly instead of silently sending clients
 *    somewhere.
 *  - `ManualOrganizerProvider` — records the delivery as staff-executed and
 *    returns a delivery id, so the `SEND_ORGANIZER` outbox step can complete
 *    in Phase 1.
 */

export interface OrganizerDelivery {
  deliveryId: string;
  clientEmail: string;
  clientName: string;
  scopeVersion: number;
  /** How the organizer was actually delivered. */
  mode: "manual-staff-executed";
  recordedAt: string;
}

/** Always throws: the organizer vendor has not been selected yet. */
export class UnselectedOrganizerProvider implements OrganizerAdapter {
  sendOrganizer(_input: {
    clientEmail: string;
    clientName: string;
    scopeVersion: number;
  }): Promise<{ deliveryId: string }> {
    throw new Error(
      "Discovery required: choose one upload surface; TaxCaddy is client-facing and NOT the settled provider",
    );
  }
}

/**
 * Phase 1 provider: the organizer is delivered manually by staff (the
 * adapter only records that fact). Returns a stable delivery id for the
 * `SEND_ORGANIZER` outbox step's idempotency key.
 */
export class ManualOrganizerProvider implements OrganizerAdapter {
  private readonly deliveries: OrganizerDelivery[] = [];

  async sendOrganizer(input: {
    clientEmail: string;
    clientName: string;
    scopeVersion: number;
  }): Promise<{ deliveryId: string }> {
    const delivery: OrganizerDelivery = {
      deliveryId: `manual-${randomUUID()}`,
      clientEmail: input.clientEmail,
      clientName: input.clientName,
      scopeVersion: input.scopeVersion,
      mode: "manual-staff-executed",
      recordedAt: new Date().toISOString(),
    };
    this.deliveries.push(delivery);
    return { deliveryId: delivery.deliveryId };
  }

  /** Recorded deliveries, for assertions and for workstream b to persist. */
  getDelivered(): readonly OrganizerDelivery[] {
    return this.deliveries;
  }
}
