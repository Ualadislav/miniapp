import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const telegramUserSchema = z.object({
  id: z.number().int().positive().safe(),
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional()
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error("BOT_TOKEN is required to verify Telegram Mini App initData");
}

const maxAgeSeconds = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS ?? 86400);
if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60) {
  throw new Error("TELEGRAM_INIT_DATA_MAX_AGE_SECONDS must be an integer of at least 60");
}

export function authenticateTelegramRequest(request: FastifyRequest): TelegramUser {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("tma ")) {
    throw Object.assign(new Error("Telegram authorization is required"), { statusCode: 401 });
  }

  const initData = authorization.slice(4);
  if (!initData || initData.length > 16_384) {
    throw Object.assign(new Error("Invalid Telegram initData"), { statusCode: 401 });
  }

  const params = new URLSearchParams(initData);
  const entries = Array.from(params.entries());
  if (entries.length === 0 || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw Object.assign(new Error("Invalid Telegram initData"), { statusCode: 401 });
  }

  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw Object.assign(new Error("Invalid Telegram initData signature"), { statusCode: 401 });
  }

  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, "hex");
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw Object.assign(new Error("Invalid Telegram initData signature"), { statusCode: 401 });
  }

  const authDateValue = params.get("auth_date");
  const authDate = authDateValue ? Number(authDateValue) : NaN;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > maxAgeSeconds) {
    throw Object.assign(new Error("Telegram initData has expired"), { statusCode: 401 });
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw Object.assign(new Error("Telegram user is missing"), { statusCode: 401 });
  }
  const parsedUser = telegramUserSchema.safeParse(JSON.parse(rawUser));
  if (!parsedUser.success) {
    throw Object.assign(new Error("Invalid Telegram user data"), { statusCode: 401 });
  }

  return parsedUser.data;
}
