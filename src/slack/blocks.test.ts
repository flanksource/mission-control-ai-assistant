import { describe, it, expect } from 'bun:test';
import {
  extractTextFromBlocks,
  buildApprovalBlocks,
} from './blocks';

describe('extractTextFromBlocks', () => {
  it('should extract text from rich_text blocks with bot mention', () => {
    const blocks = [
      {
        type: 'rich_text',
        block_id: '8WioH',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              {
                type: 'user',
                user_id: 'U0A68AR27J6',
              },
              {
                type: 'text',
                text: '1 + 1',
              },
            ],
          },
        ],
      },
    ];

    const result = extractTextFromBlocks(blocks);
    expect(result).toBe('1 + 1');
  });
});

describe('buildApprovalBlocks', () => {
  it('should build approval blocks with section and buttons', () => {
    const result = buildApprovalBlocks('Approve this?', 'payload123');
    expect(result.length).toBe(2);
    expect(result[0].type).toBe('section');
    expect(result[1].type).toBe('actions');

    const actions = result[1] as unknown as {
      elements: Array<{ text: { text: string }; style: string; action_id: string }>;
    };
    expect(actions.elements.length).toBe(2);
    expect(actions.elements[0].text.text).toBe('Approve');
    expect(actions.elements[0].style).toBe('primary');
    expect(actions.elements[1].text.text).toBe('Deny');
    expect(actions.elements[1].style).toBe('danger');
  });

  it('should truncate long text in section to 3000 chars with ellipsis', () => {
    const longText = 'a'.repeat(5000);
    const result = buildApprovalBlocks(longText, 'payload');
    const section = result[0] as { text: { text: string } };
    expect(section.text.text.length).toBe(3000);
    expect(section.text.text.endsWith('...')).toBe(true);
  });
});
