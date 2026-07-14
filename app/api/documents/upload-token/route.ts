import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUserFromRequest } from "@/lib/request";
import { MAX_FILES, MAX_TOTAL_UPLOAD_BYTES, isUploadMimeAllowed } from "@/lib/limits";

export async function POST(request: NextRequest) {
  if (!env.UPLOADS_ENABLED) {
    return NextResponse.json({ error: "Uploads are currently disabled." }, { status: 403 });
  }

  if (env.UPLOAD_BACKEND !== "vercel-blob") {
    return NextResponse.json({ error: "Direct upload is only available with the vercel-blob backend." }, { status: 400 });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Blob storage token is missing. Set BLOB_READ_WRITE_TOKEN in your deployment environment." },
      { status: 500 }
    );
  }

  const session = await getSessionUserFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      token,
      onBeforeGenerateToken: async (pathname, clientPayloadRaw) => {
        const clientPayload = clientPayloadRaw ? JSON.parse(clientPayloadRaw) : {};
        const botId = String(clientPayload.botId ?? "");
        const declaredSize = Number(clientPayload.size ?? 0);
        const declaredMimeType = String(clientPayload.mimeType ?? "");

        if (!botId || !pathname.startsWith(`uploads/${botId}/`)) {
          throw new Error("Invalid upload target.");
        }

        const bot = await db.studentBot.findFirst({ where: { id: botId, userId: session.user.id } });
        if (!bot) {
          throw new Error("Bot not found.");
        }
        if (bot.status === "SUBMITTED") {
          throw new Error("Submitted bot cannot accept new uploads until you revert the submission.");
        }

        const filename = pathname.split("/").pop() ?? pathname;
        if (!isUploadMimeAllowed(declaredMimeType, filename)) {
          throw new Error(`Unsupported file type: ${filename}`);
        }

        const existingCount = await db.sourceDocument.count({ where: { botId } });
        if (existingCount + 1 > MAX_FILES) {
          throw new Error("File limit exceeded.");
        }

        const existingBytes = await db.sourceDocument.aggregate({
          where: { botId },
          _sum: { sizeBytes: true }
        });
        if ((existingBytes._sum.sizeBytes ?? 0) + declaredSize > MAX_TOTAL_UPLOAD_BYTES) {
          throw new Error("Total upload limit is 100 MB.");
        }

        return {
          allowedContentTypes: ["*/*"],
          addRandomSuffix: false,
          maximumSizeInBytes: MAX_TOTAL_UPLOAD_BYTES,
          tokenPayload: JSON.stringify({ botId, userId: session.user.id })
        };
      }
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not authorize upload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
