import type { Api } from "grammy/web";
import {
  ADMIN_ID,
  embedChatId,
  extractChatId,
  extractSiteId,
  GITHUB_REPO,
  getSite,
  isOwnBotLogin,
  SITES,
  siteFromLabels,
} from "./config";
import {
  closeIssue,
  closePullRequest,
  commentOnIssue,
  createIssue,
  getIssue,
  mergePullRequest,
  reactToComment,
  triggerDispatch,
  verifyGitHubWebhook,
} from "./github";
import { transcribeVoice } from "./openai";
import {
  buttons,
  closeForumTopic,
  createApi,
  createForumTopic,
  editForumTopicName,
  getFileUrl,
  sendMessage,
} from "./telegram";
import type { Env, GitHubWebhookEvent, SiteConfig } from "./types";
import {
  decideThreadAction,
  getTelegramToken,
  hasUserContent,
  parseNewTaskCommand,
  pendingKey,
  shouldNotifyOnPrOpened,
  userKey,
  userListPrefix,
} from "./types";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // --- Telegram Webhook: /webhook/{site} ---
    const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+)$/);
    if (webhookMatch && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let site: SiteConfig;
      try {
        site = getSite(webhookMatch[1]);
      } catch {
        return new Response("Unknown site", { status: 404 });
      }

      // biome-ignore lint/suspicious/noExplicitAny: raw Telegram update
      const update: any = await request.json();
      const token = getTelegramToken(env, site);
      const api = createApi(token);
      try {
        await handleTelegram(update, api, env, site, ctx);
      } catch (error) {
        console.error("Telegram handler error:", error);
        // Try to at least tell the user something went wrong, instead
        // of leaving them in the dark staring at a silent bot.
        const fallbackChatId =
          update?.message?.chat?.id ??
          update?.callback_query?.message?.chat?.id;
        const fallbackThreadId =
          update?.message?.message_thread_id ??
          update?.callback_query?.message?.message_thread_id;
        if (fallbackChatId) {
          try {
            await sendMessage(
              api,
              fallbackChatId,
              `❌ Something went wrong while processing your message.\n\nError: ${error instanceof Error ? error.message : String(error)}\n\nIf this keeps happening, contact the admin.`,
              undefined,
              fallbackThreadId,
            );
          } catch (sendError) {
            console.error("Fallback sendMessage failed:", sendError);
          }
        }
      }
      return new Response("OK");
    }

    // --- GitHub App Webhook: /github (shared) ---
    if (url.pathname === "/github" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("X-Hub-Signature-256") ?? "";

      if (!(await verifyGitHubWebhook(env.WEBHOOK_SECRET, signature, body))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const event = JSON.parse(body) as GitHubWebhookEvent;
      const eventType = request.headers.get("X-GitHub-Event") ?? "";

      try {
        await handleGitHub(eventType, event, env);
      } catch (error) {
        console.error("GitHub handler error:", error);
      }
      return new Response("OK");
    }

    // --- Action Callback: /callback/{site} ---
    const callbackMatch = url.pathname.match(/^\/callback\/([^/]+)$/);
    if (callbackMatch && request.method === "POST") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      let site: SiteConfig;
      try {
        site = getSite(callbackMatch[1]);
      } catch {
        return new Response("Unknown site", { status: 404 });
      }

      const payload = (await request.json()) as {
        issue_number: number;
        issue_title: string;
        pr_url?: string;
        pr_number?: number;
        preview_url?: string;
        deep_links?: string;
        error?: string;
      };
      const api = createApi(getTelegramToken(env, site));

      try {
        await handleActionCallback(payload, api, env, site);
      } catch (error) {
        console.error("Callback handler error:", error);
      }
      return new Response("OK");
    }

    // --- Health Check ---
    if (url.pathname === "/health") {
      const required: string[] = [
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_INSTALLATION_ID",
        "WEBHOOK_SECRET",
        "OPENAI_API_KEY",
        // One Telegram bot token per configured site.
        ...Object.values(SITES).map((s) => s.tokenKey),
      ];
      const missing = required.filter((k) => !env[k]);
      if (missing.length > 0) {
        return new Response(`Missing env: ${missing.join(", ")}`, {
          status: 503,
        });
      }
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ─── Telegram Handler ───

async function handleTelegram(
  // biome-ignore lint/suspicious/noExplicitAny: Telegram update type from raw JSON
  update: any,
  api: Api,
  env: Env,
  site: SiteConfig,
  ctx: ExecutionContext,
): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, api, env, site);
    return;
  }
  if (update.message) {
    await handleMessage(update.message, api, env, site, ctx);
  }
}

