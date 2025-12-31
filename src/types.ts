import type { SayFn } from '@slack/bolt';
import type { Logger } from '@slack/logger';
import type { AppMentionEvent, GenericMessageEvent } from '@slack/types';
import type { WebClient } from '@slack/web-api';

export type SlackMessage = AppMentionEvent | GenericMessageEvent;

export type SlackHandlerContext = {
  message: SlackMessage;
  say: SayFn;
  client: WebClient;
  logger: Logger;
};
