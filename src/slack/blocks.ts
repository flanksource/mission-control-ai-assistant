// TODO: add type definitions
//   import type { KnownBlock, RichTextBlock } from '@slack/types';

// Main types you can use:
// type KnownBlock = ActionsBlock | ContextBlock | ContextActionsBlock |
//   DividerBlock | FileBlock | HeaderBlock | ImageBlock | InputBlock |
//   MarkdownBlock | RichTextBlock | SectionBlock

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

export function mergeMessageText(blockText: string, baseText: string): string {
  if (blockText && baseText && blockText !== baseText) {
    if (blockText.includes(baseText)) {
      return blockText;
    }
    return `${blockText}\n\n${baseText}`;
  }

  return blockText || baseText;
}

export function extractTextFromBlocks(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    const typedBlock = block as { type?: string };
    switch (typedBlock.type) {
      case 'header': {
        const text = (block as { text?: { text?: string } }).text?.text;
        if (text) parts.push(text);
        break;
      }

      case 'section': {
        const section = block as {
          text?: { text?: string };
          fields?: Array<{ text?: string }>;
        };
        if (section.text?.text) parts.push(section.text.text);
        if (section.fields?.length) {
          for (const field of section.fields) {
            if (field?.text) parts.push(field.text);
          }
        }
        break;
      }

      case 'actions': {
        const actions = block as {
          elements?: Array<{
            type?: string;
            text?: { text?: string };
            url?: string;
          }>;
        };
        if (actions.elements?.length) {
          for (const element of actions.elements) {
            if (element?.text?.text && element?.url) {
              parts.push(`${element.text.text}: ${element.url}`);
            } else if (element?.text?.text) {
              parts.push(element.text.text);
            }
          }
        }
        break;
      }

      case 'rich_text': {
        const text = extractRichText((block as { elements?: unknown }).elements);
        if (text) parts.push(text);
        break;
      }

      default:
        break;
    }
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

function extractRichText(elements: unknown, botUserId?: string): string {
  if (!Array.isArray(elements)) return '';

  const parts: string[] = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const typedElement = element as { type?: string };
    switch (typedElement.type) {
      case 'rich_text_section': {
        const section = element as { elements?: unknown };
        const sectionText = extractRichText(section.elements, botUserId);
        if (sectionText) parts.push(sectionText);
        break;
      }
      case 'rich_text_list': {
        const list = element as { elements?: unknown };
        if (Array.isArray(list.elements)) {
          const items: string[] = [];
          for (const item of list.elements) {
            if (!item || typeof item !== 'object') continue;
            const itemText = extractRichText((item as { elements?: unknown }).elements, botUserId);
            if (itemText) items.push(`- ${itemText}`);
          }
          if (items.length > 0) parts.push(items.join('\n'));
        }
        break;
      }

      case 'text': {
        const text = (element as { text?: string }).text;
        if (text) parts.push(text);
        break;
      }

      case 'user': {
        // Skip the mentions
        break;
      }

      case 'link': {
        const link = element as { url?: string; text?: string };
        if (link.text && link.url) {
          parts.push(`${link.text}: ${link.url}`);
        } else if (link.url) {
          parts.push(link.url);
        }
        break;
      }

      case 'emoji': {
        const name = (element as { name?: string }).name;
        if (name) parts.push(`:${name}:`);
        break;
      }

      default:
        break;
    }
  }

  return parts.join('');
}
