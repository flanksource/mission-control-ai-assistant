import { LanguageModelV3 } from '@ai-sdk/provider';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import { SlackHandlerContext } from '../types';
import { buildApprovalBlocks, buildTextBlocks, extractTextFromBlocks } from './blocks';
import {
  collectToolApprovalRequests,
  encodeApprovalPayload,
  formatApprovalPrompt,
  systemPrompt,
} from './approvals';
import { buildConversationFromSlackMsgs } from './messages';
import { collectToolCalls, logToolCalls, postWithToolStatus } from './tool_calls';

export async function respondWithLLM(
  { message, say, client, logger }: SlackHandlerContext,
  model: LanguageModelV3,
  tools?: ToolSet,
) {
  const blocks = 'blocks' in message ? (message.blocks ?? []) : [];
  const text = extractTextFromBlocks(blocks);
  const { channel } = message;
  const messageTs = message.ts;
  const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;

  try {
    if (!text.trim()) {
      await say({
        text: 'Please send some text.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const messages = await buildConversationFromSlackMsgs({
      client,
      channel,
      threadTs,
      currentBlocks: blocks,
      botUserId: (await client.auth.test()).user_id,
    });
    console.log({ messages });

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
