import { db } from "./db";
import { chunkText, extractTextFromUpload } from "./files";

export type DocumentResult = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  chunkCount: number;
};

export async function createSourceDocumentFromBuffer(params: {
  botId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  buffer: Buffer;
}): Promise<DocumentResult> {
  const { botId, filename, mimeType, sizeBytes, storagePath, buffer } = params;
  let documentId = "";

  try {
    const text = await extractTextFromUpload(mimeType, buffer);
    const chunks = chunkText(text);
    const document = await db.sourceDocument.create({
      data: {
        botId,
        filename,
        storagePath,
        mimeType,
        sizeBytes,
        chunkCount: chunks.length,
        status: "PROCESSING"
      }
    });
    documentId = document.id;

    for (let index = 0; index < chunks.length; index += 1) {
      await db.documentChunk.create({
        data: {
          documentId,
          chunkIndex: index,
          content: chunks[index],
          metadata: { filename, chunkIndex: index, documentId }
        }
      });
    }

    await db.sourceDocument.update({
      where: { id: documentId },
      data: { status: "READY" }
    });

    return { id: documentId, filename, mimeType, sizeBytes, status: "READY", chunkCount: chunks.length };
  } catch (error) {
    if (documentId) {
      await db.sourceDocument.update({
        where: { id: documentId },
        data: { status: "FAILED" }
      });
    }
    throw error;
  }
}
