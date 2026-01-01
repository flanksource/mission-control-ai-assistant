import { describe, it, expect } from 'bun:test';
import { extractTextFromBlocks } from './blocks';

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