// ─── Topic/Thread KV Helpers ───
// Thread mappings are stored per site so that threads from different
// sites never collide.

async function getTopicId(
  env: Env,
  siteId: string,
  chatId: number,
  issueNumber: number,
): Promise<number | null> {
  const val = await env.USERS.get(`topic:${siteId}:${chatId}:${issueNumber}`);
  return val ? Number.parseInt(val, 10) : null;
}

async function storeTopicMapping(
  env: Env,
  siteId: string,
  chatId: number,
  issueNumber: number,
  threadId: number,
): Promise<void> {
  await env.USERS.put(
    `topic:${siteId}:${chatId}:${issueNumber}`,
    String(threadId),
  );
  await env.USERS.put(
    `thread:${siteId}:${chatId}:${threadId}`,
    String(issueNumber),
  );
}

async function storePrTopicMapping(
  env: Env,
  siteId: string,
  chatId: number,
  prNumber: number,
  threadId: number,
): Promise<void> {
  await env.USERS.put(`pr:${siteId}:${chatId}:${prNumber}`, String(threadId));
}

async function getPrTopicId(
  env: Env,
  siteId: string,
  chatId: number,
  prNumber: number,
): Promise<number | null> {
  const val = await env.USERS.get(`pr:${siteId}:${chatId}:${prNumber}`);
  return val ? Number.parseInt(val, 10) : null;
}

async function getIssueFromThread(
  env: Env,
  siteId: string,
  chatId: number,
  threadId: number,
): Promise<number | null> {
  const val = await env.USERS.get(`thread:${siteId}:${chatId}:${threadId}`);
  return val ? Number.parseInt(val, 10) : null;
}

async function isAuthorized(
  env: Env,
  siteId: string,
  userId: number,
): Promise<boolean> {
  if (userId === ADMIN_ID) return true;
  const user = await env.USERS.get(userKey(siteId, userId));
  return user !== null;
}

// ─── Message Handler ───

