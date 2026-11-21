import { Router } from 'express';
import { prisma } from '../config/prisma';
import { demoOnly } from '../middleware/auth';

const router = Router();

// Stand-in WhatsApp Inbox viewer for hackathon demo
// Stand-in for the candidate's phone. Exposes download links, so it is DEMO_MODE only.
router.get('/messages', demoOnly, async (req, res, next) => {
  try {
    const phone = req.query.phone as string | undefined;
    const messages = await prisma.whatsAppMessage.findMany({
      where: phone ? { recipientPhone: phone } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        certificate: {
          select: {
            id: true,
            certificateNumber: true,
            courseName: true,
            status: true,
          },
        },
      },
    });
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

export default router;
