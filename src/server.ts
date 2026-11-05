import "dotenv/config";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { database } from "./database.js";
import { authenticateTelegramRequest, type TelegramUser } from "./telegram-auth.js";

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const habitInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().min(1).max(16).default("⭐"),
  reminder: z.string().regex(timePattern).or(z.literal("")).default("")
});
const habitUpdateSchema = habitInputSchema.partial();
const completionDateSchema = z.string().regex(datePattern).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Invalid date");
const importSchema = z.object({
  habits: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    icon: z.string().min(1).max(16).optional(),
    reminder: z.string().regex(timePattern).or(z.literal("")).optional(),
    createdAt: completionDateSchema,
    completed: z.array(completionDateSchema).max(3660)
  })).max(100)
});

interface HabitRow {
  id: string;
  name: string;
  icon: string;
  reminder: string;
  created_at: string;
}

interface AuthenticatedRequest extends FastifyRequest {
  telegramUser?: TelegramUser;
}

function sendError(reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).send({ error: message });
}

function parseOrReply<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendError(reply, 400, "Invalid request data");
    return null;
  }
  return parsed.data;
}

function saveTelegramUser(user: TelegramUser) {
  database.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name
  `).run(String(user.id), user.username ?? null, user.first_name, user.last_name ?? null);
}

function listHabits(userId: string) {
  const rows = database.prepare(`
    SELECT id, name, icon, reminder, created_at
    FROM habits
    WHERE user_id = ?
    ORDER BY created_at, rowid
  `).all(userId) as HabitRow[];
  const completions = database.prepare(`
    SELECT c.habit_id, c.completed_date
    FROM completions c
    JOIN habits h ON h.id = c.habit_id
    WHERE h.user_id = ?
    ORDER BY c.completed_date
  `).all(userId) as { habit_id: string; completed_date: string }[];
  const completedByHabit = new Map<string, string[]>();
  for (const completion of completions) {
    const dates = completedByHabit.get(completion.habit_id) ?? [];
    dates.push(completion.completed_date);
    completedByHabit.set(completion.habit_id, dates);
  }
  return rows.map((habit) => ({
    id: habit.id,
    name: habit.name,
    icon: habit.icon,
    reminder: habit.reminder,
    createdAt: habit.created_at,
    completed: completedByHabit.get(habit.id) ?? []
  }));
}

function requireHabit(userId: string, habitId: string, reply: FastifyReply): boolean {
  const habit = database.prepare("SELECT 1 FROM habits WHERE id = ? AND user_id = ?").get(habitId, userId);
  if (!habit) {
    sendError(reply, 404, "Habit not found");
    return false;
  }
  return true;
}

app.get("/health", async (_request, reply) => {
  database.prepare("SELECT 1").get();
  return reply.send({ status: "ok" });
});

app.get("/", async (_request, reply) => {
  const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
  return reply.type("text/html; charset=utf-8").send(await readFile(htmlPath));
});

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  try {
    const user = authenticateTelegramRequest(request);
    saveTelegramUser(user);
    (request as AuthenticatedRequest).telegramUser = user;
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : 401;
    request.log.warn({ err: error }, "Telegram authentication failed");
    return sendError(reply, statusCode, error instanceof Error ? error.message : "Unauthorized");
  }
});

app.post("/api/auth/telegram", async (request) => {
  const user = (request as AuthenticatedRequest).telegramUser!;
  return { user: { id: String(user.id), firstName: user.first_name, username: user.username ?? null } };
});

app.get("/api/habits", async (request) => {
  const user = (request as AuthenticatedRequest).telegramUser!;
  return listHabits(String(user.id));
});

app.post("/api/habits", async (request, reply) => {
  const input = parseOrReply(habitInputSchema, request.body, reply);
  if (!input) return;
  const user = (request as AuthenticatedRequest).telegramUser!;
  const id = randomUUID();
  const createdAt = new Date().toISOString().slice(0, 10);
  database.prepare(`
    INSERT INTO habits (id, user_id, name, icon, reminder, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(user.id), input.name, input.icon, input.reminder, createdAt);
  return reply.code(201).send({ id, ...input, createdAt, completed: [] });
});