async function handleMessage(
  // biome-ignore lint/suspicious/noExplicitAny: Telegram message from raw JSON
  message: any,
  api: Api,
  env: Env,
  site: SiteConfig,
  ctx: ExecutionContext,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const userName = message.from?.first_name ?? "Unbekannt";
  const token = getTelegramToken(env, site);
  const threadId: number | undefined = message.message_thread_id;

  // Service-Messages (forum_topic_created, new_chat_members, …) haben keinen
  // User-Content und werden stumm übersprungen, damit der Bot nicht auf jedes
  // Telegram-Systemevent mit „nicht berechtigt" antwortet.
  if (!hasUserContent(message)) return;

  // ── Commands im General-Chat ─────────────────────────────

  if (!threadId && message.text?.startsWith("/start")) {
    if (userId && (await isAuthorized(env, site.id, userId))) {
      await sendMessage(
        api,
        chatId,
        `Hallo ${userName}! 👋\n\nNutze /new_task um einen neuen Auftrag für die ${site.name}-Website anzulegen. Der Bot öffnet dann einen Thread für den Auftrag, in dem du Text, Sprache, Fotos oder Dokumente schickst.`,
      );
    } else {
      await sendMessage(
        api,
        chatId,
        `Hallo ${userName}! Du bist für ${site.name} noch nicht freigeschaltet.\n\nBitte teile dem Vorstand deine Telegram-ID mit: ${userId}`,
      );
    }
    return;
  }

  if (!threadId && message.text?.startsWith("/join")) {
    if (userId && (await isAuthorized(env, site.id, userId))) {
      await sendMessage(
        api,
        chatId,
        `Du bist für ${site.name} bereits freigeschaltet.`,
      );
      return;
    }
    await sendMessage(
      api,
      ADMIN_ID,
      `🔔 ${userName} (ID: ${userId}) möchte den Bot ${site.name} nutzen.`,
      buttons([
        [
          { text: "✅ Freischalten", data: `accept:${userId}` },
          { text: "❌ Ablehnen", data: `reject:${userId}` },
        ],
      ]),
    );
    await sendMessage(
      api,
      chatId,
      "📩 Deine Anfrage wurde an den Administrator gesendet. Du wirst benachrichtigt, sobald du freigeschaltet bist.",
    );
    await env.USERS.put(pendingKey(site.id, userId), userName, {
      expirationTtl: 86400,
    });
    return;
  }

  if (!threadId && message.text?.startsWith("/users") && userId === ADMIN_ID) {
    const list = await env.USERS.list({ prefix: userListPrefix(site.id) });
    const users = await Promise.all(
      list.keys.map(async (k) => {
        const name = await env.USERS.get(k.name);
        const id = k.name.replace(userListPrefix(site.id), "");
        return `${id} – ${name}`;
      }),
    );
    const text =
      users.length > 0
        ? `Freigeschaltete User für ${site.name}:\n${users.join("\n")}\n\nAdmin: ${ADMIN_ID}`
        : `Keine weiteren User für ${site.name}. Admin: ${ADMIN_ID}`;
    await sendMessage(api, chatId, text);
    return;
  }

  // ── Auth ──────────────────────────────────────────────────

  if (!userId || !(await isAuthorized(env, site.id, userId))) {
    await sendMessage(
      api,
      chatId,
      "⛔ Du bist nicht berechtigt, diesen Bot zu nutzen.",
    );
    return;
  }

  // ── /new_task THEMA: neuen Thread + pending-Flag anlegen ──

  if (!threadId && message.text?.startsWith("/new_task")) {
    const thema = parseNewTaskCommand(message.text);
    if (!thema) {
      await sendMessage(
        api,
        chatId,
        "Bitte gib ein Thema an: /new_task THEMA\n\nBeispiel: /new_task Stammtisch am 25.4.",
      );
      return;
    }
    try {
      const newThreadId = await createForumTopic(api, chatId, thema);
      await env.USERS.put(
        `pending-task:${site.id}:${chatId}:${newThreadId}`,
        thema,
        { expirationTtl: 3600 },
      );
      await sendMessage(
        api,
        chatId,
        `📝 Neuer Auftrag „${thema}" — schick mir hier im Thread deine Beschreibung (Text, Sprache, Foto oder Dokument).`,
        undefined,
        newThreadId,
      );
    } catch (error) {
      console.error(
        `createForumTopic failed for chat ${chatId} thema "${thema}":`,
        error,
      );
      await sendMessage(
        api,
        chatId,
        "❌ Could not create a new thread.\n\nLikely causes:\n• Topics are not enabled for this bot yet (BotFather → Bot Settings → Topics in Private Chats → Enable)\n• The bot is not allowed to create topics in this chat\n\nIf this keeps happening, contact the admin.",
      );
    }
    return;
  }

  // ── Message inside a thread ───────────────────────────────

  if (threadId) {
    const issueNumber = await getIssueFromThread(
      env,
      site.id,
      chatId,
      threadId,
    );
    const thema = await env.USERS.get(
      `pending-task:${site.id}:${chatId}:${threadId}`,
    );
    const action = decideThreadAction(issueNumber, thema);

    switch (action.kind) {
      case "reply": {
        let replyText = message.text ?? message.caption ?? "";

        const audioFileId = message.voice?.file_id ?? message.audio?.file_id;
        if (audioFileId) {
          try {
            const fileUrl = await getFileUrl(api, token, audioFileId);
            replyText = await transcribeVoice(env, fileUrl);
            await sendMessage(
              api,
              chatId,
              `🎙️ Erkannt: „${replyText}"`,
              undefined,
              threadId,
            );
          } catch {
            await sendMessage(
              api,
              chatId,
              "❌ Audio konnte nicht transkribiert werden.",
              undefined,
              threadId,
            );
            return;
          }
        }

        if (!replyText) {
          await sendMessage(
            api,
            chatId,
            "❓ This message has no usable content (text, voice, photo or document).",
            undefined,
            threadId,
          );
          return;
        }

        let issueCtx = `#${action.issueNumber}`;
        try {
          const iss = await getIssue(env, action.issueNumber);
          const short =
            iss.title.length > 40
              ? `${iss.title.substring(0, 37)}…`
              : iss.title;
          issueCtx = `#${action.issueNumber} „${short}"`;
        } catch {
          /* keep default */
        }

        await commentOnIssue(
          env,
          action.issueNumber,
          `**${userName} (via Telegram):**\n\n${replyText}`,
        );
        await triggerDispatch(
          env,
          "telegram-plan",
          sitePayload(site, action.issueNumber),
        );
        await sendMessage(
          api,
          chatId,
          `💬 Reply for ${issueCtx} sent. Claude is revising the plan…`,
          undefined,
          threadId,
        );
        return;
      }

      case "newTask": {
        if (message.media_group_id) {
          const groupKey = `mediagroup:${site.id}:${threadId}:${message.media_group_id}`;
          const existing = await env.USERS.get(groupKey);
          // biome-ignore lint/suspicious/noExplicitAny: buffered raw messages
          const messages: any[] = existing ? JSON.parse(existing) : [];
          messages.push(message);
          await env.USERS.put(groupKey, JSON.stringify(messages), {
            expirationTtl: 60,
          });
          if (messages.length === 1) {
            ctx.waitUntil(
              processMediaGroupDelayed(
                groupKey,
                env,
                site,
                threadId,
                action.thema,
              ),
            );
          }
          return;
        }

        await processSingleMessageAsTask(
          message,
          api,
          env,
          site,
          threadId,
          action.thema,
        );
        return;
      }

      case "unknownThread": {
        // Old thread or topic without KV mapping. NEVER silently return —
        // tell the user what happened so they know how to recover.
        await sendMessage(
          api,
          chatId,
          "❓ This thread is not linked to an active task.\n\nStart a new task with /new_task THEMA in the main chat. If this is an old thread, close it.",
          undefined,
          threadId,
        );
        return;
      }
    }
  }

  // ── Nachricht im General-Chat ohne Command ────────────────

  await sendMessage(
    api,
    chatId,
    "Nutze /new_task um einen neuen Auftrag anzulegen.",
  );
}

