import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSessionFromCookies } from "@/lib/auth";
import { StudentWorkspace } from "@/components/StudentWorkspace";
import { ensureDemoBotForUser } from "@/lib/demoBot";
import { env } from "@/lib/env";
import { resolveBlobAccess } from "@/lib/files";

type WorkspacePageProps = {
  searchParams?: Promise<{ bot?: string; owner?: string }>;
};

export default async function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const session = await readSessionFromCookies();
  if (!session) {
    redirect("/login");
  }

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    redirect("/login");
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const ownerId = resolvedSearchParams.owner;
  const isAdminViewingOtherUser = Boolean(ownerId && ownerId !== user.id);

  if (isAdminViewingOtherUser && user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const targetUserId = isAdminViewingOtherUser ? ownerId! : user.id;

  let bots = await db.studentBot.findMany({
    where: { userId: targetUserId },
    orderBy: { createdAt: "asc" },
    include: {
      documents: {
        orderBy: { createdAt: "desc" }
      }
    }
  });

  if (!bots.length && targetUserId === user.id) {
    const created = await ensureDemoBotForUser(user.id);
    bots = [created];
  }

  if (!bots.length) {
    redirect("/dashboard");
  }

  if (!resolvedSearchParams.bot) {
    const params = new URLSearchParams();
    params.set("bot", bots[0].id);
    if (isAdminViewingOtherUser && ownerId) {
      params.set("owner", ownerId);
    }
    redirect(`/workspace?${params.toString()}`);
  }

  const activeBot = bots.find((candidate) => candidate.id === resolvedSearchParams.bot);
  if (!activeBot) {
    redirect("/dashboard");
  }

  const totalBytes = activeBot.documents.reduce((sum, doc) => sum + doc.sizeBytes, 0);

  return (
    <main className="shell stack">
      <div className="row">
        <a className="text-link" href="/dashboard">Back to dashboard</a>
      </div>
      <StudentWorkspace
        bots={bots.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          isDemo: candidate.isDemo || candidate.name === "Seeded Demo Chatbot" || candidate.name === "Demo Chatbot",
          status: candidate.status,
          systemPrompt: candidate.systemPrompt,
          temperature: candidate.temperature,
          topP: candidate.topP,
          topK: candidate.topK,
          maxOutputTokens: candidate.maxOutputTokens,
          configVersion: candidate.configVersion,
          submittedAt: candidate.submittedAt?.toISOString() ?? null,
          documents: candidate.documents.map((document) => ({
            id: document.id,
            filename: document.filename,
            mimeType: document.mimeType,
            sizeBytes: document.sizeBytes,
            status: document.status,
            chunkCount: document.chunkCount
          }))
        }))}
        activeBotId={activeBot.id}
        uploadsEnabled={env.UPLOADS_ENABLED}
        uploadBackend={env.UPLOAD_BACKEND}
        blobAccess={resolveBlobAccess()}
        totalBytes={totalBytes}
        readOnly={isAdminViewingOtherUser}
        useAdminQueryEndpoint={isAdminViewingOtherUser}
      />
    </main>
  );
}
