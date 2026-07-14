import { NextRequest, NextResponse } from "next/server";
import { del, head } from "@vercel/blob";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUserFromRequest } from "@/lib/request";
import { MAX_FILES, MAX_TOTAL_UPLOAD_BYTES, isUploadMimeAllowed } from "@/lib/limits";
import { createSourceDocumentFromBuffer } from "@/lib/documents";

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

  const payload = await request.json().catch(() => null);
  const botId = String(payload?.botId ?? "");
  const url = String(payload?.url ?? "");
  if (!botId || !url) {
    return NextResponse.json({ error: "Missing upload reference." }, { status: 400 });
  }

  const bot = await db.studentBot.findFirst({ where: { id: botId, userId: session.user.id } });
  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }
  if (bot.status === "SUBMITTED") {
    return NextResponse.json({ error: "Submitted bot cannot accept new uploads until you revert the submission." }, { status: 409 });
  }

  let meta: Awaited<ReturnType<typeof head>>;
  try {
    meta = await head(url, { token });
  } catch {
    return NextResponse.json({ error: "Uploaded file could not be located." }, { status: 400 });
  }

  if (!meta.pathname.startsWith(`uploads/${botId}/`)) {
    await del(url, { token }).catch(() => {});
    return NextResponse.json({ error: "Invalid upload target." }, { status: 400 });
  }

  const filename = meta.pathname.split("/").pop() ?? meta.pathname;
  const mimeType = meta.contentType || "application/octet-stream";
  const sizeBytes = meta.size;

  if (!isUploadMimeAllowed(mimeType, filename)) {
    await del(url, { token }).catch(() => {});
    return NextResponse.json({ error: `Unsupported file type: ${filename}` }, { status: 400 });
  }

  const existingCount = await db.sourceDocument.count({ where: { botId } });
  if (existingCount + 1 > MAX_FILES) {
    await del(url, { token }).catch(() => {});
    return NextResponse.json({ error: "File limit exceeded." }, { status: 400 });
  }

  const existingBytes = await db.sourceDocument.aggregate({
    where: { botId },
    _sum: { sizeBytes: true }
  });
  if ((existingBytes._sum.sizeBytes ?? 0) + sizeBytes > MAX_TOTAL_UPLOAD_BYTES) {
    await del(url, { token }).catch(() => {});
    return NextResponse.json({ error: "Total upload limit is 100 MB." }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Blob download failed with status ${response.status}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("Upload download failed", { botId, filename, error: error instanceof Error ? error.message : String(error) });
    await del(url, { token }).catch(() => {});
    return NextResponse.json({ error: "Could not download uploaded file." }, { status: 500 });
  }

  try {
    const document = await createSourceDocumentFromBuffer({
      botId,
      filename,
      mimeType,
      sizeBytes,
      storagePath: url,
      buffer
    });

    return NextResponse.json({ ok: true, uploaded: 1, documents: [document] });
  } catch (error) {
    console.error("Upload processing failed", {
      botId,
      filename,
      mimeType,
      sizeBytes,
      error: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({ error: "Could not process uploaded file." }, { status: 500 });
  }
}