async function processSingleMessageAsTask(
  // biome-ignore lint/suspicious/noExplicitAny: Telegram message from raw JSON
  message: any,
  api: Api,
  env: Env,
  site: SiteConfig,
  threadId: number,
  thema: string,
): Promise<void> {
  const chatId = message.chat.id;
  const userName = message.from?.first_name ?? "Unbekannt";
  const token = getTelegramToken(env, site);

  let text = message.text ?? message.caption ?? "";
  const attachments: string[] = [];

  // Voice → Whisper
  if (message.voice) {
    await sendMessage(
      api,
      chatId,
      "🎙️ Sprachnachricht wird transkribiert…",
      undefined,
      threadId,
    );
    try {
      const fileUrl = await getFileUrl(api, token, message.voice.file_id);
      text = await transcribeVoice(env, fileUrl);
      await sendMessage(
        api,
        chatId,
        `🎙️ Erkannt: „${text}"`,
        undefined,
        threadId,
      );
    } catch (error) {
      console.error("Whisper error:", error);
      await sendMessage(
        api,
        chatId,
        "❌ Sprachnachricht konnte nicht transkribiert werden.",
        undefined,
        threadId,
      );
      return;
    }
  }

  // Audio file → Whisper
  if (message.audio) {
    await sendMessage(
      api,
      chatId,
      "🎙️ Audiodatei wird transkribiert…",
      undefined,
      threadId,
    );
    try {
      const fileUrl = await getFileUrl(api, token, message.audio.file_id);
      const transcription = await transcribeVoice(env, fileUrl);
      text = text
        ? `${text}\n\n🎙️ Transkription:\n${transcription}`
        : transcription;
      await sendMessage(
        api,
        chatId,
        `🎙️ Erkannt: „${transcription}"`,
        undefined,
        threadId,
      );
    } catch (error) {
      console.error("Audio transcription error:", error);
      await sendMessage(
        api,
        chatId,
        "❌ Audiodatei konnte nicht transkribiert werden.",
        undefined,
        threadId,
      );
      return;
    }
  }

  // Fotos
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    try {
      const fileUrl = await getFileUrl(api, token, largest.file_id);
      attachments.push(`![Foto](${fileUrl})`);
    } catch {
      attachments.push("_(Foto konnte nicht geladen werden)_");
    }
  }

  // Dokument
  if (message.document) {
    try {
      const fileUrl = await getFileUrl(api, token, message.document.file_id);
      const name = message.document.file_name ?? "Dokument";
      const mime = message.document.mime_type ?? "";
      const isConvertible =
        mime.includes("word") ||
        mime.includes("pdf") ||
        name.toLowerCase().endsWith(".docx") ||
        name.toLowerCase().endsWith(".pdf");
      if (isConvertible) {
        attachments.push(
          `<!-- convertible:${fileUrl}:${name} -->\n[${name}](${fileUrl})`,
        );
      } else {
        attachments.push(`[${name}](${fileUrl})`);
      }
    } catch {
      attachments.push(
        `_(${message.document.file_name ?? "Dokument"} konnte nicht geladen werden)_`,
      );
    }
  }

  if (!text && attachments.length === 0) {
    await sendMessage(
      api,
      chatId,
      "❓ This message has no usable content (text, voice, photo or document). Send something I can process.",
      undefined,
      threadId,
    );
    return;
  }

  await createAndDispatchIssueInThread(
    api,
    env,
    site,
    chatId,
    threadId,
    userName,
    thema,
    text,
    attachments,
  );
}

