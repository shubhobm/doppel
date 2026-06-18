import { db } from "./db";
import { CHAT_HISTORY_LIMIT, CHAT_MODEL } from "./limits";
import { getOpenAIClient } from "./openai";
import { retrieveRelevantChunks } from "./rag";

export async function getOrCreateChatSession(botId: string, sessionKey: string) {
  return db.chatSession.upsert({
    where: {
      botId_sessionKey: {
        botId,
        sessionKey
      }
    },
    update: {},
    create: {
      botId,
      sessionKey
    }
  });
}

export async function saveChatMessage(sessionId: string, role: string, content: string) {
  await db.chatMessage.create({
    data: {
      sessionId,
      role,
      content
    }
  });
}

export async function getRecentMessages(sessionId: string) {
  return db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: CHAT_HISTORY_LIMIT
  });
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);
}

function scoreSentence(questionTerms: Set<string>, sentence: string) {
  const sentenceTerms = new Set(tokenize(sentence));
  let score = 0;
  for (const term of questionTerms) {
    if (sentenceTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}

function fallbackAnswer(question: string, chunks: Array<{ content: string }>) {
  const questionTerms = new Set(tokenize(question));
  const sentences = chunks.flatMap((chunk) =>
    chunk.content
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
  );

  const ranked = sentences
    .map((sentence) => ({
      sentence,
      score: scoreSentence(questionTerms, sentence)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  if (ranked.length === 0) {
    const firstChunk = chunks[0]?.content?.trim();
    if (firstChunk) {
      return `Based on the uploaded material, the most relevant guidance I found is: ${firstChunk.slice(0, 500)}${firstChunk.length > 500 ? "..." : ""}`;
    }

    return "I could not find any uploaded source material to answer from yet.";
  }

  return `Based on the uploaded material, here is the most relevant answer I can derive:\n\n${ranked.map((entry) => `- ${entry.sentence}`).join("\n")}`;
}

function formatRetrievedContext(chunks: Array<{ source: { filename: string; chunkIndex: number }; content: string }>) {
  if (!chunks.length) {
    return "No source material has been uploaded yet.";
  }

  return chunks
    .slice(0, 4)
    .map((chunk, index) => {
      const header = `Source ${index + 1}: ${chunk.source.filename} [chunk ${chunk.source.chunkIndex + 1}]`;
      return `${header}\n${chunk.content.slice(0, 900)}`;
    })
    .join("\n\n---\n\n");
}

function buildMessages(params: {
  systemPrompt: string;
  retrievedContext: string;
  hasRetrievedChunks: boolean;
  conversation: string;
  question: string;
  budget: number;
  contextSlice?: number;
  chunks: Array<{ source: { filename: string; chunkIndex: number }; content: string }>;
}) {
  const contextText = params.contextSlice !== undefined
    ? formatRetrievedContext(params.chunks.slice(0, params.contextSlice))
    : params.retrievedContext;

  return {
    model: CHAT_MODEL,
    max_completion_tokens: params.budget,
    messages: [
      {
        role: "system" as const,
        content: params.systemPrompt
      },
      {
        role: "user" as const,
        content: params.hasRetrievedChunks
          ? [
              "Use the retrieved chunks below as the primary source of truth.",
              "If the answer is not in the chunks, say the material is insufficient.",
              "Keep the final answer concise and direct.",
              "",
              `Retrieved chunks:\n${contextText}`,
              "",
              `Conversation so far:\n${params.conversation}`,
              "",
              `Current question:\n${params.question}`
            ].join("\n")
          : [
              "No retrieved chunks are available for this request.",
              "Answer using the student system prompt and conversation history only.",
              "Keep the final answer concise and direct.",
              "",
              `Conversation so far:\n${params.conversation}`,
              "",
              `Current question:\n${params.question}`
            ].join("\n")
      }
    ]
  };
}

async function prepareContext(botId: string, sessionKey: string, question: string, systemPromptText: string) {
  // session creation and RAG retrieval are independent — run in parallel
  const [session, chunks] = await Promise.all([
    getOrCreateChatSession(botId, sessionKey),
    retrieveRelevantChunks(botId, question, 6)
  ]);

  const recentMessages = await getRecentMessages(session.id);

  const hasRetrievedChunks = chunks.length > 0;
  const retrievedContext = formatRetrievedContext(chunks);

  const conversation = recentMessages
    .reverse()
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .concat([`USER: ${question}`])
    .join("\n\n");

  const systemPrompt = [
    "You are a midterm chatbot built by a student.",
    "Answer the user's question directly and clearly.",
    hasRetrievedChunks
      ? "Use the provided source context and the conversation history."
      : "No source documents are available right now; answer using the student system prompt and conversation history.",
    hasRetrievedChunks
      ? "If the context is insufficient, say so briefly and give the best grounded answer you can."
      : "Provide a best-effort direct answer without asking for retrieved chunks.",
    "Do not mention internal policies or retrieval mechanics unless asked.",
    systemPromptText ? `Student system prompt: ${systemPromptText}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return { session, chunks, hasRetrievedChunks, retrievedContext, conversation, systemPrompt };
}

// Used by the admin endpoint where the full answer is needed synchronously.
export async function generateBotAnswer(params: {
  botId: string;
  sessionKey: string;
  question: string;
}) {
  const bot = await db.studentBot.findUnique({
    where: { id: params.botId }
  });

  if (!bot) {
    throw new Error("Bot not found");
  }

  const client = getOpenAIClient();
  const ctx = await prepareContext(bot.id, params.sessionKey, params.question, bot.systemPrompt);

  const trace: {
    llmAttempted: boolean;
    llmUsed: boolean;
    fallbackUsed: boolean;
    attempts: number;
    llmModel?: string;
    finishReason?: string | null;
    error?: string;
  } = {
    llmAttempted: false,
    llmUsed: false,
    fallbackUsed: false,
    attempts: 0
  };

  let answer = "";

  if (client) {
    try {
      const completionBudget = Math.max(bot.maxOutputTokens, 1200);

      const run = async (contextSlice?: number) => {
        trace.llmAttempted = true;
        trace.attempts += 1;
        const completion = await client.chat.completions.create(
          buildMessages({ ...ctx, budget: completionBudget, contextSlice, question: params.question })
        );
        trace.llmModel = completion.model;
        trace.finishReason = completion.choices?.[0]?.finish_reason;
        return completion.choices?.[0]?.message?.content?.trim() ?? "";
      };

      answer = await run();
      if (!answer && trace.finishReason === "length") {
        answer = await run(2);
      }
    } catch (error) {
      console.error("LLM response generation failed", error);
      trace.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (!answer) {
    trace.fallbackUsed = true;
    answer = fallbackAnswer(params.question, ctx.chunks);
  } else {
    trace.llmUsed = true;
  }

  // save user and assistant messages in parallel
  await Promise.all([
    saveChatMessage(ctx.session.id, "user", params.question),
    saveChatMessage(ctx.session.id, "assistant", answer)
  ]);

  return {
    sessionId: ctx.session.id,
    answer,
    chunks: ctx.chunks,
    trace
  };
}

// Used by the student chat endpoint. Streams tokens to the client and fires off
// DB saves after the stream completes so the client isn't blocked on writes.
// onComplete receives the full answer text for callers that need to log it.
export async function streamBotAnswer(params: {
  botId: string;
  sessionKey: string;
  question: string;
  onComplete?: (answer: string) => void;
}): Promise<ReadableStream<Uint8Array>> {
  const bot = await db.studentBot.findUnique({
    where: { id: params.botId }
  });

  if (!bot) {
    throw new Error("Bot not found");
  }

  const client = getOpenAIClient();
  const ctx = await prepareContext(bot.id, params.sessionKey, params.question, bot.systemPrompt);
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = "";

      if (client) {
        try {
          const completionBudget = Math.max(bot.maxOutputTokens, 1200);
          const llmStream = await client.chat.completions.create({
            ...buildMessages({ ...ctx, budget: completionBudget, question: params.question }),
            stream: true
          });

          for await (const chunk of llmStream) {
            const token = chunk.choices[0]?.delta?.content ?? "";
            if (token) {
              answer += token;
              controller.enqueue(encoder.encode(token));
            }
          }
        } catch (error) {
          console.error("LLM stream failed", error);
        }
      }

      if (!answer) {
        answer = fallbackAnswer(params.question, ctx.chunks);
        controller.enqueue(encoder.encode(answer));
      }

      controller.close();

      // DB writes happen after the stream is closed — client is already unblocked
      Promise.all([
        saveChatMessage(ctx.session.id, "user", params.question),
        saveChatMessage(ctx.session.id, "assistant", answer)
      ]).catch((err) => console.error("Failed to save chat messages", err));

      params.onComplete?.(answer);
    }
  });
}
