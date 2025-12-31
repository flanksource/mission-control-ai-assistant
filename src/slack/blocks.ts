export function buildTextBlocks(text: string) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}

export function buildApprovalBlocks(text: string, payloadValue: string) {
  return [
    ...buildTextBlocks(text),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Approve',
          },
          style: 'primary',
          action_id: 'tool_approval_approve',
          value: payloadValue,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Deny',
          },
          style: 'danger',
          action_id: 'tool_approval_deny',
          value: payloadValue,
        },
      ],
    },
  ];
}

export function appendToolStatusToBlocks(blocks: unknown[] | undefined, status: string): unknown[] {
  const statusBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_${status}_`,
      },
    ],
  };

  if (!blocks || blocks.length === 0) {
    return buildTextBlocks(`_${status}_`);
  }

  const updatedBlocks = [...blocks];
  const lastBlock = updatedBlocks[updatedBlocks.length - 1] as { type?: string } | undefined;
  if (lastBlock?.type === 'actions') {
    updatedBlocks.splice(updatedBlocks.length - 1, 0, statusBlock);
    return updatedBlocks;
  }

  updatedBlocks.push(statusBlock);
  return updatedBlocks;
}