async function createAndDispatchIssueInThread(
  api: Api,
  env: Env,
  site: SiteConfig,
  chatId: number,
  threadId: number,
  userName: string,
  thema: string,
  text: string,
  attachments: string[],
): Promise<void> {
  const title = thema.length > 60 ? `${thema.substring(0, 57)}…` : thema;
  const attachmentSection =
    attachments.length > 0 ? `\n\n**Anhänge:**\n${attachments.join("\n")}` : "";
  const body = `${embedChatId(chatId, site.id)}

**Auftrag von ${userName} (via Telegram):**

${text}${attachmentSection}

---

@${site.botUsername} Bitte analysiere diesen Auftrag für die Website ${site.domain} und erstelle einen kurzen Plan (3-5 Stichpunkte), was geändert werden soll. Erfinde NIEMALS Daten – nur verwenden was im Auftrag steht. Fehlende Infos als „❓ fehlt noch" kennzeichnen.`;

  try {
    const issueNumber = await createIssue(env, site.id, title, body);

    await storeTopicMapping(env, site.id, chatId, issueNumber, threadId);
    await env.USERS.delete(`pending-task:${site.id}:${chatId}:${threadId}`);

    try {
      await editForumTopicName(
        api,
        chatId,
        threadId,
        `#${issueNumber} ${title}`,
      );
    } catch {
      // Rename nicht kritisch — Mapping ist gesetzt
    }

    await triggerDispatch(env, "telegram-plan", sitePayload(site, issueNumber));

    await sendMessage(
      api,
      chatId,
      `📝 Auftrag #${issueNumber} erstellt. Claude analysiert jetzt…\nhttps://github.com/${GITHUB_REPO}/issues/${issueNumber}`,
      undefined,
      threadId,
    );
  } catch (error) {
    console.error("Issue creation error:", error);
    await sendMessage(
      api,
      chatId,
      "❌ Fehler beim Erstellen des Auftrags.",
      undefined,
      threadId,
    );
  }
}

function sitePayload(
  site: SiteConfig,
  issueNumber: number,
): Record<string, unknown> {
  return {
    issue_number: issueNumber,
    site_id: site.id,
    site_domain: site.domain,
    site_workspace: site.workspace,
    site_content_dir: site.contentDir,
  };
}

