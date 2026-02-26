import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';

import { ControlPlane } from '../src/control/daemon.js';
import { routeFromMessage } from '../src/control/route.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig, InboundMessage, ControlRpcParsedCommand } from '../src/shared/protocol.js';
import type { EngineInput } from '../src/engine/types.js';

const createEngine = () => ({
  complete: async (input: EngineInput) => ({
    text: `engine:${input.text}`,
  }),
  ping: async () => true,
});

const mkInboundMessage = (text: string, id = `msg-${Math.random()}`): InboundMessage => ({
  id,
  source: 'socket',
  sourceChannelId: 'software-engineering',
  sourceMessageId: `source-${Math.random()}`,
  senderId: 'operator',
  senderName: 'operator',
  senderIsBot: false,
  text,
  mentionsBot: true,
  attachments: [],
  metadata: {},
  receivedAt: new Date().toISOString(),
});

const buildTestConfig = (dataDir: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: dataDir,
  CONTROL_SOCKET_PATH: path.join(dataDir, 'control.sock'),
  ENGINE_MODE: 'mock',
});

const createWorkingDirectory = async () => {
  const workingDirectory = path.join('/tmp', `tb-${Math.random().toString(36).slice(2, 7)}`);
  await rm(workingDirectory, { force: true, recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  return workingDirectory;
};

describe('control plane alias behavior', () => {
  let workingDirectory = '';
  let controlPlane: ControlPlane;

  beforeEach(async () => {
    workingDirectory = await createWorkingDirectory();
    controlPlane = new ControlPlane(buildTestConfig(workingDirectory), () => createEngine());
    await controlPlane.initialize();
  });

  afterEach(async () => {
    controlPlane?.stop();
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('sets, resolves, lists, and removes aliases', async () => {
    const setMessage = mkInboundMessage('!alias set runbook');
    const route = routeFromMessage(setMessage);

    const aliasSetReplies: string[] = [];
    await controlPlane.dispatch(setMessage, {
      reply: async (text) => {
        aliasSetReplies.push(text);
      },
    });
    expect(aliasSetReplies).toContain(`Alias "runbook" now points to ${route.sessionKey}.`);
    expect(controlPlane.resolveAlias('runbook')?.sessionKey).toBe(route.sessionKey);

    const aliasResolveReplies: string[] = [];
    await controlPlane.dispatch(mkInboundMessage('!alias resolve runbook'), {
      reply: async (text) => {
        aliasResolveReplies.push(text);
      },
    });
    expect(aliasResolveReplies).toContain(`runbook => ${route.sessionKey}`);

    const aliasListReplies: string[] = [];
    await controlPlane.dispatch(mkInboundMessage('!alias list'), {
      reply: async (text) => {
        aliasListReplies.push(text);
      },
    });
    expect(aliasListReplies).toContain(`Aliases: runbook=${route.sessionKey}`);

    const aliasRemoveReplies: string[] = [];
    await controlPlane.dispatch(mkInboundMessage('!alias remove runbook'), {
      reply: async (text) => {
        aliasRemoveReplies.push(text);
      },
    });
    expect(aliasRemoveReplies).toContain('Alias "runbook" removed.');
    expect(controlPlane.resolveAlias('runbook')).toBeNull();
  });

  it('dedupes repeated inbound event ids before enqueueing', async () => {
    const dedupeReplies: string[] = [];
    const duplicateMessage = mkInboundMessage('Same request', 'event-dup');

    await controlPlane.dispatch(duplicateMessage, {
      reply: async (text) => {
        dedupeReplies.push(text);
      },
    });

    await controlPlane.dispatch(
      {
        ...duplicateMessage,
      },
      {
        reply: async (text) => {
          dedupeReplies.push(text);
        },
      },
    );

    expect(dedupeReplies).toHaveLength(1);
  });
});

describe('control plane rpc behavior', () => {
  let workingDirectory = '';
  let controlPlane: ControlPlane;
  let sessionKey = '';

  beforeEach(async () => {
    workingDirectory = await createWorkingDirectory();
    controlPlane = new ControlPlane(buildTestConfig(workingDirectory), () => createEngine());
    await controlPlane.initialize();

    const seed = mkInboundMessage('!status');
    sessionKey = routeFromMessage(seed).sessionKey;
  });

  afterEach(async () => {
    controlPlane?.stop();
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('handles send/get_message/get_summary/clear/abort and rejects unknown rpc commands', async () => {
    const sendResult = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'send',
      message: 'How far along is project talon?',
      id: 'send-1',
    });
    expect(sendResult).toMatchObject({
      type: 'response',
      command: 'send',
      success: true,
      id: 'send-1',
      data: {
        delivered: true,
        mode: 'direct',
      },
    });

    const messageResult = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'get_message',
      id: 'get-message-1',
    });
    expect(messageResult).toMatchObject({
      type: 'response',
      command: 'get_message',
      success: true,
    });
    expect(messageResult.data).toMatchObject({
      message: {
        role: 'assistant',
        content: expect.stringContaining('engine:'),
      },
    });

    const summaryResult = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'get_summary',
      id: 'summary-1',
    });
    expect(summaryResult).toMatchObject({
      type: 'response',
      command: 'get_summary',
      success: true,
      data: {
        model: 'agent',
      },
    });
    expect(summaryResult.data).toMatchObject({ summary: expect.stringContaining('engine:') });

    const clearResult = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'clear',
      id: 'clear-1',
    });
    expect(clearResult).toMatchObject({
      type: 'response',
      command: 'clear',
      success: true,
      data: {
        cleared: true,
        targetId: 'root',
      },
    });

    const postClearGetMessage = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'get_message',
      id: 'post-clear-get-message',
    });
    expect(postClearGetMessage).toMatchObject({
      type: 'response',
      command: 'get_message',
      success: true,
      data: {
        message: null,
      },
    });

    const abortResult = await controlPlane.handleSessionRpcCommand(sessionKey, {
      type: 'abort',
      id: 'abort-1',
    });
    expect(abortResult).toMatchObject({
      type: 'response',
      command: 'abort',
      success: true,
      data: {
        aborted: false,
      },
    });

    const unknownResult = await controlPlane.handleSessionRpcCommand(
      sessionKey,
      { type: 'ping' as ControlRpcParsedCommand['type'], id: 'unknown' } as ControlRpcParsedCommand,
    );
    expect(unknownResult).toMatchObject({
      type: 'response',
      command: 'ping',
      success: false,
      error: 'Unsupported command: ping',
    });
  });
});
