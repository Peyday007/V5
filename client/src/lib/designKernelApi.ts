/**
 * The design kernel (§42), over HTTP.
 *
 * Thin by design, like `registerApi` and `laborApi`'s calling pattern: the one
 * GET call this file exposes returns exactly `designKernelView()`'s own type,
 * imported rather than restated, so nothing here can drift from what the
 * server actually composes. No write of any kind lives in this module,
 * because the kernel's operator surface is read-only.
 */
import { api } from './api.ts';
import type { CapabilityView, DesignKernelView, ExpansionView } from '../../../server/services/design/view.ts';
import type { RuntimeAvailability, SurfaceRanking } from '../../../server/services/design/priority.ts';
import type {
  DesignCorrection,
  DesignCycle,
  DesignFinding,
  DesignPattern,
} from '../../../server/domain/design.ts';

export type {
  CapabilityView,
  DesignCorrection,
  DesignCycle,
  DesignFinding,
  DesignKernelView,
  DesignPattern,
  ExpansionView,
  RuntimeAvailability,
  SurfaceRanking,
};

export const DesignKernelApi = {
  /** The kernel's whole current state, in one read. Nothing in it is derived in the client. */
  kernel: (): Promise<DesignKernelView> => api('/api/design/kernel'),
};
