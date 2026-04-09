import { Api, type InlineKeyboardButton } from "grammy/web";

/** Create a grammY API instance for the given bot token. */
export function createApi(token: string): Api {
  return new Api(token);
}

/** Convert basic Markdown to Telegram HTML. */
export function markdownToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

/** Build an inline keyboard from a 2D array of buttons. */
export function buttons(rows: { text: string; data: string }[][]): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((btn) => ({ text: btn.text, callback_data: btn.data })),
    ),
  };
}

/** Send a message, optionally inside a forum topic thread. */
export async function sendMessage(
  api: Api,
  chatId: number,
  text: string,
  replyMarkup?: ReturnType<typeof buttons> | { force_reply: true },
  messageThreadId?: number,
): Promise<void> {
  await api.sendMessage(chatId, markdownToHtml(text), {
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    message_thread_id: messageThreadId,
  });
}

/** Create a forum topic and return its thread id. */
export async function createForumTopic(
  api: Api,
  chatId: number,
  name: string,
): Promise<number> {
  const topic = await api.createForumTopic(chatId, name.substring(0, 128));
  return topic.message_thread_id;
}

/** Close a forum topic. */
export async function closeForumTopic(
  api: Api,
  chatId: number,
  messageThreadId: number,
): Promise<void> {
  await api.closeForumTopic(chatId, messageThreadId);
}

/** Rename a forum topic (only the creating bot can rename). */
export async function editForumTopicName(
  api: Api,
  chatId: number,
  messageThreadId: number,
  name: string,
): Promise<void> {
  await api.editForumTopic(chatId, messageThreadId, {
    name: name.substring(0, 128),
  });
}

/** Get a direct download URL for a Telegram file, embedding the token. */
export async function getFileUrl(
  api: Api,
  token: string,
  fileId: string,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Could not get file path");
  return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
}
