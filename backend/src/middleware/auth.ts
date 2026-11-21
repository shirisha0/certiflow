import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/prisma';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  district: string | null;
  centreName: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signUserToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      district: user.district,
    },
    env.jwtSecret,
    { expiresIn: '12h' }
  );
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    // Tokens in URLs leak into logs/history, so ?token= is accepted ONLY for the SSE stream
    // (the browser's EventSource cannot set an Authorization header).
    const queryToken =
      req.baseUrl === '/api/events' && typeof req.query.token === 'string'
        ? req.query.token
        : undefined;
    const token =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, env.jwtSecret) as { sub: string; role: UserRole };
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
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
      return res.status(401).json({ error: 'Invalid user session' });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: role ${req.user.role} cannot perform this action`,
      });
    }
    next();
  };
}

/** Routes that only exist for demos (persona switch, stand-in WhatsApp inbox). */
export function demoOnly(_req: Request, res: Response, next: NextFunction) {
  if (!env.demoMode) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}