async function processMediaGroupDelayed(
  groupKey: string,
  env: Env,
  site: SiteConfig,
  threadId: number,
  thema: string,
): Promise<void> {
  // 5 Sekunden warten, damit alle Fotos der Gruppe eingetroffen sind
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const data = await env.USERS.get(groupKey);
  if (!data) return;
  await env.USERS.delete(groupKey);

  // biome-ignore lint/suspicious/noExplicitAny: buffered raw messages
  const messages = JSON.parse(data) as any[];
  if (messages.length === 0) return;

  const first = messages[0];
  const chatId = first.chat.id;
  const userName = first.from?.first_name ?? "Unbekannt";
  const token = getTelegramToken(env, site);
  const api = createApi(token);

  // Text/Caption aus erster Message mit Text, sonst leer
  let text = "";
  for (const msg of messages) {
    const msgText = msg.text ?? msg.caption ?? "";
    if (msgText) {
      text = msgText;
      break;
    }
  }

  // Alle Fotos aus der Gruppe einsammeln
  const attachments: string[] = [];
  for (const msg of messages) {
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      try {
        const fileUrl = await getFileUrl(api, token, largest.file_id);
        attachments.push(`![Foto](${fileUrl})`);
      } catch {
        attachments.push("_(Foto konnte nicht geladen werden)_");
      }
    }
  }

  if (!text && attachments.length === 0) return;

  await createAndDispatchIssueInThread(
    api,
    env,
    site,
    chatId,
    threadId,
    userName,
    thema,
    text,
    attachments,
  );
}

// ─── Callback Handler ───

async function handleCallback(
  // biome-ignore lint/suspicious/noExplicitAny: Telegram callback query from raw JSON
  query: any,
  api: Api,
  env: Env,
  site: SiteConfig,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  await api.answerCallbackQuery(query.id);

  const [action, numberStr] = data.split(":");
  const number = Number.parseInt(numberStr, 10);
  if (!number) return;

  // Load issue title for context
  let ctx = `#${number}`;
  try {
    if (action === "merge" || action === "discard") {
      ctx = `PR #${number}`;
    } else {
      const issue = await getIssue(env, number);
      const short =
        issue.title.length > 40
          ? `${issue.title.substring(0, 37)}…`
          : issue.title;
      ctx = `#${number} „${short}"`;
    }
  } catch {
    // keep default ctx
  }

  // Thread-ID laden
  let threadId: number | undefined;
  if (action === "merge" || action === "discard") {
    threadId = (await getPrTopicId(env, site.id, chatId, number)) ?? undefined;
  } else if (
    action === "execute" ||
    action === "reply" ||
    action === "cancel"
  ) {
    threadId = (await getTopicId(env, site.id, chatId, number)) ?? undefined;
  }

  switch (action) {
    case "execute": {
      await sendMessage(
        api,
        chatId,
        `⚙️ Claude setzt ${ctx} um. Das dauert ein paar Minuten…`,
        undefined,
        threadId,
      );
      await commentOnIssue(
        env,
        number,
        "Bitte setze den Plan um: Erstelle die nötigen Content-Dateien gemäß CLAUDE.md, committe die Änderungen und erstelle einen Pull Request.",
      );
      await triggerDispatch(env, "telegram-execute", sitePayload(site, number));
      break;
    }
    case "reply": {
      if (threadId) {
        await sendMessage(
          api,
          chatId,
          `✏️ Schreib deine Antwort zu ${ctx} hier in diesen Thread (Text oder Sprache):`,
          undefined,
          threadId,
        );
      } else {
        await sendMessage(
          api,
          chatId,
          `✏️ Antworte auf ${ctx} (Text oder Sprache):`,
          { force_reply: true },
        );
      }
      break;
    }
    case "cancel": {
      await closeIssue(env, number);
      await sendMessage(
        api,
        chatId,
        `❌ ${ctx} abgebrochen.`,
        undefined,
        threadId,
      );
      if (threadId) {
        try {
          await closeForumTopic(api, chatId, threadId);
        } catch {
          // non-critical
        }
      }
      break;
    }
    case "merge": {
      await sendMessage(
        api,
        chatId,
        `🚀 ${ctx} wird live geschaltet…`,
        undefined,
        threadId,
      );
      try {
        await mergePullRequest(env, number);
        await sendMessage(
          api,
          chatId,
          `✅ ${ctx} ist live auf ${site.domain}!`,
          undefined,
          threadId,
        );
        if (threadId) {
          try {
            await closeForumTopic(api, chatId, threadId);
          } catch {
            // non-critical
          }
        }
      } catch (error) {
        console.error("Merge error:", error);
        await sendMessage(
          api,
          chatId,
          `❌ Fehler beim Mergen von ${ctx}.`,
          undefined,
          threadId,
        );
      }
      break;
    }
    case "discard": {
      await closePullRequest(env, number);
      await sendMessage(
        api,
        chatId,
        `🗑️ ${ctx} verworfen.`,
        undefined,
        threadId,
      );
      if (threadId) {
        try {
          await closeForumTopic(api, chatId, threadId);
        } catch {
          // non-critical
        }
      }
      break;
    }
    case "accept": {
      const pendingName = await env.USERS.get(pendingKey(site.id, number));
      const name = pendingName ?? `User ${number}`;
      await env.USERS.put(userKey(site.id, number), name);
      await env.USERS.delete(pendingKey(site.id, number));
      await sendMessage(
        api,
        chatId,
        `✅ ${name} (${number}) für ${site.name} freigeschaltet.`,
      );
      await sendMessage(
        api,
        number,
        `🎉 Du bist jetzt für ${site.name} freigeschaltet! Nutze /new_task um einen Auftrag anzulegen.`,
      );
      break;
    }
    case "reject": {
      await env.USERS.delete(pendingKey(site.id, number));
      await sendMessage(
        api,
        chatId,
        `❌ Anfrage von ${number} für ${site.name} abgelehnt.`,
      );
      await sendMessage(
        api,
        number,
        `❌ Deine Anfrage für ${site.name} wurde abgelehnt.`,
      );
      break;
    }
  }
}

