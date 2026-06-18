"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";

type DocumentRecord = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  chunkCount: number;
};

type BotRecord = {
  id: string;
  name: string;
  isDemo: boolean;
  status: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number;
  configVersion: number;
  submittedAt: string | null;
  documents: DocumentRecord[];
};

type Props = {
  bots: BotRecord[];
  activeBotId: string;
  totalBytes: number;
  uploadsEnabled: boolean;
  readOnly?: boolean;
  useAdminQueryEndpoint?: boolean;
};

type ChatEntry = {
  role: "user" | "assistant";
  content: string;
};

export function StudentWorkspace({
  bots,
  activeBotId,
  totalBytes,
  uploadsEnabled,
  readOnly = false,
  useAdminQueryEndpoint = false
}: Props) {
  const router = useRouter();
  const [allBots, setAllBots] = useState(bots);
  const [currentBotId, setCurrentBotId] = useState(activeBotId);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [botName, setBotName] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [topP, setTopP] = useState("1");
  const [topK, setTopK] = useState("20");
  const [maxOutputTokens, setMaxOutputTokens] = useState("512");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [chatLoading, setChatLoading] = useState(false);
  const [sessionKey, setSessionKey] = useState("preview");

  const currentBot = useMemo(
    () => allBots.find((bot) => bot.id === currentBotId) ?? allBots[0],
    [allBots, currentBotId]
  );

  const documents = currentBot?.documents ?? [];

  useEffect(() => {
    setAllBots(bots);
  }, [bots]);

  useEffect(() => {
    setCurrentBotId(activeBotId);
  }, [activeBotId]);

  useEffect(() => {
    const stored = window.localStorage.getItem(`bot-session-${currentBotId}`);
    if (stored) {
      setSessionKey(stored);
      return;
    }

    const nextSession = crypto.randomUUID();
    window.localStorage.setItem(`bot-session-${currentBotId}`, nextSession);
    setSessionKey(nextSession);
  }, [currentBotId]);

  useEffect(() => {
    if (!currentBot) {
      return;
    }

    setSystemPrompt(currentBot.systemPrompt);
    setBotName(currentBot.name);
    setTemperature(String(currentBot.temperature));
    setTopP(String(currentBot.topP));
    setTopK(String(currentBot.topK));
    setMaxOutputTokens(String(currentBot.maxOutputTokens));
    setChat([]);
    setMessage("");
    setError("");
  }, [currentBotId]);

  const remainingBytes = useMemo(() => Math.max(0, 100 * 1024 * 1024 - totalBytes), [totalBytes]);

  function upsertDocumentForCurrentBot(document: DocumentRecord) {
    setAllBots((existing) =>
      existing.map((bot) => {
        if (bot.id !== currentBotId) {
          return bot;
        }

        const byId = new Map(bot.documents.map((doc) => [doc.id, doc]));
        byId.set(document.id, document);
        return {
          ...bot,
          documents: Array.from(byId.values())
        };
      })
    );
  }

  function removeDocumentForCurrentBot(documentId: string) {
    setAllBots((existing) =>
      existing.map((bot) => {
        if (bot.id !== currentBotId) {
          return bot;
        }

        return {
          ...bot,
          documents: bot.documents.filter((doc) => doc.id !== documentId)
        };
      })
    );
  }

  function resetChatSession() {
    const nextSession = crypto.randomUUID();
    window.localStorage.setItem(`bot-session-${currentBotId}`, nextSession);
    setSessionKey(nextSession);
    setChat([]);
  }

  async function refreshCurrentBot(botId: string) {
    const response = await fetch(`/api/bots/${botId}?ts=${Date.now()}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const bot = payload.bot as BotRecord;
    setAllBots((existing) => existing.map((item) => (item.id === bot.id ? bot : item)));
    setCurrentBotId(bot.id);
  }

  async function saveBot() {
    if (!currentBot) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    const normalizedBotName = botName.trim();
    if (!normalizedBotName) {
      setLoading(false);
      setError("Chatbot name cannot be empty.");
      return;
    }

    const response = await fetch(`/api/bots/${currentBot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: normalizedBotName,
        systemPrompt,
        temperature: Number(temperature),
        topP: Number(topP),
        topK: Number(topK),
        maxOutputTokens: Number(maxOutputTokens)
      })
    });
    const payload = await response.json();
    setLoading(false);
    if (!response.ok) {
      setError(payload.error ?? "Could not save bot settings");
      return;
    }
    setAllBots((existing) => existing.map((bot) => (bot.id === currentBot.id ? { ...bot, ...payload.bot } : bot)));
    setMessage("Settings saved. Chat session reset.");
    resetChatSession();
    await refreshCurrentBot(currentBot.id);
    router.refresh();
  }

  async function toggleSubmission() {
    if (!currentBot) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    const action = currentBot.status === "SUBMITTED" ? "revert" : "submit";
    const response = await fetch(`/api/bots/${currentBot.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    const payload = await response.json();
    setLoading(false);
    if (!response.ok) {
      setError(payload.error ?? "Could not update submission status");
      return;
    }
    setAllBots((existing) => existing.map((bot) => (bot.id === currentBot.id ? { ...bot, ...payload.bot } : bot)));
    setMessage(action === "submit" ? "Bot submitted for grading." : "Submission reverted to draft.");
    await refreshCurrentBot(currentBot.id);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setPendingFiles(files);
  }

  async function handleUpload() {
    if (!currentBot) {
      return;
    }

    const files = pendingFiles;
    if (!files.length) {
      return;
    }

    setUploading(true);
    setError("");
    setMessage("");

    const tempIdByFileKey = new Map<string, string>();
    files.forEach((file, index) => {
      const tempId = `temp-${Date.now()}-${index}`;
      const key = `${file.name}-${file.size}-${index}`;
      tempIdByFileKey.set(key, tempId);
      upsertDocumentForCurrentBot({
        id: tempId,
        filename: file.name,
        mimeType: file.type || "text/plain",
        sizeBytes: file.size,
        status: "UPLOADING",
        chunkCount: 0
      });
    });

    try {
      const failedFiles: string[] = [];
      let uploadedCount = 0;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const key = `${file.name}-${file.size}-${index}`;
        const tempId = tempIdByFileKey.get(key) || "";

        try {
          const formData = new FormData();
          formData.append("botId", currentBot.id);
          formData.append("files", file);

          const response = await Promise.race([
            fetch("/api/documents/upload", {
              method: "POST",
              body: formData
            }),
            new Promise<Response>((_, reject) => {
              setTimeout(() => reject(new Error("UPLOAD_TIMEOUT")), 120000);
            })
          ]);

          const payload = await response.json().catch(() => ({}));
          const docs = Array.isArray(payload.documents) ? (payload.documents as DocumentRecord[]) : [];
          const uploadedDoc = docs[0];

          if (!response.ok || !uploadedDoc) {
            failedFiles.push(file.name);
            if (tempId) {
              upsertDocumentForCurrentBot({
                id: tempId,
                filename: file.name,
                mimeType: file.type || "text/plain",
                sizeBytes: file.size,
                status: "FAILED",
                chunkCount: 0
              });
            }
            continue;
          }

          uploadedCount += 1;
          if (tempId) {
            removeDocumentForCurrentBot(tempId);
          }
          upsertDocumentForCurrentBot(uploadedDoc);
        } catch {
          failedFiles.push(file.name);
          if (tempId) {
            upsertDocumentForCurrentBot({
              id: tempId,
              filename: file.name,
              mimeType: file.type || "text/plain",
              sizeBytes: file.size,
              status: "FAILED",
              chunkCount: 0
            });
          }
        }
      }

      if (!uploadedCount) {
        setError("Upload failed");
        return;
      }

      if (failedFiles.length) {
        setError(`Some files failed to upload: ${failedFiles.join(", ")}`);
      }
      setMessage(`${uploadedCount} file(s) uploaded. Chat session reset.`);
      resetChatSession();
    } finally {
      setUploading(false);
      setPendingFiles([]);
      setFileInputKey((value) => value + 1);
    }

    // Keep optimistic document list immediately after upload; avoid stale follow-up reads
    // that can temporarily hide newly uploaded files on Vercel.
  }

  async function deleteDocument(documentId: string) {
    if (!currentBot || deletingDocumentId) {
      return;
    }

    const confirmed = window.confirm("Delete this uploaded document? This cannot be undone.");
    if (!confirmed) {
      return;
    }

    setDeletingDocumentId(documentId);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: "DELETE"
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? "Could not delete document");
        return;
      }

      setAllBots((existing) =>
        existing.map((bot) => {
          if (bot.id !== currentBot.id) {
            return bot;
          }

          return {
            ...bot,
            documents: bot.documents.filter((doc) => doc.id !== documentId)
          };
        })
      );
      setMessage("Document deleted. Chat session reset.");
      resetChatSession();
      await refreshCurrentBot(currentBot.id);
      router.refresh();
    } catch {
      setError("Could not delete document");
    } finally {
      setDeletingDocumentId("");
    }
  }

  async function sendQuestion() {
    if (!currentBot || !query.trim() || chatLoading) {
      return;
    }
    setChatLoading(true);
    setError("");
    setChat((prev) => [...prev, { role: "user" as const, content: query.trim() }]);
    const currentQuery = query.trim();
    setQuery("");

    const endpoint = useAdminQueryEndpoint ? "/api/admin/bots/query" : "/api/chat";
    const body = useAdminQueryEndpoint
      ? JSON.stringify({ botId: currentBot.id, question: currentQuery, sessionKey })
      : JSON.stringify({ botId: currentBot.id, sessionKey, question: currentQuery });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setChatLoading(false);
      setError((payload as { error?: string }).error ?? "Chat failed");
      return;
    }

    // Admin endpoint still returns full JSON; student endpoint streams plain text.
    if (useAdminQueryEndpoint) {
      const payload = await response.json();
      setChatLoading(false);
      setChat((prev) => [...prev, { role: "assistant" as const, content: payload.answer }]);
      return;
    }

    // Streaming path: add a placeholder then append each token as it arrives.
    setChat((prev) => [...prev, { role: "assistant" as const, content: "" }]);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const token = decoder.decode(value, { stream: true });
        setChat((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: updated[updated.length - 1].content + token
          };
          return updated;
        });
      }
    } finally {
      setChatLoading(false);
    }
  }

  if (!currentBot) {
    return null;
  }

  const editDisabled = readOnly || currentBot.status === "SUBMITTED";

  return (
    <div className="stack">
      <section className="card">
        <div className="card-inner stack">
          <div className="row">
            <div>
              <div className="kicker">Workspace</div>
              <h2>Student chatbot configuration</h2>
              <p className="small"><em>Select LLM parameters, upload source documents, then click Save Settings to reflect the changes in the chat window.</em></p>
            </div>
          </div>
          {message ? <div className="success">{message}</div> : null}
          {error ? <div className="error">{error}</div> : null}
          {readOnly ? <div className="notice">Read-only admin view: you can use chat, but cannot edit settings or files.</div> : null}
        </div>
      </section>

      <div className="workspace-columns">
        <div className="stack workspace-side">
          <section className="card">
            <div className="card-inner stack">
              <h3>LLM parameters</h3>
              <div>
                <div className="label">Chatbot name</div>
                <input value={botName} onChange={(event) => setBotName(event.target.value)} maxLength={120} disabled={editDisabled} />
              </div>
              <div>
                <div className="label">System prompt</div>
                <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} disabled={editDisabled} />
              </div>
              <div className="panel-grid">
                <div>
                  <div className="label">Temperature</div>
                  <input value={temperature} onChange={(event) => setTemperature(event.target.value)} type="number" min="0" max="2" step="0.1" disabled={editDisabled} />
                </div>
                <div>
                  <div className="label">Top-p</div>
                  <input value={topP} onChange={(event) => setTopP(event.target.value)} type="number" min="0" max="1" step="0.05" disabled={editDisabled} />
                </div>
                <div>
                  <div className="label">Top-k</div>
                  <input value={topK} onChange={(event) => setTopK(event.target.value)} type="number" min="1" max="100" step="1" disabled={editDisabled} />
                </div>
                <div>
                  <div className="label">Max output tokens</div>
                  <input value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} type="number" min="32" max="4096" step="32" disabled={editDisabled} />
                </div>
              </div>
              <div className="divider" />

              <div className={uploadsEnabled ? "stack" : "stack disabled-panel"}>
              <h3>Source material</h3>
              <div className="notice">
                Upload limit remaining: {(remainingBytes / (1024 * 1024)).toFixed(1)} MB. Files used: {documents.length}/100.
              </div>
              <p>
                {uploadsEnabled
                  ? "Upload PDFs, text files, DOCX, or markdown files. The system indexes them automatically."
                  : "Source uploads are disabled. This chatbot currently runs in system-prompt-only mode."}
              </p>
              <p className="small">You can upload multiple files at once. Click Save Settings below to reflect the changes.</p>
              <input
                key={fileInputKey}
                type="file"
                multiple
                onChange={handleFileSelection}
                disabled={!uploadsEnabled || editDisabled}
              />
              <div className="row">
                <div className="small">
                  {pendingFiles.length ? `${pendingFiles.length} file(s) selected` : "No files selected"}
                </div>
                <button
                  type="button"
                  onClick={() => void handleUpload()}
                  disabled={!uploadsEnabled || editDisabled || uploading || !pendingFiles.length}
                >
                  {uploading ? "Uploading..." : "Upload selected"}
                </button>
              </div>
              <div className="file-list">
                {documents.map((doc) => (
                  <div className="file-item" key={doc.id}>
                    <div className="file-meta">
                      <div className="file-name" title={doc.filename}>{doc.filename}</div>
                      <div className="row">
                        <div className="small mono">{doc.mimeType}</div>
                        <span className={`status-pill ${(doc.status || "").toLowerCase()}`}>{doc.status}</span>
                      </div>
                    </div>
                    <div className="row">
                      <div className="small">{(doc.sizeBytes / 1024).toFixed(1)} KB</div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void deleteDocument(doc.id)}
                        disabled={
                          !uploadsEnabled ||
                          editDisabled ||
                          deletingDocumentId === doc.id
                        }
                      >
                        {deletingDocumentId === doc.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                ))}
                {!documents.length ? <p>No files uploaded yet.</p> : null}
              </div>
              </div>

              <div className="divider" />
              <div className="row">
                <button
                  onClick={saveBot}
                  disabled={loading || uploading || pendingFiles.length > 0 || editDisabled}
                >
                  Save settings
                </button>
                <button className="secondary" onClick={toggleSubmission} disabled={loading || !uploadsEnabled || readOnly}>
                  {currentBot.status === "SUBMITTED" ? "Revert submission" : "Submit for grading"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="card chat workspace-main">
          <div className="card-inner stack">
          <div className="row">
            <div>
              <div className="kicker">Preview</div>
              <h3>Multi-turn Q&A</h3>
            </div>
            <div className="badge">Session: {sessionKey || "initializing..."}</div>
            <div className="badge">Status: {currentBot.status}</div>
          </div>
          <div className="chat-log">
            {chat.length ? chat.map((entry, index) => (
              <div className={`bubble ${entry.role}`} key={`${entry.role}-${index}`}>
                <div className="role">{entry.role}</div>
                <div>{entry.content}</div>
              </div>
            )) : <p>Ask the bot a question to preview how the chatbot will answer.</p>}
            {chatLoading ? (
              <div className="bubble assistant typing-bubble" aria-live="polite" aria-label="Assistant is typing">
                <div className="role">assistant</div>
                <div className="typing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}
          </div>
          <div className="divider" />
          <div className="row">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask a question..." onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendQuestion();
              }
            }} disabled={chatLoading} />
            <button onClick={sendQuestion} disabled={chatLoading}>{chatLoading ? "Thinking..." : "Send"}</button>
          </div>
        </div>
        </section>
      </div>
    </div>
  );
}
