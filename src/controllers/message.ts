import { Composer } from 'grammy';

import type { ThreadMessage } from '../types/database.js';
import type { DefaultContext } from '../types/context.js';
import { createThread, getThread, updateThread } from '../services/thread.js';
import {
  buildUserMessage,
  METADATA_FIELDS_REGEX,
  respond,
  TAG_SPECIAL_SEQUENCE,
  TAG_SPECIAL_SEQUENCE_ESCAPED,
} from '../services/response.js';

export const messageController = new Composer<DefaultContext>();
messageController.chatType(['group', 'supergroup']).on([':caption', ':text'], async ctx => {
  const senderId = ctx.from.id;
  const senderName = ctx.from.first_name;

  const text = (ctx.message.text ?? ctx.message.caption)
    .replaceAll(new RegExp(`${TAG_SPECIAL_SEQUENCE_ESCAPED}.+?${TAG_SPECIAL_SEQUENCE_ESCAPED}`, 'gi'), '')
    .replaceAll(TAG_SPECIAL_SEQUENCE, '')
    .replaceAll(METADATA_FIELDS_REGEX, '');

  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;

  const threadId = ctx.message.message_thread_id;
  let thread = !threadId ? null : await getThread({ db: ctx.db, chatId, threadId });

  const replyTo = ctx.message.reply_to_message?.from?.id ?? null;

  const shouldReply = thread || (replyTo ? replyTo === ctx.me.id : /^(?:l(?:a|e)(?:y|i)lo|ле(?:и|й)ло),.+/i.test(text));

  if (shouldReply) {
    await ctx.replyWithChatAction('typing');
    const response = await respond(thread?.messages ?? [], text, senderName);
    const responseMessage = await ctx.reply(response, {
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true,
      },
      message_thread_id: ctx.message.is_topic_message ? threadId : undefined,
    });
    const newMessages: ThreadMessage[] = [
      { role: 'user', fromId: senderId, content: buildUserMessage(text, senderName).content },
      { role: 'assistant', fromId: -1, content: response },
    ];
    if (responseMessage.message_thread_id) {
      if (!thread) {
        thread = await createThread({
          db: ctx.db,
          chatId,
          threadId: responseMessage.message_thread_id,
          // TODO: Single build place
          messages: newMessages,
        });
      }
      await updateThread({
        db: ctx.db,
        chatId,
        threadId: responseMessage.message_thread_id,
        messages: newMessages,
      });
    }
  }
});