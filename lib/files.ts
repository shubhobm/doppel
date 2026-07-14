import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { del, put } from "@vercel/blob";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { env } from "./env";

export async function ensureUploadDir(botId: string) {
  const dir = path.join(env.UPLOAD_DIR, botId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function resolveBlobAccess(): "public" | "private" {
  return process.env.BLOB_ACCESS?.toLowerCase() === "public" ? "public" : "private";
}

export async function saveUploadedFile(botId: string, file: File) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  let storagePath = "";
  if (env.UPLOAD_BACKEND === "vercel-blob") {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error("BLOB_READ_WRITE_TOKEN is required when UPLOAD_BACKEND=vercel-blob");
    }

    const blobPath = `uploads/${botId}/${fileName}`;
    const blob = await put(blobPath, buffer, {
      access: resolveBlobAccess(),
      addRandomSuffix: false,
      contentType: file.type || "application/octet-stream",
      token
    });
    storagePath = blob.url;
  } else {
    const dir = await ensureUploadDir(botId);
    storagePath = path.join(dir, fileName);
    await fs.writeFile(storagePath, buffer);
  }

  return { storagePath, buffer, fileName };
}

export async function deleteStoredFile(storagePath: string) {
  if (!storagePath) {
    return;
  }

  if (env.UPLOAD_BACKEND === "vercel-blob") {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error("BLOB_READ_WRITE_TOKEN is required when UPLOAD_BACKEND=vercel-blob");
    }

    await del(storagePath, { token });
    return;
  }

  await fs.unlink(storagePath);
}

function cleanText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractTextFromUpload(mimeType: string, buffer: Buffer) {
  if (mimeType === "application/pdf") {
    const result = await pdfParse(buffer);
    return cleanText(result.text);
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value);
  }

  return cleanText(buffer.toString("utf8"));
}

export function chunkText(text: string, targetSize = 1200, overlap = 180) {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length <= targetSize) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (paragraph.length <= targetSize) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      const part = paragraph.slice(start, start + targetSize);
      chunks.push(part);
      start += targetSize - overlap;
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}
