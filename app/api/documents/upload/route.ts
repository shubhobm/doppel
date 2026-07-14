import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUserFromRequest } from "@/lib/request";
import { MAX_FILES, MAX_TOTAL_UPLOAD_BYTES, isUploadMimeAllowed } from "@/lib/limits";
import { saveUploadedFile } from "@/lib/files";
import { createSourceDocumentFromBuffer } from "@/lib/documents";

export async function POST(request: NextRequest) {
  if (!env.UPLOADS_ENABLED) {
    return NextResponse.json({ error: "Uploads are currently disabled." }, { status: 403 });
  }

  if (process.env.VERCEL === "1" && env.UPLOAD_BACKEND === "local") {
    return NextResponse.json(
      { error: "Upload backend is misconfigured for Vercel. Set UPLOAD_BACKEND=vercel-blob and configure BLOB_READ_WRITE_TOKEN." },
      { status: 500 }
    );
  }

  const session = await getSessionUserFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const botId = String(formData.get("botId") ?? "");
  const files = formData.getAll("files").filter((value): value is File => value instanceof File);

  if (!botId || !files.length) {
    return NextResponse.json({ error: "Select at least one file." }, { status: 400 });
  }

  const bot = await db.studentBot.findFirst({
    where: { id: botId, userId: session.user.id }
  });
  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.status === "SUBMITTED") {
    return NextResponse.json({ error: "Submitted bot cannot accept new uploads until you revert the submission." }, { status: 409 });
  }

  if (files.length + (await db.sourceDocument.count({ where: { botId } })) > MAX_FILES) {
    return NextResponse.json({ error: "File limit exceeded." }, { status: 400 });
  }

  const existingBytes = await db.sourceDocument.aggregate({
    where: { botId },
    _sum: { sizeBytes: true }
  });
  const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);
  if ((existingBytes._sum.sizeBytes ?? 0) + incomingBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Total upload limit is 100 MB." }, { status: 400 });
  }

  for (const file of files) {
    if (!isUploadMimeAllowed(file.type, file.name)) {
      return NextResponse.json({ error: `Unsupported file type: ${file.name}` }, { status: 400 });
    }
  }

  const results: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    chunkCount: number;
  }> = [];

  for (const file of files) {
    try {
      const { storagePath, buffer } = await saveUploadedFile(bot.id, file);
      const document = await createSourceDocumentFromBuffer({
        botId: bot.id,
        filename: file.name,
        mimeType: file.type || "text/plain",
        sizeBytes: file.size,
        storagePath,
        buffer
      });

      results.push(document);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Upload processing failed", {
        botId: bot.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        backend: env.UPLOAD_BACKEND,
        error: errorMessage
      });

      if (errorMessage.includes("BLOB_READ_WRITE_TOKEN")) {
        return NextResponse.json(
          { error: "Blob storage token is missing. Set BLOB_READ_WRITE_TOKEN in your deployment environment." },
          { status: 500 }
        );
      }

      return NextResponse.json({ error: "Could not process uploaded file." }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, uploaded: results.length, documents: results });
}