app.post("/api/habits/import", async (request, reply) => {
  const input = parseOrReply(importSchema, request.body, reply);
  if (!input) return;
  const user = (request as AuthenticatedRequest).telegramUser!;
  const userId = String(user.id);
  const importHabits = database.transaction(() => {
    const existing = database.prepare("SELECT COUNT(*) AS count FROM habits WHERE user_id = ?").get(userId) as { count: number };
    if (existing.count > 0) return;
    const insertHabit = database.prepare(`
      INSERT INTO habits (id, user_id, name, icon, reminder, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertCompletion = database.prepare(`
      INSERT OR IGNORE INTO completions (habit_id, completed_date) VALUES (?, ?)
    `);
    for (const habit of input.habits) {
      const id = randomUUID();
      insertHabit.run(id, userId, habit.name, habit.icon ?? "⭐", habit.reminder ?? "", habit.createdAt);
      for (const date of new Set(habit.completed)) insertCompletion.run(id, date);
    }
  });
  importHabits();
  return reply.send(listHabits(userId));
});

app.patch<{ Params: { id: string } }>("/api/habits/:id", async (request, reply) => {
  const input = parseOrReply(habitUpdateSchema, request.body, reply);
  if (!input) return;
  const user = (request as AuthenticatedRequest).telegramUser!;
  const userId = String(user.id);
  if (!requireHabit(userId, request.params.id, reply)) return;
  const fields = Object.keys(input) as (keyof typeof input)[];
  if (fields.length > 0) {
    const values: string[] = [];
    const assignments = fields.flatMap((field) => {
      const value = input[field];
      if (value === undefined) return [];
      values.push(value);
      return [`${field} = ?`];
    });
    if (assignments.length > 0) {
      database.prepare(`UPDATE habits SET ${assignments.join(", ")} WHERE id = ? AND user_id = ?`)
        .run(...values, request.params.id, userId);
    }
  }
  return reply.send(listHabits(userId).find((habit) => habit.id === request.params.id));
});

app.delete<{ Params: { id: string } }>("/api/habits/:id", async (request, reply) => {
  const user = (request as AuthenticatedRequest).telegramUser!;
  const userId = String(user.id);
  if (!requireHabit(userId, request.params.id, reply)) return;
  database.prepare("DELETE FROM habits WHERE id = ? AND user_id = ?").run(request.params.id, userId);
  return reply.code(204).send();
});

app.put<{ Params: { id: string; date: string } }>("/api/habits/:id/completions/:date", async (request, reply) => {
  const date = parseOrReply(completionDateSchema, request.params.date, reply);
  if (!date) return;
  const user = (request as AuthenticatedRequest).telegramUser!;
  const userId = String(user.id);
  if (!requireHabit(userId, request.params.id, reply)) return;
  database.prepare("INSERT OR IGNORE INTO completions (habit_id, completed_date) VALUES (?, ?)")
    .run(request.params.id, date);
  return reply.code(204).send();
});

app.delete<{ Params: { id: string; date: string } }>("/api/habits/:id/completions/:date", async (request, reply) => {
  const date = parseOrReply(completionDateSchema, request.params.date, reply);
  if (!date) return;
  const user = (request as AuthenticatedRequest).telegramUser!;
  const userId = String(user.id);
  if (!requireHabit(userId, request.params.id, reply)) return;
  database.prepare("DELETE FROM completions WHERE habit_id = ? AND completed_date = ?")
    .run(request.params.id, date);
  return reply.code(204).send();
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "Request failed");
  return reply.code(500).send({ error: "Internal server error" });
});

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  app.log.error(error);
  database.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    database.close();
  });
}
