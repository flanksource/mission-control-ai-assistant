import { LanguageModelV3 } from '@ai-sdk/provider';
import { generateId, generateText, stepCountIs, type ToolSet } from 'ai';
import { SlackHandlerContext } from '../types';
import { buildApprovalBlocks, buildTextBlocks } from './blocks';
import {
  collectToolApprovalRequests,
  encodeApprovalPayload,
  findLatestApprovalPayload,
  formatApprovalPrompt,
  handleApprovalDecision,
  parseApprovalDecision,
  systemPrompt,
} from './approvals';
import { buildMessagesFromSlack, dropTrailingUserMessage } from './messages';
import { collectToolCalls, logToolCalls, postWithToolStatus } from './tool_calls';

export async function respondWithLLM(
  { message, say, client, logger }: SlackHandlerContext,
  model: LanguageModelV3,
  tools?: ToolSet,
) {
  const text = message.text ?? '';
  const { channel, user } = message;
  const messageTs = message.ts;
  const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;
  const requestId = generateId();

  logger.info({ requestId, channel, user }, 'New message');

  await client.reactions.add({
    channel,
    name: 'eyes',
    timestamp: messageTs,
  });

  try {
    if (!text.trim()) {
      await say({
        text: 'Please send some text.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const botUserId = (await client.auth.test()).user_id;
    const decision = parseApprovalDecision(text);
    if (decision) {
      const payload = await findLatestApprovalPayload({ client, channel, threadTs });
      if (payload) {
        const messages = await buildMessagesFromSlack({
          client,
          channel,
          threadTs,
          botUserId,
        });
        const trimmedMessages = dropTrailingUserMessage(messages, text);
        await handleApprovalDecision({
          messages: trimmedMessages,
          approvals: payload.approvals,
          approved: decision.approved,
          reason: decision.reason,
          model,
          tools,
          logger,
          post: async ({ text: responseText, blocks }) =>
            (await say({
              text: responseText,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              ...(blocks ? { blocks } : {}),
            })) as { ts?: string; channel?: string } | undefined,
          update: async (response) => {
            await client.chat.update(response);
          },
          channel,
        });
        return;
      }
    }

    const messages = await buildMessagesFromSlack({
      client,
      channel,
      threadTs,
      currentText: text,
      botUserId,
    });

    const result = await generateText({
      model,
      messages,
      stopWhen: stepCountIs(20),
      system: systemPrompt,
      ...(tools ? { tools } : {}),
    });

    const responseMessages = result.response.messages ?? [];
    logToolCalls(responseMessages, logger);
    const toolCalls = collectToolCalls(responseMessages);

    const pendingApprovals = collectToolApprovalRequests(responseMessages);
    if (pendingApprovals.length > 0) {
      const prompt = formatApprovalPrompt(pendingApprovals);
      const replyText = result.text?.trim();
      const combinedText = replyText ? `${replyText}\n\n${prompt}` : prompt;
      const payloadValue = encodeApprovalPayload(pendingApprovals);
      await postWithToolStatus({
        post: async ({ text: responseText, blocks }) =>
          (await say({
            text: responseText,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            ...(blocks ? { blocks } : {}),
          })) as { ts?: string; channel?: string } | undefined,
        update: async (response) => {
          await client.chat.update(response);
        },
        channel,
        text: combinedText,
        blocks: buildApprovalBlocks(combinedText, payloadValue),
        toolCalls,
      });
      return;
    }

    await postWithToolStatus({
      post: async ({ text: responseText, blocks }) =>
        (await say({
          text: responseText,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks } : {}),
        })) as { ts?: string; channel?: string } | undefined,
      update: async (response) => {
        await client.chat.update(response);
      },
      channel,
      text: result.text ?? '',
      blocks: buildTextBlocks(result.text ?? ''),
      toolCalls,
    });
  } finally {
    await client.reactions.remove({
      channel,
      name: 'eyes',
      timestamp: messageTs,
    });
  }
}
