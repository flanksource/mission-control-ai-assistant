export function mergeMessageText(blockText: string, baseText: string): string {
  if (blockText && baseText && blockText !== baseText) {
    if (blockText.includes(baseText)) {
      return blockText;
    }
    return `${blockText}\n\n${baseText}`;
  }

  return blockText || baseText;
}

export function extractTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
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

function extractRichText(elements: unknown): string {
  if (!Array.isArray(elements)) return '';

  const parts: string[] = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const typedElement = element as { type?: string };
    switch (typedElement.type) {
      case 'rich_text_section': {
        const section = element as { elements?: unknown };
        const sectionText = extractRichText(section.elements);
        if (sectionText) parts.push(sectionText);
        break;
      }
      case 'text': {
        const text = (element as { text?: string }).text;
        if (text) parts.push(text);
        break;
      }
      case 'user': {
        const userId = (element as { user_id?: string }).user_id;
        if (userId) parts.push(`<@${userId}>`);
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
