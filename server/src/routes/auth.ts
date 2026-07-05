import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const { email, password } = parsed.data;

    let user = await prisma.appUser.findUnique({ where: { email } });

    // For single-user local deployment, auto-create user (or set password) on first login
    if ((!user || !user.passwordHash) && email === "local@localhost.com") {
      const passwordHash = await bcrypt.hash(password, 10);
      if (user) {
        user = await prisma.appUser.update({
          where: { id: user.id },
          data: { passwordHash }
        });
      } else {
        user = await prisma.appUser.create({
          data: {
            email,
            passwordHash
          }
        });
      }
    }

    if (!user || !user.passwordHash) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: "7d" }
    );
    return { token, user: { id: user.id, email: user.email } };
  });

  app.get("/auth/me", { preValidation: [app.authenticate] }, async (request) => {
    return { user: request.user };
  });

  app.post("/auth/refresh", { preValidation: [app.authenticate] }, async (request) => {
    const user = request.user as { id: string; email: string };
    const token = app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: "7d" }
    );
    return { token };
  });
}