// ─── GitHub Webhook Handler ───

async function handleGitHub(
  eventType: string,
  event: GitHubWebhookEvent,
  env: Env,
): Promise<void> {
  if (eventType === "issue_comment" && event.action === "created") {
    await handleIssueComment(event, env);
  }
  if (eventType === "pull_request" && event.action === "opened") {
    await handlePullRequestOpened(event, env);
  }
}

async function handleIssueComment(
  event: GitHubWebhookEvent,
  env: Env,
): Promise<void> {
  const issue = event.issue;
  const comment = event.comment;
  if (!issue || !comment) return;

  if (!issue.labels.some((l) => l.name === "telegram")) return;

  // Site aus Labels ermitteln
  const site = siteFromLabels(issue.labels);
  if (!site) return;

  // Skip our own bot's comments (matched against ALL SITES so that
  // sites sharing one GitHub App don't forward the bot's own
  // "please implement" instructions back to the user as if they were
  // a Claude reply).
  if (isOwnBotLogin(event.sender.login)) return;

  try {
    await reactToComment(env, comment.id, "eyes");
  } catch {
    // non-critical
  }

  if (event.sender.type !== "Bot" && !event.sender.login.includes("[bot]")) {
    return;
  }

  const chatId = extractChatId(issue.body);
  if (!chatId) {
    console.error(`No chatId found in issue #${issue.number}`);
    return;
  }

  let text = comment.body;
  if (text.length > 3500) {
    text = `${text.substring(0, 3500)}…\n\n_(Vollständiger Kommentar im Issue)_`;
  }

  const api = createApi(getTelegramToken(env, site));
  const threadId =
    (await getTopicId(env, site.id, chatId, issue.number)) ?? undefined;
  await sendMessage(
    api,
    chatId,
    `💬 Claude (Issue #${issue.number}):\n\n${text}`,
    buttons([
      [
        { text: "✅ Umsetzen", data: `execute:${issue.number}` },
        { text: "✏️ Antworten", data: `reply:${issue.number}` },
        { text: "❌ Abbrechen", data: `cancel:${issue.number}` },
      ],
    ]),
    threadId,
  );
}

