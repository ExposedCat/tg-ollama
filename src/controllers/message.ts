import { Composer } from "grammy";
import { downloadFile } from "../services/download.js";
import {
	METADATA_FIELDS_REGEX,
	TAG_SPECIAL_SEQUENCE,
	TAG_SPECIAL_SEQUENCE_ESCAPED,
} from "../services/prompt.js";
import { buildUserMessage, respond } from "../services/response.js";
import { createThread, getThread, updateThread } from "../services/thread.js";
import type { DefaultContext } from "../types/context.js";
import type { ThreadMessage } from "../types/database.js";

export const messageController = new Composer<DefaultContext>();
messageController
	.chatType(["group", "supergroup"])
	.on([":caption", ":text"], async (ctx) => {
		const senderId = ctx.from.id;
		const senderName = ctx.from.first_name;

		const rawText = ctx.message.text ?? ctx.message.caption;
		const replyQuote = ctx.message.quote?.text
			? `> Quote: \`${ctx.message.quote?.text}\`\n`
			: "";
		const text = `${replyQuote}${rawText}`
			.replaceAll(
				new RegExp(
					`${TAG_SPECIAL_SEQUENCE_ESCAPED}.+?${TAG_SPECIAL_SEQUENCE_ESCAPED}`,
					"gi",
				),
				"",
			)
			.replaceAll(TAG_SPECIAL_SEQUENCE, "")
			.replaceAll(METADATA_FIELDS_REGEX, "");

		const chatId = ctx.chat.id;
		const messageId = ctx.message.message_id;

		const threadId = ctx.message.message_thread_id;
		let thread = !threadId
			? null
			: await getThread({ db: ctx.db, chatId, threadId });

		const replyTo = ctx.message.reply_to_message?.from?.id ?? null;
		const replyToUserName =
			ctx.message.reply_to_message?.from?.first_name ?? "Unknown Sender";
		const replyText =
			ctx.message.reply_to_message?.text ??
			ctx.message.reply_to_message?.caption ??
			"<unsupported message>";

		const previousMessages =
			thread || !replyTo
				? []
				: [
						{
							...buildUserMessage({
								message: replyText,
								senderName: replyToUserName,
								images: [], // TODO:
							}),
							fromId: replyTo,
						} as ThreadMessage,
					];

		const shouldReply =
			thread ||
			(replyTo && replyTo === ctx.me.id) ||
			/^(?:l(?:a|e)(?:y|i)lo|ле(?:и|й)ло),.+/i.test(rawText);

		if (shouldReply) {
			const images: string[] = [];
			if (ctx.message.photo) {
				await ctx.replyWithChatAction("upload_photo");
				const file = await ctx.getFile();
				if (file.file_path) {
					const image = await downloadFile(
						`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
					);
					images.push(image);
				}
			}

			await ctx.replyWithChatAction("typing");
			const { response, userMessage } = await respond({
				browser: ctx.browser,
				history: thread?.messages ?? previousMessages,
				message: text,
				senderName,
				images,
			});

			const safeRespond = async (formatting = true) => {
				try {
					return await ctx.reply(response, {
						reply_parameters: {
							message_id: messageId,
							allow_sending_without_reply: true,
						},
						parse_mode: formatting ? "Markdown" : undefined,
						message_thread_id: ctx.message.is_topic_message
							? threadId
							: undefined,
					});
				} catch (error) {
					if (formatting) {
						return safeRespond(false);
					}
					console.error("Failed to respond:", error);
					return null;
				}
			};

			const responseMessage = await safeRespond();
			if (!responseMessage) {
				return;
			}

			const newMessages: ThreadMessage[] = [
				...previousMessages,
				{
					role: "user",
					fromId: senderId,
					content: userMessage.content,
					images: userMessage.images as string[],
				},
				{ role: "assistant", fromId: -1, content: response },
			];
			if (responseMessage.message_thread_id) {
				if (!thread) {
					thread = await createThread({
						db: ctx.db,
						chatId,
						threadId: responseMessage.message_thread_id,
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
