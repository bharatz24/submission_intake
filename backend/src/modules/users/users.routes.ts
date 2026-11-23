import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../../deps.js';
import { can, currentUser, parseBody, requirePermission, ROLES, uuidParam } from '../../http.js';
import { PasswordSchema } from '../../services/passwordPolicy.js';
import { createUsersService } from './users.service.js';

const AccessBody = z
  .object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional() })
  .refine((b) => b.role !== undefined || b.disabled !== undefined, 'Nothing to change');
const PasswordBody = z.object({ password: PasswordSchema });

/** GET/PATCH /users and an admin's password reset. Mounted behind requireAuth (app.ts). */
export function usersRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createUsersService(deps);

  /** Admins get every account with its state; everyone else only who work can be assigned to. */
  router.get('/users', async (req, res) => {
    res.json(can(req, 'user:manage') ? await service.listManaged() : await service.listAssignable());
  });

  router.patch('/users/:id', requirePermission('user:manage'), async (req, res) => {
    const id = uuidParam(req.params.id, 'User');
    res.json(await service.changeAccess(id, parseBody(AccessBody, req.body), currentUser(req).id));
  });

  router.post('/users/:id/password', requirePermission('user:manage'), async (req, res) => {
    const id = uuidParam(req.params.id, 'User');
    const { password } = parseBody(PasswordBody, req.body);
    res.json(await service.resetPassword(id, password, currentUser(req).id));
  });

  return router;
}
