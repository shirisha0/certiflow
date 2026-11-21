import { Router } from 'express';
import { prisma } from '../config/prisma';
import { demoOnly, requireAuth, signUserToken } from '../middleware/auth';

const router = Router();

router.get('/personas', demoOnly, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        district: true,
        centreName: true,
      },
    });
    res.json({ personas: users });
  } catch (err) {
    next(err);
  }
});

router.post('/switch', demoOnly, async (req, res, next) => {
  try {
    const { userId } = req.body as { userId?: string };
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        district: true,
        centreName: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    const token = signUserToken(user);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