async function handlePullRequestOpened(
  event: GitHubWebhookEvent,
  env: Env,
): Promise<void> {
  const pr = event.pull_request;
  if (!pr) return;

  let chatId = extractChatId(pr.body);
  let siteId = extractSiteId(pr.body);
  let issueTitle = "";
  let linkedIssueNum: number | null = null;
  let linkedLabels: { name: string }[] | undefined;

  if (pr.body) {
    const issueMatch = pr.body.match(/#(\d+)/);
    if (issueMatch) {
      linkedIssueNum = Number.parseInt(issueMatch[1], 10);
      try {
        const issue = await getIssue(env, linkedIssueNum);
        if (!chatId) chatId = extractChatId(issue.body);
        if (!siteId) siteId = extractSiteId(issue.body);
        issueTitle = issue.title;
        linkedLabels = issue.labels;
      } catch {
        // ignore
      }
    }
  }

  // PRs opened for a Telegram-issue are already announced by the
  // workflow callback with preview links — those are far more useful
  // for non-developer reviewers than a bare PR link, so we skip the
  // duplicate notification here.
  if (!shouldNotifyOnPrOpened(linkedLabels)) return;

  if (!chatId || !siteId) return;
  let site: SiteConfig;
  try {
    site = getSite(siteId);
  } catch {
    return;
  }

  const api = createApi(getTelegramToken(env, site));

  let threadId: number | undefined;
  if (linkedIssueNum) {
    threadId =
      (await getTopicId(env, site.id, chatId, linkedIssueNum)) ?? undefined;
    if (threadId) {
      await storePrTopicMapping(env, site.id, chatId, pr.number, threadId);
    }
  }

  const context = issueTitle
    ? `📦 Pull Request zu: ${issueTitle}\n\n${pr.title}\n${pr.html_url}`
    : `📦 Pull Request: ${pr.title}\n${pr.html_url}`;

  await sendMessage(
    api,
    chatId,
    context,
    buttons([
      [
        { text: "✅ Freigeben", data: `merge:${pr.number}` },
        { text: "❌ Verwerfen", data: `discard:${pr.number}` },
      ],
    ]),
    threadId,
  );
}

// ─── Action Callback Handler ───

async function handleActionCallback(
  payload: {
    issue_number: number;
    issue_title: string;
    pr_url?: string;
    pr_number?: number;
    preview_url?: string;
    deep_links?: string;
    error?: string;
  },
  api: Api,
  env: Env,
  site: SiteConfig,
): Promise<void> {
  const issue = await getIssue(env, payload.issue_number);
  const chatId = extractChatId(issue.body);
  if (!chatId) {
    // The issue has no chat_id marker — happens when someone created
    // the issue manually or the marker was lost in an edit. We do not
    // know who to send the preview to, so notify the admin instead of
    // dying silently.
    console.error(
      `handleActionCallback: no chatId in issue #${payload.issue_number}`,
    );
    try {
      await sendMessage(
        api,
        ADMIN_ID,
        `🔧 Workflow callback for #${payload.issue_number} „${payload.issue_title}" could not be delivered — no chat_id marker in the issue body. (${site.name})`,
      );
    } catch {
      /* nothing more we can do */
    }
    return;
  }

  const threadId =
    (await getTopicId(env, site.id, chatId, payload.issue_number)) ?? undefined;

  if (payload.error) {
    const errorMsg = [
      `❌ Fehler bei #${payload.issue_number} „${payload.issue_title}"`,
      "",
      payload.error,
      "",
      "If you cannot solve this yourself, forward this message to the admin.",
    ].join("\n");

    await sendMessage(api, chatId, errorMsg, undefined, threadId);

    if (chatId !== ADMIN_ID) {
      await sendMessage(
        api,
        ADMIN_ID,
        `🔧 Fehler bei #${payload.issue_number} „${payload.issue_title}" (${site.name}, User: ${chatId})\n\n${payload.error}`,
      );
    }
    return;
  }

  let text = `✅ Änderungen erstellt für: ${payload.issue_title}`;

  if (payload.preview_url && payload.deep_links?.trim()) {
    const links = payload.deep_links.trim().split(/\s+/);
    text += "\n\n👀 Vorschau:";
    for (const link of links) {
      text += `\n${payload.preview_url}${link}`;
    }
  } else if (payload.preview_url) {
    text += `\n\n👀 Vorschau: ${payload.preview_url}`;
  }

  if (payload.pr_number) {
    if (threadId) {
      await storePrTopicMapping(
        env,
        site.id,
        chatId,
        payload.pr_number,
        threadId,
      );
    }
    await sendMessage(
      api,
      chatId,
      text,
      buttons([
        [
          { text: "✅ Freigeben", data: `merge:${payload.pr_number}` },
          { text: "✏️ Ändern", data: `reply:${payload.issue_number}` },
          { text: "❌ Verwerfen", data: `discard:${payload.pr_number}` },
        ],
      ]),
      threadId,
    );
  } else {
    await sendMessage(api, chatId, text, undefined, threadId);
  }
}
