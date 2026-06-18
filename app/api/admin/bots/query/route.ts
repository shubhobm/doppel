import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUserFromRequest } from "@/lib/request";
import { generateBotAnswer } from "@/lib/bot";

const bodySchema = z.object({
  botId: z.string().min(1),
  question: z.string().min(1).max(4000),
  sessionKey: z.string().min(1).optional()
});

export async function POST(request: NextRequest) {
  const session = await getSessionUserFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid admin query." }, { status: 400 });
  }

  const bot = await db.studentBot.findUnique({
    where: { id: parsed.data.botId },
    include: {
      user: {
        select: {
          id: true,
          email: true
        }
      }
    }
  });

  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  const result = await generateBotAnswer({
    botId: bot.id,
    sessionKey: parsed.data.sessionKey ?? `admin-${session.user.id}`,
    question: parsed.data.question
  });

  // fire-and-forget — admin doesn't need to wait for the log write
  db.queryLog.create({
    data: {
      botId: bot.id,
      userId: bot.userId,
      actorRole: "ADMIN",
      question: parsed.data.question,
      answer: result.answer,
      configVersion: bot.configVersion
    }
  }).catch((err: unknown) => console.error("queryLog write failed", err));

  return NextResponse.json({
    userId: bot.userId,
    username: bot.user.email,
    botId: bot.id,
    botStatus: bot.status,
    question: parsed.data.question,
    answer: result.answer,
    trace: result.trace,
    retrievedChunks: result.chunks.map((chunk) => ({
      filename: chunk.source.filename,
      chunkIndex: chunk.source.chunkIndex
    })),
    configVersion: bot.configVersion,
    timestamp: new Date().toISOString()
  });
}