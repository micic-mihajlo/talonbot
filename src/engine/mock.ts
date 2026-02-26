import type { AgentEngine, EngineInput, EngineOutput } from './types.js';

export class MockEngine implements AgentEngine {
  async complete(input: EngineInput, _signal?: AbortSignal): Promise<EngineOutput> {
    const trimmed = input.text.trim();
    if (!trimmed) {
      return { text: 'Received an empty message. Send a concrete request and I will start processing it.' };
    }

    return {
      text:
        `Session ${input.sessionKey}: I’ve got your request. ` +
        `You asked: "${trimmed.slice(0, 180)}". ` +
        'Routing to engineer workflow with persistent context enabled.',
    };
  }

  async ping() {
    return true;
  }
}
