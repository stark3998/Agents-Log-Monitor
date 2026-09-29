import { Router } from 'express';
import { issueDeviceToken, requireRole } from '../auth';
import type { Role } from '../types';

const router = Router();

const DEVICE_ROLES: Role[] = ['Agent', 'Viewer'];

router.post('/enroll', requireRole('PolicyAdmin'), async (req, res) => {
  try {
    const body = (req.body ?? {}) as { deviceId?: string; roles?: Role[]; ttlDays?: number };
    const deviceId = String(body.deviceId || `device-${Date.now()}`);
    // Local enforcers need Agent (PDP, sync push) and Viewer (lane/agent pull); never admin roles.
    const requested = Array.isArray(body.roles) ? body.roles.filter(r => DEVICE_ROLES.includes(r)) : [];
    const roles: Role[] = requested.length ? [...new Set(requested)] : DEVICE_ROLES;
    const ttlDays = Number.isFinite(body.ttlDays) ? Number(body.ttlDays) : 30;
    res.json(await issueDeviceToken(deviceId, roles, ttlDays));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router };
export default router;
